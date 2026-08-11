import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import {
  MAX_QUEUED_ATTACHMENT_BYTES,
  type QueuedPrompt as ServerQueuedPrompt,
  type QueueState as ServerQueueState,
  type WorkspaceEventPayload,
} from "../../../server/src/api-types"
import type { QueueMutation as ServerQueueMutation } from "../../../server/src/queue/manager"
import type { Attachment } from "../types/attachment"
import { createAttachmentPlaceholderRegex, getAttachmentPlaceholder } from "../lib/attachment-placeholders"

const log = getLogger("actions")

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

export type EnqueueFailure = "empty" | "too-large" | "conflict"

export type EnqueueResult = { ok: true; item: QueuedPrompt } | { ok: false; reason: EnqueueFailure }

export type FanOutResult = { ok: true; items: QueuedPrompt[] } | { ok: false; reason: EnqueueFailure }

export type QueueMutateOutcome =
  | { status: "ok"; state: ServerQueueState; dequeued?: ServerQueuedPrompt }
  | { status: "conflict"; currentRevision: string }
  | { status: "failed"; code: "empty" | "paused" | "too-large" | "invalid" }

export interface QueueTransport {
  list(): Promise<Record<string, ServerQueueState>>
  mutate(key: string, expectedRevision: string, mutation: ServerQueueMutation): Promise<QueueMutateOutcome>
  onChange(handler: (event: Extract<WorkspaceEventPayload, { type: "queue.changed" }>) => void): () => void
  onOpen(handler: () => void): () => void
}

const defaultTransport: QueueTransport = {
  list: async () => (await serverApi.fetchQueues()).queues,
  mutate: (key, expectedRevision, mutation) => serverApi.mutateQueue(key, expectedRevision, mutation),
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
  if (attachments.length === 0) return 0
  try {
    return JSON.stringify(attachments).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The mirror stores server-shaped items; the panel wants typed attachments. */
function toTyped(items: ServerQueuedPrompt[]): QueuedPrompt[] {
  return items as unknown as QueuedPrompt[]
}

const EMPTY: QueuedPrompt[] = []

const [queues, setQueues] = createSignal<Map<string, ServerQueueState>>(new Map())

function applyState(key: string, state: ServerQueueState): void {
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
  try {
    const all = await transport.list()
    setQueues((prev) => {
      const next = new Map<string, ServerQueueState>()
      for (const [key, state] of Object.entries(all)) next.set(key, state)
      // A paused empty queue must stay visible as paused even if the server
      // dropped the key.
      for (const [key, state] of prev) {
        if (!next.has(key) && state.paused) next.set(key, state)
      }
      return next
    })
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
  const outcome = await transport.mutate(key, revision, mutation)
  if (outcome.status === "ok") {
    applyState(key, outcome.state)
  } else if (outcome.status === "conflict") {
    // Another window moved the queue first. Mirror the truth instead of
    // guessing: the next read shows the authoritative state.
    void refreshAllQueues()
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
  return { ok: false, reason: outcome.code === "too-large" ? "too-large" : "empty" }
}

/** Adds one prompt to several session queues. All or nothing. */
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
  const added: Array<{ target: PromptQueueTarget; id: string }> = []
  const items: QueuedPrompt[] = []

  for (const target of unique) {
    const outcome = await mutateQueueState(target.instanceId, target.sessionId, { op: "enqueue", text: trimmed, attachments })
    if (outcome.status !== "ok") {
      // Roll back what already landed so the user never sees a partial fan-out.
      for (const prior of added) {
        void mutateQueueState(prior.target.instanceId, prior.target.sessionId, { op: "remove", id: prior.id })
      }
      return { ok: false, reason: outcome.status === "conflict" ? "conflict" : "too-large" }
    }
    const item = outcome.state.items[outcome.state.items.length - 1]
    if (item) {
      items.push(toTyped([item])[0]!)
      added.push({ target, id: item.id })
    }
  }
  return { ok: true, items }
}

/** Removes and returns the head. Returns null when paused, empty or lost the race. */
export async function dequeuePrompt(instanceId: string, sessionId: string): Promise<QueuedPrompt | null> {
  const outcome = await mutateQueueState(instanceId, sessionId, { op: "dequeue" })
  if (outcome.status !== "ok" || !outcome.dequeued) return null
  return toTyped([outcome.dequeued])[0]!
}

/** Restores a failed dequeue at the front without changing identity or order. */
export async function restoreDequeuedPrompt(
  instanceId: string,
  sessionId: string,
  item: QueuedPrompt,
  options?: { pause?: boolean },
): Promise<void> {
  await mutateQueueState(instanceId, sessionId, {
    op: "restore",
    item: { id: item.id, text: item.text, attachments: item.attachments, createdAt: item.createdAt },
    ...(options?.pause ? { pause: true } : {}),
  })
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
  setQueues(new Map())
}
