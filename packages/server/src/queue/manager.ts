import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import {
  MAX_QUEUED_ATTACHMENT_BYTES,
  type QueueMutation,
  type QueueMutationResult,
  type QueueState,
  type QueueStorageFailure,
  type QueueStorageOperation,
  type QueuedAttachment,
  type QueuedPrompt,
} from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { isQueueState, isQueuedAttachment, isQueuedPrompt, queuedAttachmentBytes } from "./validation"

/**
 * Server-authoritative prompt queue shared by every renderer.
 *
 * All keys persist into one file, so one manager-wide transaction boundary
 * covers CAS, tentative state, atomic persistence, memory commit, and event
 * publication. Per-key locks are insufficient: concurrent keys would each
 * rewrite the same snapshot and could report state that never reached disk.
 */

export interface QueuePersistenceAdapter {
  exists(filePath: string): boolean
  read(filePath: string): string
  mkdir(directoryPath: string): void
  write(filePath: string, content: string): void
  rename(sourcePath: string, destinationPath: string): void
  remove(filePath: string): void
  syncDirectory(directoryPath: string): void
}

export interface QueueManagerOptions {
  /** Where the persisted queue lives; null disables persistence (tests). */
  statePath: string | null
  eventBus: EventBus
  logger: Logger
  /** Fault-injection seam for persistence tests. */
  persistence?: Partial<QueuePersistenceAdapter>
}

const KEY_RE = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/
const PERSIST_VERSION = 1

interface PersistedQueue {
  version: number
  queues: Record<string, QueueState>
}

type SuccessfulMutation = Extract<QueueMutationResult, { ok: true }>
type FailedMutation = Exclude<QueueMutationResult, { ok: true }>

export interface QueueFanOutEntry {
  key: string
  expectedRevision: string
  mutation: QueueMutation
}

export type QueueFanOutMutationResult =
  | { ok: true; states: Array<{ key: string; state: QueueState }> }
  | FailedMutation

type TentativeMutation =
  | { result: SuccessfulMutation; keep: boolean }
  | { result: FailedMutation }

