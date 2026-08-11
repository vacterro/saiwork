import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { MAX_QUEUED_ATTACHMENT_BYTES, type QueueState, type QueuedPrompt } from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"

/**
 * Single-owner prompt queue.
 *
 * The queue is server-authoritative so that the main window and every detached
 * session window share ONE queue instead of per-renderer copies that race each
 * other through localStorage. Every mutation carries `expectedRevision` and is
 * rejected with a structured conflict when the queue changed underneath the
 * caller, so a stale writer can never silently destroy newer changes.
 *
 * Dispatch safety falls out of ownership: an atomic CAS `dequeue` lets at most
 * one window win the head item, so "one queued prompt -> at most one dispatch"
 * holds even when two renderers see idle at the same instant.
 *
 * State is persisted atomically (temp + same-dir rename) and mutations are
 * serialized per key, mirroring the SAIPEN write discipline.
 */

export type QueueMutation =
  | { op: "enqueue"; text: string; attachments: unknown[] }
  | { op: "dequeue" }
  | { op: "restore"; item: QueuedPrompt; pause?: boolean }
  | { op: "move"; id: string; delta: number }
  | { op: "remove"; id: string }
  | { op: "update"; id: string; text: string; attachments?: unknown[] }
  | { op: "clear" }
  | { op: "set-paused"; paused: boolean }

export type QueueMutationResult =
  | { ok: true; state: QueueState; dequeued?: QueuedPrompt }
  | { ok: false; code: "conflict"; currentRevision: string }
  | { ok: false; code: "empty" }
  | { ok: false; code: "paused" }
  | { ok: false; code: "too-large" }

interface QueueManagerOptions {
  /** Where the persisted queue lives; null disables persistence (tests). */
  statePath: string | null
  eventBus: EventBus
  logger: Logger
}

const KEY_RE = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/
const PERSIST_VERSION = 1

interface PersistedQueue {
  version: number
  queues: Record<string, QueueState>
}

function emptyState(): QueueState {
  return { items: [], paused: false, revision: "" }
}

function revisionOf(items: QueuedPrompt[], paused: boolean): string {
  return createHash("sha256").update(JSON.stringify({ items, paused })).digest("hex")
}

function measureBytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function nextId(): string {
  return randomUUID()
}

export class QueueManager {
  private readonly queues = new Map<string, QueueState>()
  private readonly keyQueues = new Map<string, Promise<unknown>>()
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly logger: Logger

  constructor(private readonly options: QueueManagerOptions) {
    this.logger = options.logger
    if (options.statePath) this.load()
  }

