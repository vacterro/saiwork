import { createSignal } from "solid-js"
import type { Attachment } from "../types/attachment"
import { getLogger } from "../lib/logger"

const log = getLogger("actions")

/**
 * Prompt queue.
 *
 * The user stacks prompts while the agent is working; each one is sent when the
 * session goes idle. Ordering, editing, and removal are all explicit user
 * actions -- the queue never reorders or drops anything on its own, and a
 * paused queue stays paused until the user resumes it.
 *
 * State lives in one signal keyed by instance+session rather than one signal
 * per session, so a queue survives the session view unmounting (tab switch)
 * without any per-component lifecycle bookkeeping.
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

interface QueueState {
  items: QueuedPrompt[]
  paused: boolean
}

const STORAGE_KEY = "saiwork.prompt-queue.v1"
const EMPTY: QueuedPrompt[] = []

/**
 * Cap on the serialized attachments of a single queued prompt.
 *
 * Attachments arrive as data URLs, so one screenshot can be several megabytes
 * and localStorage typically holds five in total. Without a bound, one oversized
 * paste fails the write for every session's queue at once, and the user is told
 * nothing.
 */
export const MAX_QUEUED_ATTACHMENT_BYTES = 512 * 1024

export type EnqueueFailure =
  /** Nothing to queue. */
  | "empty"
  /** Attachments exceed MAX_QUEUED_ATTACHMENT_BYTES. */
  | "too-large"
  /** Storage rejected the write, typically a full quota. */
  | "quota"

export type EnqueueResult = { ok: true; item: QueuedPrompt } | { ok: false; reason: EnqueueFailure }

export type FanOutResult = { ok: true; items: QueuedPrompt[] } | { ok: false; reason: EnqueueFailure }

type PersistResult = { ok: true } | { ok: false; reason: "quota" }

function measureAttachmentBytes(attachments: Attachment[]): number {
  if (attachments.length === 0) return 0
  try {
    return JSON.stringify(attachments).length
  } catch {
    // Unserializable attachments cannot survive a restart either way, so they
    // are treated as over the bound rather than silently queued.
    return Number.POSITIVE_INFINITY
  }
}

const [queues, setQueues] = createSignal<Map<string, QueueState>>(loadPersisted())

function queueKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

function emptyState(): QueueState {
  return { items: [], paused: false }
}

