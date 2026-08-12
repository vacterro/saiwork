import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import {
  MAX_QUEUED_ATTACHMENT_BYTES,
  type QueueFanOutResult,
  type QueueMutation as ServerQueueMutation,
  type QueueStorageFailure,
  type QueuedPrompt as ServerQueuedPrompt,
  type QueueState as ServerQueueState,
  type WorkspaceEventPayload,
} from "../../../server/src/api-types"
import { isQueuedPrompt, queuedAttachmentBytes } from "../../../server/src/queue/validation"
import type { Attachment } from "../types/attachment"
import { createAttachmentPlaceholderRegex, getAttachmentPlaceholder } from "../lib/attachment-placeholders"

const log = getLogger("actions")
const LEGACY_STORAGE_KEY = "saiwork.prompt-queue.v1"

/**
 * Prompt queue -- server-authoritative mirror.
 *
 * The queue lives on the SAIWORK server, not in this renderer, because the main
 * window and every detached session window must share ONE queue. Per-renderer
 * copies (the old localStorage model) could lose items, resurrect them, or let
 * two windows dispatch the same prompt. Every mutation carries the queue's
 * `expectedRevision`; the server rejects stale writes with a 409 and this store
 * re-syncs from the authoritative state.
 *
 * This module is a local MIRROR: `queue.changed` SSE events and the initial
 * fetch fill the signal, reads are synchronous, and mutations go through the
 * transport. A renderer is a viewer + requester, never an owner.
 */

export interface QueuedPrompt {
  id: string
  text: string
  attachments: Attachment[]
  createdAt: number
}

export interface PromptQueueTarget {
  instanceId: string
  sessionId: string
}

export type EnqueueFailure = "empty" | "too-large" | "conflict" | "storage"

export type EnqueueResult = { ok: true; item: QueuedPrompt } | { ok: false; reason: EnqueueFailure }

export type FanOutResult = { ok: true; items: QueuedPrompt[] } | { ok: false; reason: EnqueueFailure }

export type QueueMutateOutcome =
  | { status: "ok"; state: ServerQueueState; dequeued?: ServerQueuedPrompt }
  | { status: "conflict"; currentRevision: string }
  | { status: "failed"; code: "empty" | "paused" | "too-large" | "invalid" }
  | { status: "failed"; code: "storage"; error: QueueStorageFailure }

export interface QueueTransport {
  list(): Promise<Record<string, ServerQueueState>>
  mutate(key: string, expectedRevision: string, mutation: ServerQueueMutation): Promise<QueueMutateOutcome>
  mutateMany(
    targets: Array<{ key: string; expectedRevision: string }>,
    text: string,
    attachments: unknown[],
  ): Promise<QueueFanOutResult>
  onChange(handler: (event: Extract<WorkspaceEventPayload, { type: "queue.changed" }>) => void): () => void
  onOpen(handler: () => void): () => void
}

const defaultTransport: QueueTransport = {
  list: async () => (await serverApi.fetchQueues()).queues,
  mutate: (key, expectedRevision, mutation) => serverApi.mutateQueue(key, expectedRevision, mutation),
  mutateMany: (targets, text, attachments) => serverApi.queueFanOut(targets, text, attachments),
  onChange: (handler) =>
    serverEvents.on("queue.changed", (event) => {
      if (event.type === "queue.changed") handler(event)
    }),
  onOpen: (handler) => serverEvents.onOpen(handler),
}

let transport: QueueTransport = defaultTransport

let stopChange: (() => void) | null = null
let stopOpen: (() => void) | null = null

function wireTransport(): void {
  latestRefreshRequest += 1
  stopChange?.()
  stopOpen?.()
  stopChange = transport.onChange((event) => {
    if (event.type !== "queue.changed") return
    applyState(event.key, event.state)
  })
  stopOpen = transport.onOpen(() => {
    void refreshAllQueues()
  })
}

/** Test seam: swaps the transport without touching the module singleton. */
export function __setQueueTransport(replacement: QueueTransport): void {
  transport = replacement
  wireTransport()
  void refreshAllQueues()
}

export function __resetQueueTransport(): void {
  transport = defaultTransport
  wireTransport()
  void refreshAllQueues()
}

function queueKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function measureAttachmentBytes(attachments: Attachment[]): number {
  return queuedAttachmentBytes(attachments) ?? Number.POSITIVE_INFINITY
}

/** The mirror stores server-shaped items; the panel wants typed attachments. */
function toTyped(items: ServerQueuedPrompt[]): QueuedPrompt[] {
  return items.map((item) => ({ ...item, attachments: item.attachments }))
}

const EMPTY: QueuedPrompt[] = []

const [queues, setQueues] = createSignal<Map<string, ServerQueueState>>(new Map())
const stateVersions = new Map<string, number>()
let mirrorVersion = 0
let latestRefreshRequest = 0
let legacyMigration: Promise<boolean> | null = null

function withLegacyMigrationLock(operation: () => Promise<boolean>): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.locks) return operation()
  return new Promise<boolean>((resolve, reject) => {
    void navigator.locks.request("saiwork.prompt-queue.migration", async () => {
      try {
        resolve(await operation())
      } catch (error) {
        reject(error)
      }
    }).catch(reject)
  })
}

function applyState(key: string, state: ServerQueueState): void {
  stateVersions.set(key, ++mirrorVersion)
  setQueues((prev) => {
    const next = new Map(prev)
    if (state.items.length === 0 && !state.paused) {
      next.delete(key)
    } else {
      next.set(key, state)
    }
    return next
  })
}

async function refreshAllQueues(): Promise<void> {
  const request = ++latestRefreshRequest
  const startedAtVersion = mirrorVersion
  const requestTransport = transport
  try {
    const all = await requestTransport.list()
    if (request !== latestRefreshRequest || requestTransport !== transport) return
    setQueues((prev) => {
      const next = new Map(prev)
      const fetchedKeys = new Set(Object.keys(all))
      for (const [key, state] of Object.entries(all)) {
        if ((stateVersions.get(key) ?? 0) > startedAtVersion) continue
        if (state.items.length === 0 && !state.paused) next.delete(key)
        else next.set(key, state)
        stateVersions.set(key, ++mirrorVersion)
      }
      for (const key of prev.keys()) {
        if (!fetchedKeys.has(key) && (stateVersions.get(key) ?? 0) <= startedAtVersion) {
          next.delete(key)
          stateVersions.set(key, ++mirrorVersion)
        }
      }
      return next
    })
    void migrateLegacyQueueStorage()
  } catch (error) {
    log.warn("Failed to load prompt queue:", error)
  }
}

wireTransport()

// Initial load for a renderer that connected before the first SSE batch.
void refreshAllQueues()

export function getQueue(instanceId: string, sessionId: string): QueuedPrompt[] {
  const state = queues().get(queueKey(instanceId, sessionId))
  return state && state.items.length > 0 ? toTyped(state.items) : EMPTY
}

export function getQueueLength(instanceId: string, sessionId: string): number {
  return getQueue(instanceId, sessionId).length
}

export function isQueuePaused(instanceId: string, sessionId: string): boolean {
  return queues().get(queueKey(instanceId, sessionId))?.paused ?? false
}

/** Total pending prompts across every session of one instance. */
export function getInstanceQueueLength(instanceId: string): number {
  let total = 0
  const prefix = `${instanceId}:`
  for (const [key, state] of queues().entries()) {
    if (key.startsWith(prefix)) total += state.items.length
  }
  return total
}

async function mutateQueueState(
  instanceId: string,
  sessionId: string,
  mutation: ServerQueueMutation,
): Promise<QueueMutateOutcome> {
  const key = queueKey(instanceId, sessionId)
  const revision = queues().get(key)?.revision ?? ""
  const startedAtVersion = mirrorVersion
  const outcome = await transport.mutate(key, revision, mutation)
  if (outcome.status === "ok") {
    if ((stateVersions.get(key) ?? 0) <= startedAtVersion) applyState(key, outcome.state)
  } else if (outcome.status === "conflict") {
    // Another window moved the queue first. Mirror the truth instead of
    // guessing: the next read shows the authoritative state.
    await refreshAllQueues()
  }
  return outcome
}

