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

interface QueueState {
  items: QueuedPrompt[]
  paused: boolean
}

const STORAGE_KEY = "saiwork.prompt-queue.v1"
const EMPTY: QueuedPrompt[] = []

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

function persist(map: Map<string, QueueState>) {
  if (typeof localStorage === "undefined") return
  try {
    const plain: Record<string, QueueState> = {}
    for (const [key, value] of map.entries()) {
      if (value.items.length === 0 && !value.paused) continue
      plain[key] = value
    }
    if (Object.keys(plain).length === 0) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plain))
  } catch (error) {
    log.warn("Failed to persist prompt queue:", error)
  }
}

function mutate(instanceId: string, sessionId: string, fn: (state: QueueState) => QueueState) {
  const key = queueKey(instanceId, sessionId)
  setQueues((prev) => {
    const next = new Map(prev)
    const current = next.get(key) ?? emptyState()
    const updated = fn({ items: [...current.items], paused: current.paused })
    if (updated.items.length === 0 && !updated.paused) {
      next.delete(key)
    } else {
      next.set(key, updated)
    }
    persist(next)
    return next
  })
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
): QueuedPrompt | null {
  const trimmed = text.trim()
  if (!trimmed && attachments.length === 0) return null

  const item: QueuedPrompt = {
    id: nextId(),
    text: trimmed,
    attachments,
    createdAt: Date.now(),
  }
  mutate(instanceId, sessionId, (state) => ({ ...state, items: [...state.items, item] }))
  return item
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