  static isValidKey(key: string): boolean {
    return KEY_RE.test(key)
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

  async mutate(key: string, expectedRevision: string, mutation: QueueMutation): Promise<QueueMutationResult> {
    if (!QueueManager.isValidKey(key)) return { ok: false, code: "empty" }
    const result = await this.withKeyLock(key, () => this.apply(key, expectedRevision, mutation))
    if (result.ok) {
      await this.persist()
      this.options.eventBus.publish({ type: "queue.changed", key, state: result.state })
    }
    return result
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private apply(key: string, expectedRevision: string, mutation: QueueMutation): QueueMutationResult {
    const current = this.queues.get(key)
    const currentRevision = current?.revision ?? ""
    if (currentRevision !== expectedRevision) {
      return { ok: false, code: "conflict", currentRevision }
    }

    const items = [...(current?.items ?? [])]
    const paused = current?.paused ?? false

    if (mutation.op === "enqueue") {
      const trimmed = mutation.text.trim()
      if (!trimmed && (mutation.attachments?.length ?? 0) === 0) return { ok: false, code: "empty" }
      if (measureBytes(JSON.stringify(mutation.attachments ?? [])) > MAX_QUEUED_ATTACHMENT_BYTES) {
        return { ok: false, code: "too-large" }
      }
      const item: QueuedPrompt = {
        id: nextId(),
        text: trimmed,
        attachments: mutation.attachments ?? [],
        createdAt: Date.now(),
      }
      const state = { items: [...items, item], paused, revision: "" }
      state.revision = revisionOf(state.items, state.paused)
      this.queues.set(key, state)
      return { ok: true, state: cloneState(state) }
    }

    if (mutation.op === "dequeue") {
      if (paused) return { ok: false, code: "paused" }
      if (items.length === 0) return { ok: false, code: "empty" }
      const [head, ...rest] = items
      const state = { items: rest, paused, revision: "" }
      state.revision = revisionOf(state.items, state.paused)
      if (rest.length === 0 && !paused) {
        this.queues.delete(key)
      } else {
        this.queues.set(key, state)
      }
      return { ok: true, state: cloneState(state), dequeued: head }
    }

    if (mutation.op === "restore") {
      const item = mutation.item
      if (!item || typeof item.id !== "string") return { ok: false, code: "empty" }
      const restored: QueueState = {
        items: [item, ...items.filter((queued) => queued.id !== item.id)],
        paused: mutation.pause === true ? true : paused,
        revision: "",
      }
      restored.revision = revisionOf(restored.items, restored.paused)
      this.queues.set(key, restored)
      return { ok: true, state: cloneState(restored) }
    }

    if (mutation.op === "set-paused") {
      const next: QueueState = { items, paused: mutation.paused, revision: "" }
      next.revision = revisionOf(next.items, next.paused)
      if (next.items.length === 0 && !next.paused) this.queues.delete(key)
      else this.queues.set(key, next)
      return { ok: true, state: cloneState(next) }
    }

    if (mutation.op === "clear") {
      const next: QueueState = { items: [], paused, revision: "" }
      next.revision = revisionOf(next.items, next.paused)
      if (!paused) this.queues.delete(key)
      else this.queues.set(key, next)
      return { ok: true, state: cloneState(next) }
    }

    if (mutation.op === "move") {
      const index = items.findIndex((item) => item.id === mutation.id)
      if (index < 0) return { ok: false, code: "empty" }
      const target = Math.max(0, Math.min(items.length - 1, index + mutation.delta))
      if (target === index) {
        return { ok: true, state: cloneState(this.queues.get(key) ?? { items, paused, revision: currentRevision }) }
      }
      const [moved] = items.splice(index, 1)
      items.splice(target, 0, moved)
      const next: QueueState = { items, paused, revision: "" }
      next.revision = revisionOf(next.items, next.paused)
      this.queues.set(key, next)
      return { ok: true, state: cloneState(next) }
    }

    if (mutation.op === "remove") {
      const next: QueueState = { items: items.filter((item) => item.id !== mutation.id), paused, revision: "" }
      next.revision = revisionOf(next.items, next.paused)
      if (next.items.length === 0 && !paused) this.queues.delete(key)
      else this.queues.set(key, next)
      return { ok: true, state: cloneState(next) }
    }

    if (mutation.op === "update") {
      const trimmed = mutation.text.trim()
      const next: QueueState = {
        items: trimmed
          ? items.map((item) =>
              item.id === mutation.id
                ? { ...item, text: trimmed, ...(mutation.attachments !== undefined ? { attachments: mutation.attachments } : {}) }
                : item,
            )
          : items.filter((item) => item.id !== mutation.id),
        paused,
        revision: "",
      }
      next.revision = revisionOf(next.items, next.paused)
      if (next.items.length === 0 && !paused) this.queues.delete(key)
      else this.queues.set(key, next)
      return { ok: true, state: cloneState(next) }
    }

    return { ok: false, code: "empty" }
  }

  private withKeyLock<T>(key: string, operation: () => T): Promise<T> {
    const previous = (this.keyQueues.get(key) ?? Promise.resolve()) as Promise<unknown>
    const next = previous.then(operation, operation)
    this.keyQueues.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  private persist(): Promise<void> {
    const snapshot = () => {
      const queues: Record<string, QueueState> = {}
      for (const [key, state] of this.queues) queues[key] = state
      return queues
    }
    this.writeQueue = this.writeQueue.then(async () => {
      const statePath = this.options.statePath
      if (!statePath) return
      const payload: PersistedQueue = { version: PERSIST_VERSION, queues: snapshot() }
      const serialized = JSON.stringify(payload)
      const tempPath = `${statePath}.tmp`
      try {
        mkdirSync(path.dirname(statePath), { recursive: true })
        writeFileSync(tempPath, serialized, "utf8")
        renameSync(tempPath, statePath)
      } catch (error) {
        this.logger.warn({ error, statePath }, "Failed to persist prompt queue")
      }
    })
    return this.writeQueue
  }

  private load(): void {
    const statePath = this.options.statePath
    if (!statePath || !existsSync(statePath)) return
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PersistedQueue>
      if (parsed.version !== PERSIST_VERSION || !parsed.queues || typeof parsed.queues !== "object") return
      for (const [key, value] of Object.entries(parsed.queues)) {
        if (!QueueManager.isValidKey(key)) continue
        if (!value || !Array.isArray(value.items) || typeof value.paused !== "boolean") continue
        const items = value.items.filter((item) => item && typeof item.id === "string" && typeof item.text === "string")
        const state: QueueState = {
          items,
          paused: value.paused,
          revision: revisionOf(items, value.paused),
        }
        this.queues.set(key, state)
      }
    } catch (error) {
      // The queue is ephemeral user-visible state, not history: a corrupt file
      // must not brick every send path, so start empty and let the next write
      // replace it. Logged loudly enough to notice.
      this.logger.warn({ error, statePath }, "Prompt queue state unreadable; starting empty")
    }
  }
}

function cloneState(state: QueueState): QueueState {
  return { items: state.items.map((item) => ({ ...item, attachments: item.attachments })), paused: state.paused, revision: state.revision }
}