export async function enqueuePrompt(
  instanceId: string,
  sessionId: string,
  text: string,
  attachments: Attachment[] = [],
): Promise<EnqueueResult> {
  const trimmed = text.trim()
  if (!trimmed && attachments.length === 0) return { ok: false, reason: "empty" }
  if (measureAttachmentBytes(attachments) > MAX_QUEUED_ATTACHMENT_BYTES) {
    return { ok: false, reason: "too-large" }
  }

  const outcome = await mutateQueueState(instanceId, sessionId, { op: "enqueue", text: trimmed, attachments })
  if (outcome.status === "ok") {
    const item = outcome.state.items[outcome.state.items.length - 1]
    if (!item) return { ok: false, reason: "conflict" }
    return { ok: true, item: toTyped([item])[0]! }
  }
  if (outcome.status === "conflict") return { ok: false, reason: "conflict" }
  if (outcome.code === "too-large") return { ok: false, reason: "too-large" }
  if (outcome.code === "storage") return { ok: false, reason: "storage" }
  return { ok: false, reason: "empty" }
}

/**
 * Adds one prompt per target in a SINGLE server-side transaction: every target
 * commits or none do. A failed fan-out therefore can never leave prompts
 * queued behind a generic error (the old loop compensated with removes whose
 * results were ignored).
 */
export async function enqueuePromptFanOut(
  targets: PromptQueueTarget[],
  text: string,
  attachments: Attachment[] = [],
): Promise<FanOutResult> {
  const trimmed = text.trim()
  if ((!trimmed && attachments.length === 0) || targets.length === 0) return { ok: false, reason: "empty" }
  if (measureAttachmentBytes(attachments) > MAX_QUEUED_ATTACHMENT_BYTES) {
    return { ok: false, reason: "too-large" }
  }

  const unique = Array.from(
    new Map(targets.map((target) => [queueKey(target.instanceId, target.sessionId), target])).values(),
  )
  const outcome = await transport.mutateMany(
    unique.map((target) => ({
      key: queueKey(target.instanceId, target.sessionId),
      expectedRevision: queues().get(queueKey(target.instanceId, target.sessionId))?.revision ?? "",
    })),
    trimmed,
    attachments,
  )
  if (outcome.ok) return { ok: true, items: outcome.items }
  return {
    ok: false,
    reason: outcome.code === "conflict"
      ? "conflict"
      : outcome.code === "storage"
        ? "storage"
        : outcome.code === "too-large"
          ? "too-large"
          : "empty",
  }
}

/** Removes and returns the head. Returns null when paused, empty or lost the race. */
export async function dequeuePrompt(instanceId: string, sessionId: string): Promise<QueuedPrompt | null> {
  const outcome = await mutateQueueState(instanceId, sessionId, { op: "dequeue" })
  if (outcome.status !== "ok" || !outcome.dequeued) return null
  return toTyped([outcome.dequeued])[0]!
}

export function removeQueuedPrompt(instanceId: string, sessionId: string, id: string): Promise<void> {
  return mutateQueueState(instanceId, sessionId, { op: "remove", id }).then(() => undefined)
}

export async function updateQueuedPrompt(instanceId: string, sessionId: string, id: string, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) {
    await mutateQueueState(instanceId, sessionId, { op: "remove", id })
    return
  }
  // A pasted attachment whose placeholder the edit no longer references is
  // consumed by the edit. Computed here (UI presentation logic) and handed to
  // the server verbatim as the replacement attachment list.
  const item = getQueue(instanceId, sessionId).find((queued) => queued.id === id)
  const consumedPastedAttachmentIds = new Set(
    item?.attachments.flatMap((attachment) => {
      if (attachment.source.type !== "text") return []
      const placeholder = getAttachmentPlaceholder(attachment.display)
      if (placeholder?.kind !== "pasted") return []
      const wasReferenced = createAttachmentPlaceholderRegex("pasted", placeholder.counter, { global: false }).test(item.text)
      const remainsReferenced = createAttachmentPlaceholderRegex("pasted", placeholder.counter, { global: false }).test(trimmed)
      return wasReferenced && !remainsReferenced ? [attachment.id] : []
    }) ?? [],
  )
  const attachments = consumedPastedAttachmentIds.size > 0
    ? item?.attachments.filter((attachment) => !consumedPastedAttachmentIds.has(attachment.id)) ?? undefined
    : undefined
  await mutateQueueState(instanceId, sessionId, {
    op: "update",
    id,
    text: trimmed,
    ...(attachments !== undefined ? { attachments } : {}),
  })
}