const DEFAULT_PERSISTENCE: QueuePersistenceAdapter = {
  exists: existsSync,
  read: (filePath) => readFileSync(filePath, "utf8"),
  mkdir: (directoryPath) => mkdirSync(directoryPath, { recursive: true }),
  write: (filePath, content) => {
    const descriptor = openSync(filePath, "w")
    try {
      writeFileSync(descriptor, content, "utf8")
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  },
  rename: renameSync,
  remove: (filePath) => rmSync(filePath, { force: true }),
  syncDirectory: (directoryPath) => {
    if (process.platform === "win32") return
    const descriptor = openSync(directoryPath, "r")
    try {
      try {
        fsyncSync(descriptor)
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
        if (["EINVAL", "ENOTSUP"].includes(code)) return
        throw error
      }
    } finally {
      closeSync(descriptor)
    }
  },
}

function revisionOf(items: QueuedPrompt[], paused: boolean): string {
  return createHash("sha256").update(JSON.stringify({ items, paused })).digest("hex")
}

function nextId(): string {
  return randomUUID()
}

function storageFailure(operation: QueueStorageOperation): QueueStorageFailure {
  const action = operation === "load" ? "load" : operation === "mkdir" ? "prepare" : operation
  return { operation, message: `Failed to ${action} prompt queue persistence` }
}

function storageResult(error: QueueStorageFailure): QueueMutationResult {
  return { ok: false, code: "storage", error }
}

function checkAttachments(attachments: unknown[]):
  | { ok: true; attachments: QueuedAttachment[] }
  | { ok: false; code: "too-large" | "invalid" } {
  const bytes = queuedAttachmentBytes(attachments)
  if (bytes === null) return { ok: false, code: "invalid" }
  if (bytes > MAX_QUEUED_ATTACHMENT_BYTES) return { ok: false, code: "too-large" }
  let normalized: unknown
  try {
    normalized = JSON.parse(JSON.stringify(attachments))
  } catch {
    return { ok: false, code: "invalid" }
  }
  if (!Array.isArray(normalized) || !normalized.every(isQueuedAttachment)) return { ok: false, code: "invalid" }
  return { ok: true, attachments: normalized }
}

export class QueueManager {
  private queues = new Map<string, QueueState>()
  private transactionQueue: Promise<void> = Promise.resolve()
  private readonly storage: QueuePersistenceAdapter
  private loadFailure: QueueStorageFailure | null = null

  constructor(private readonly options: QueueManagerOptions) {
    const injected = options.persistence
    this.storage = {
      exists: injected?.exists ?? DEFAULT_PERSISTENCE.exists,
      read: injected?.read ?? DEFAULT_PERSISTENCE.read,
      mkdir: injected?.mkdir ?? DEFAULT_PERSISTENCE.mkdir,
      write: injected?.write ?? DEFAULT_PERSISTENCE.write,
      rename: injected?.rename ?? DEFAULT_PERSISTENCE.rename,
      remove: injected?.remove ?? DEFAULT_PERSISTENCE.remove,
      syncDirectory: injected?.syncDirectory ?? DEFAULT_PERSISTENCE.syncDirectory,
    }
    if (options.statePath) this.load()
  }

  static isValidKey(key: string): boolean {
    return KEY_RE.test(key)
  }

  getStorageFailure(): QueueStorageFailure | null {
    return this.loadFailure ? { ...this.loadFailure } : null
  }

  getAll(): Record<string, QueueState> {
    const result: Record<string, QueueState> = {}
    for (const [key, state] of this.queues) result[key] = cloneState(state)
    return result
  }

  get(key: string): QueueState | null {
    const state = this.queues.get(key)
    return state ? cloneState(state) : null
  }

  mutate(key: string, expectedRevision: string, mutation: QueueMutation): Promise<QueueMutationResult> {
    if (!QueueManager.isValidKey(key)) return Promise.resolve({ ok: false, code: "invalid" })
    return this.withTransaction(() => this.transact(key, expectedRevision, mutation))
  }

  /**
   * Atomic multi-key mutation (fan-out): validate EVERY entry, build every
   * tentative state, persist ONE complete queue snapshot, and only then commit
   * memory and publish. Any validation/CAS/persistence failure commits NOTHING,
   * so a "failed" fan-out can never leave half its prompts queued and
   * dispatching.
   */
  mutateMany(entries: QueueFanOutEntry[]): Promise<QueueFanOutMutationResult> {
    return this.withTransaction<QueueFanOutMutationResult>(() => {
      if (this.loadFailure) return storageResult(this.loadFailure) as FailedMutation

      const applied: Array<{ key: string; tentative: TentativeMutation }> = []
      for (const entry of entries) {
        if (!QueueManager.isValidKey(entry.key)) return { ok: false, code: "invalid" }
        const tentative = this.apply(entry.key, entry.expectedRevision, entry.mutation)
        if (!("keep" in tentative)) return tentative.result
        applied.push({ key: entry.key, tentative })
      }

      const updates = new Map<string, { state: QueueState; keep: boolean }>()
      for (const item of applied) {
        if (!("keep" in item.tentative)) continue
        updates.set(item.key, { state: item.tentative.result.state, keep: item.tentative.keep })
      }

      const persistenceFailure = this.persistSnapshot(updates)
      if (persistenceFailure) return storageResult(persistenceFailure) as FailedMutation

      const states: Array<{ key: string; state: QueueState }> = []
      for (const [key, update] of updates) {
        const committed = update.keep ? cloneState(update.state) : emptyState()
        if (update.keep) this.queues.set(key, committed)
        else this.queues.delete(key)
        states.push({ key, state: cloneState(committed) })
      }
      for (const [key, update] of updates) {
        try {
          this.options.eventBus.publish({
            type: "queue.changed",
            key,
            state: update.keep ? cloneState(update.state) : emptyState(),
          })
        } catch (error) {
          this.options.logger.warn({ error, key }, "Failed to publish prompt queue change")
        }
      }
      return { ok: true, states }
    })
  }

  async flush(): Promise<void> {
    await this.transactionQueue
  }

  private transact(key: string, expectedRevision: string, mutation: QueueMutation): QueueMutationResult {
    if (this.loadFailure) return storageResult(this.loadFailure)

    const tentative = this.apply(key, expectedRevision, mutation)
    if (!("keep" in tentative)) return tentative.result

    const persistenceFailure = this.persist(key, tentative.result.state, tentative.keep)
    if (persistenceFailure) return storageResult(persistenceFailure)

    const committedState = tentative.keep
      ? cloneState(tentative.result.state)
      : { items: [], paused: false, revision: "" }
    if (tentative.keep) this.queues.set(key, committedState)
    else this.queues.delete(key)

    try {
      this.options.eventBus.publish({ type: "queue.changed", key, state: cloneState(committedState) })
    } catch (error) {
      this.options.logger.warn({ error, key }, "Failed to publish persisted prompt queue change")
    }
    return {
      ...tentative.result,
      state: cloneState(committedState),
    }
  }

  private apply(key: string, expectedRevision: string, mutation: QueueMutation): TentativeMutation {
    const current = this.queues.get(key)
    const currentRevision = current?.revision ?? ""
    if (currentRevision !== expectedRevision) {
      return { result: { ok: false, code: "conflict", currentRevision, error: "queue changed; refresh and retry" } }
    }

    const items = [...(current?.items ?? [])]
    const paused = current?.paused ?? false

    if (mutation.op === "enqueue") {
      const trimmed = mutation.text.trim()
      const rawAttachments = mutation.attachments ?? []
      if (!trimmed && rawAttachments.length === 0) return { result: { ok: false, code: "empty" } }
      const checked = checkAttachments(rawAttachments)
      if (!checked.ok) return { result: { ok: false, code: checked.code } }
      const item: QueuedPrompt = {
        id: nextId(),
        text: trimmed,
        attachments: checked.attachments,
        createdAt: Date.now(),
      }
      const state = stateWithRevision([...items, item], paused)
      return { result: { ok: true, state: cloneState(state) }, keep: true }
    }

    if (mutation.op === "import-legacy") {
      const imported = mutation.item
      if (!isQueuedPrompt(imported)) return { result: { ok: false, code: "invalid" } }
      const duplicate = items.find((item) => item.id === imported.id)
      if (duplicate) {
        if (JSON.stringify(duplicate) !== JSON.stringify(imported)) {
          return { result: { ok: false, code: "invalid" } }
        }
        const state = stateWithRevision(items, paused)
        return { result: { ok: true, state: cloneState(state) }, keep: true }
      }
      const state = stateWithRevision([...items, clonePrompt(imported)], paused)
      return { result: { ok: true, state: cloneState(state) }, keep: true }
    }

    if (mutation.op === "restore") {
      const restored = mutation.item
      if (!isQueuedPrompt(restored)) return { result: { ok: false, code: "invalid" } }
      const duplicate = items.find((item) => item.id === restored.id)
      if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(restored)) {
        return { result: { ok: false, code: "invalid" } }
      }
      const state = stateWithRevision(
        [clonePrompt(restored), ...items.filter((item) => item.id !== restored.id)],
        mutation.pause === true || paused,
      )
      return { result: { ok: true, state: cloneState(state) }, keep: true }
    }

    if (mutation.op === "dequeue") {
      if (paused) return { result: { ok: false, code: "paused" } }
      if (items.length === 0) return { result: { ok: false, code: "empty" } }
      const [head, ...rest] = items
      const state = stateWithRevision(rest, paused)
      return { result: { ok: true, state: cloneState(state), dequeued: clonePrompt(head) }, keep: rest.length > 0 }
    }

    if (mutation.op === "set-paused") {
      const state = stateWithRevision(items, mutation.paused)
      return { result: { ok: true, state: cloneState(state) }, keep: state.items.length > 0 || state.paused }
    }

    if (mutation.op === "clear") {
      const state = stateWithRevision([], paused)
      return { result: { ok: true, state: cloneState(state) }, keep: paused }
    }

    if (mutation.op === "move") {
      const index = items.findIndex((item) => item.id === mutation.id)
      if (index < 0) return { result: { ok: false, code: "empty" } }
      const target = Math.max(0, Math.min(items.length - 1, index + mutation.delta))
      if (target !== index) {
        const [moved] = items.splice(index, 1)
        items.splice(target, 0, moved)
      }
      const state = stateWithRevision(items, paused)
      return { result: { ok: true, state: cloneState(state) }, keep: true }
    }

    if (mutation.op === "remove") {
      const state = stateWithRevision(items.filter((item) => item.id !== mutation.id), paused)
      return { result: { ok: true, state: cloneState(state) }, keep: state.items.length > 0 || paused }
    }

    if (mutation.op === "update") {
      const trimmed = mutation.text.trim()
      let attachments: QueuedAttachment[] | undefined
      if (trimmed && mutation.attachments !== undefined) {
        const checked = checkAttachments(mutation.attachments)
        if (!checked.ok) return { result: { ok: false, code: checked.code } }
        attachments = checked.attachments
      }
      const updated = trimmed
        ? items.map((item) => item.id === mutation.id
          ? { ...item, text: trimmed, ...(attachments ? { attachments } : {}) }
          : item)
        : items.filter((item) => item.id !== mutation.id)
      const state = stateWithRevision(updated, paused)
      return { result: { ok: true, state: cloneState(state) }, keep: state.items.length > 0 || paused }
    }

    return { result: { ok: false, code: "invalid" } }
  }

  private withTransaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.transactionQueue.then(operation, operation)
    this.transactionQueue = next.then(() => undefined, () => undefined)
    return next
  }

  private persist(key: string, state: QueueState, keep: boolean): QueueStorageFailure | null {
    return this.persistSnapshot(new Map([[key, { state, keep }]]))
  }

  private persistSnapshot(updates: Map<string, { state: QueueState; keep: boolean }>): QueueStorageFailure | null {
    const statePath = this.options.statePath
    if (!statePath) return null

    const queues: Record<string, QueueState> = {}
    for (const [queuedKey, queuedState] of this.queues) queues[queuedKey] = queuedState
    for (const [key, update] of updates) {
      if (update.keep) queues[key] = update.state
      else delete queues[key]
    }

    const payload: PersistedQueue = { version: PERSIST_VERSION, queues }
    const tempPath = `${statePath}.tmp`
    let previousContent: string | null = null
    try {
      previousContent = this.storage.exists(statePath) ? this.storage.read(statePath) : null
    } catch (error) {
      return this.reportPersistenceFailure("load", error, statePath)
    }
    try {
      this.storage.mkdir(path.dirname(statePath))
    } catch (error) {
      return this.reportPersistenceFailure("mkdir", error, statePath)
    }
    try {
      this.storage.write(tempPath, JSON.stringify(payload))
    } catch (error) {
      this.removeTemp(tempPath)
      return this.reportPersistenceFailure("write", error, statePath)
    }
    try {
      this.storage.rename(tempPath, statePath)
    } catch (error) {
      this.removeTemp(tempPath)
      return this.reportPersistenceFailure("rename", error, statePath)
    }
    try {
      this.storage.syncDirectory(path.dirname(statePath))
    } catch (error) {
      this.rollbackPersistedState(statePath, previousContent)
      return this.reportPersistenceFailure("fsync", error, statePath)
    }
    return null
  }

  private rollbackPersistedState(statePath: string, previousContent: string | null): void {
    const rollbackPath = `${statePath}.rollback`
    try {
      if (previousContent === null) {
        this.storage.remove(statePath)
      } else {
        this.storage.write(rollbackPath, previousContent)
        this.storage.rename(rollbackPath, statePath)
      }
      this.storage.syncDirectory(path.dirname(statePath))
    } catch (error) {
      this.loadFailure = storageFailure("fsync")
      this.options.logger.error({ error, statePath }, "Failed to roll back prompt queue after directory fsync failure")
    } finally {
      this.removeTemp(rollbackPath)
    }
  }

  private reportPersistenceFailure(operation: QueueStorageOperation, error: unknown, statePath: string): QueueStorageFailure {
    this.options.logger.warn({ error, operation, statePath }, "Failed to persist prompt queue")
    return storageFailure(operation)
  }

  private removeTemp(tempPath: string): void {
    try {
      this.storage.remove(tempPath)
    } catch {
      // Original file remains authoritative; stale temp cleanup is best effort.
    }
  }

  private load(): void {
    const statePath = this.options.statePath
    if (!statePath) return
    try {
      if (!this.storage.exists(statePath)) return
      const parsed: unknown = JSON.parse(this.storage.read(statePath))
      const loaded = parsePersistedQueue(parsed)
      if (!loaded) throw new Error("Unsupported or corrupt prompt queue persistence")
      this.queues = loaded
    } catch (error) {
      this.loadFailure = storageFailure("load")
      this.options.logger.warn({ error, statePath }, "Prompt queue persistence unavailable; mutations disabled")
    }
  }
}

function stateWithRevision(items: QueuedPrompt[], paused: boolean): QueueState {
  return { items, paused, revision: revisionOf(items, paused) }
}

function emptyState(): QueueState {
  return { items: [], paused: false, revision: "" }
}

function clonePrompt(item: QueuedPrompt): QueuedPrompt {
  return { ...item, attachments: structuredClone(item.attachments) }
}

function cloneState(state: QueueState): QueueState {
  return { items: state.items.map(clonePrompt), paused: state.paused, revision: state.revision }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parsePersistedQueue(value: unknown): Map<string, QueueState> | null {
  if (!isRecord(value) || value.version !== PERSIST_VERSION || !isRecord(value.queues)) return null

  const loaded = new Map<string, QueueState>()
  for (const [key, rawState] of Object.entries(value.queues)) {
    if (!QueueManager.isValidKey(key) || !isQueueState(rawState)) return null
    const ids = new Set(rawState.items.map((item) => item.id))
    if (ids.size !== rawState.items.length) return null
    const state = stateWithRevision(structuredClone(rawState.items), rawState.paused)
    if (rawState.revision !== state.revision) return null
    if (state.items.length > 0 || state.paused) loaded.set(key, state)
  }
  return loaded
}