function nextId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `q-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function loadPersisted(): Map<string, QueueState> {
  if (typeof localStorage === "undefined") return new Map()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as Record<string, QueueState>
    const map = new Map<string, QueueState>()
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (!value || !Array.isArray(value.items)) continue
      map.set(key, { items: value.items, paused: Boolean(value.paused) })
    }
    return map
  } catch (error) {
    log.warn("Failed to restore prompt queue:", error)
    return new Map()
  }
}

/**
 * Writes the map and says whether it landed.
 *
 * This used to swallow the error and return, so an enqueue reported success
 * while nothing had been stored -- the editor text was already cleared, and the
 * prompt was gone at the next restart. A write that failed has to be a fact the
 * caller can act on.
 */
function persist(map: Map<string, QueueState>): PersistResult {
  if (typeof localStorage === "undefined") return { ok: true }
  try {
    const plain: Record<string, QueueState> = {}
    for (const [key, value] of map.entries()) {
      if (value.items.length === 0 && !value.paused) continue
      plain[key] = value
    }
    if (Object.keys(plain).length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return { ok: true }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plain))
    return { ok: true }
  } catch (error) {
    log.warn("Failed to persist prompt queue:", error)
    return { ok: false, reason: "quota" }
  }
}

interface MutateOptions {
  /**
   * Whether a failed write undoes the in-memory change.
   *
   * True for anything that GROWS the queue: memory and storage must not
   * disagree about a prompt the user believes is queued.
   *
   * False for anything that shrinks it. A shrink cannot plausibly fail on
   * quota, and rolling one back would wedge the queue permanently on a storage
   * that is broken for another reason -- the worst case of letting it through
   * is one entry reappearing after a restart, which beats a queue that can
   * never be emptied.
   */
  rollbackOnPersistFailure: boolean
}

function mutate(
  instanceId: string,
  sessionId: string,
  fn: (state: QueueState) => QueueState,
  options: MutateOptions = { rollbackOnPersistFailure: false },
): PersistResult {
  const key = queueKey(instanceId, sessionId)
  let outcome: PersistResult = { ok: true }

  setQueues((prev) => {
    const next = new Map(prev)
    const current = next.get(key) ?? emptyState()
    const updated = fn({ items: [...current.items], paused: current.paused })
    if (updated.items.length === 0 && !updated.paused) {
      next.delete(key)
    } else {
      next.set(key, updated)
    }

    outcome = persist(next)
    if (!outcome.ok && options.rollbackOnPersistFailure) {
      // Put the stored copy back so the two views agree, then report.
      persist(prev)
      return prev
    }
    return next
  })

  return outcome
}

export function getQueue(instanceId: string, sessionId: string): QueuedPrompt[] {
  return queues().get(queueKey(instanceId, sessionId))?.items ?? EMPTY
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

export function enqueuePrompt(
  instanceId: string,
  sessionId: string,
  text: string,
  attachments: Attachment[] = [],
): EnqueueResult {
  const trimmed = text.trim()
  if (!trimmed && attachments.length === 0) return { ok: false, reason: "empty" }

  // Checked before touching state: an oversized attachment would otherwise fail
  // the write for every session's queue, not just this one.
  if (measureAttachmentBytes(attachments) > MAX_QUEUED_ATTACHMENT_BYTES) {
    return { ok: false, reason: "too-large" }
  }

  const item: QueuedPrompt = {
    id: nextId(),
    text: trimmed,
    attachments,
    createdAt: Date.now(),
  }
  const persisted = mutate(
    instanceId,
    sessionId,
    (state) => ({ ...state, items: [...state.items, item] }),
    { rollbackOnPersistFailure: true },
  )
  if (!persisted.ok) return { ok: false, reason: persisted.reason }
  return { ok: true, item }
}

/** Adds one prompt to several session queues in one reactive update. */
export function enqueuePromptFanOut(
  targets: PromptQueueTarget[],
  text: string,
  attachments: Attachment[] = [],
): FanOutResult {
  const trimmed = text.trim()
  if ((!trimmed && attachments.length === 0) || targets.length === 0) return { ok: false, reason: "empty" }
  if (measureAttachmentBytes(attachments) > MAX_QUEUED_ATTACHMENT_BYTES) {
    return { ok: false, reason: "too-large" }
  }

  const uniqueTargets = new Map(targets.map((target) => [queueKey(target.instanceId, target.sessionId), target]))
  let items: QueuedPrompt[] = []
  // Declared as the union rather than inferred from the initializer, so the
  // assignment inside the updater is not narrowed away.
  let failure: EnqueueFailure | null = null

  setQueues((prev) => {
    const next = new Map(prev)
    const added: QueuedPrompt[] = []
    for (const [key] of uniqueTargets) {
      const item: QueuedPrompt = {
        id: nextId(),
        text: trimmed,
        attachments: [...attachments],
        createdAt: Date.now(),
      }
      const current = next.get(key) ?? emptyState()
      next.set(key, { ...current, items: [...current.items, item] })
      added.push(item)
    }

    const written = persist(next)
    if (!written.ok) {
      // All or nothing: a fan-out that landed on three of five sessions is a
      // state the user cannot reason about.
      failure = written.reason
      persist(prev)
      return prev
    }
    items = added
    return next
  })

  if (failure) return { ok: false, reason: failure }
  return { ok: true, items }
}

/** Removes and returns the head. Returns null when paused or empty. */
export function dequeuePrompt(instanceId: string, sessionId: string): QueuedPrompt | null {
  const key = queueKey(instanceId, sessionId)
  const state = queues().get(key)
  if (!state || state.paused || state.items.length === 0) return null

  const head = state.items[0]
  mutate(instanceId, sessionId, (current) => ({ ...current, items: current.items.slice(1) }))
  return head
}

/** Restores a failed dequeue at the front without changing identity or order. */
export function restoreDequeuedPrompt(
  instanceId: string,
  sessionId: string,
  item: QueuedPrompt,
  options?: { pause?: boolean },
) {
  // Deliberately not rolled back on a failed write: this runs when a send has
  // already failed, and refusing to restore the prompt in memory would lose the
  // user's text outright. A stale stored copy is the lesser harm.
  mutate(instanceId, sessionId, (state) => ({
    ...state,
    items: [item, ...state.items.filter((queued) => queued.id !== item.id)],
    paused: options?.pause ? true : state.paused,
  }))
}

export function removeQueuedPrompt(instanceId: string, sessionId: string, id: string) {
  mutate(instanceId, sessionId, (state) => ({ ...state, items: state.items.filter((item) => item.id !== id) }))
}

export function updateQueuedPrompt(instanceId: string, sessionId: string, id: string, text: string) {
  const trimmed = text.trim()
  if (!trimmed) {
    removeQueuedPrompt(instanceId, sessionId, id)
    return
  }
  mutate(instanceId, sessionId, (state) => ({
    ...state,
    items: state.items.map((item) => (item.id === id ? { ...item, text: trimmed } : item)),
  }))
}

/**
 * Moves one entry by `delta` positions. Clamped rather than wrapped: a wrap
 * would send the top item to the bottom on a stray keypress.
 */
export function moveQueuedPrompt(instanceId: string, sessionId: string, id: string, delta: number) {
  mutate(instanceId, sessionId, (state) => {
    const index = state.items.findIndex((item) => item.id === id)
    if (index < 0) return state
    const target = Math.max(0, Math.min(state.items.length - 1, index + delta))
    if (target === index) return state
    const items = [...state.items]
    const [moved] = items.splice(index, 1)
    items.splice(target, 0, moved)
    return { ...state, items }
  })
}

export function clearQueue(instanceId: string, sessionId: string) {
  mutate(instanceId, sessionId, (state) => ({ ...state, items: [] }))
}

export function setQueuePaused(instanceId: string, sessionId: string, paused: boolean) {
  mutate(instanceId, sessionId, (state) => ({ ...state, paused }))
}

export function toggleQueuePaused(instanceId: string, sessionId: string) {
  setQueuePaused(instanceId, sessionId, !isQueuePaused(instanceId, sessionId))
}

/** Test seam: drops all state without touching localStorage semantics. */
export function resetQueues() {
  setQueues(new Map())
  persist(new Map())
}