export function moveQueuedPrompt(instanceId: string, sessionId: string, id: string, delta: number): Promise<void> {
  return mutateQueueState(instanceId, sessionId, { op: "move", id, delta }).then(() => undefined)
}

/** True when the clear won the CAS; false when another window moved the queue. */
export async function clearQueue(instanceId: string, sessionId: string): Promise<boolean> {
  const outcome = await mutateQueueState(instanceId, sessionId, { op: "clear" })
  return outcome.status === "ok"
}

export async function setQueuePaused(instanceId: string, sessionId: string, paused: boolean): Promise<void> {
  await mutateQueueState(instanceId, sessionId, { op: "set-paused", paused })
}

export async function toggleQueuePaused(instanceId: string, sessionId: string): Promise<void> {
  await setQueuePaused(instanceId, sessionId, !isQueuePaused(instanceId, sessionId))
}

/** Test seam: drops all mirrored state. */
export function resetQueues() {
  latestRefreshRequest += 1
  stateVersions.clear()
  mirrorVersion = 0
  setQueues(new Map())
}

/** Restores only prompts proven not to have reached promptAsync. */
export async function restoreDequeuedPrompt(
  instanceId: string,
  sessionId: string,
  item: QueuedPrompt,
): Promise<boolean> {
  let outcome = await mutateQueueState(instanceId, sessionId, { op: "restore", item, pause: true })
  if (outcome.status === "conflict") {
    outcome = await mutateQueueState(instanceId, sessionId, { op: "restore", item, pause: true })
  }
  return outcome.status === "ok"
}

export async function restoreDequeuedPrompts(
  instanceId: string,
  sessionId: string,
  items: QueuedPrompt[],
): Promise<boolean> {
  // Reverse single-item restores prepend each item while keeping every request
  // below Fastify's bounded body limit.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (!(await restoreDequeuedPrompt(instanceId, sessionId, items[index]!))) return false
  }
  return true
}

/** Imports the shipped 0.0.2 renderer queue once, then removes its old owner. */
export function migrateLegacyQueueStorage(): Promise<boolean> {
  if (legacyMigration) return legacyMigration
  if (typeof localStorage === "undefined") return Promise.resolve(true)
  const initialRaw = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (!initialRaw) return Promise.resolve(true)

  legacyMigration = withLegacyMigrationLock(async () => {
    let raw = initialRaw
    for (let snapshotAttempt = 0; snapshotAttempt < 3; snapshotAttempt += 1) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        log.warn("Failed to parse legacy prompt queue; preserving local copy:", error)
        return false
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false

      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false
        const candidate = value as { items?: unknown; paused?: unknown }
        if (!Array.isArray(candidate.items) || !candidate.items.every(isQueuedPrompt)) return false
        const separator = key.indexOf(":")
        if (separator <= 0 || separator !== key.lastIndexOf(":") || separator === key.length - 1) return false
        const instanceId = key.slice(0, separator)
        const sessionId = key.slice(separator + 1)
        for (const item of candidate.items) {
          let outcome = await mutateQueueState(instanceId, sessionId, { op: "import-legacy", item })
          if (outcome.status === "conflict") {
            outcome = await mutateQueueState(instanceId, sessionId, { op: "import-legacy", item })
          }
          if (outcome.status !== "ok") return false
        }
        if (candidate.paused === true) {
          let outcome = await mutateQueueState(instanceId, sessionId, { op: "set-paused", paused: true })
          if (outcome.status === "conflict") {
            outcome = await mutateQueueState(instanceId, sessionId, { op: "set-paused", paused: true })
          }
          if (outcome.status !== "ok") return false
        }
      }

      const currentRaw = localStorage.getItem(LEGACY_STORAGE_KEY)
      if (currentRaw !== raw) {
        if (!currentRaw) return true
        raw = currentRaw
        continue
      }
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY)
        return true
      } catch (error) {
        log.warn("Legacy prompt queue imported but local cleanup failed:", error)
        return false
      }
    }
    return false
  }).finally(() => {
    legacyMigration = null
  })
  return legacyMigration
}
