import { batch, createSignal } from "solid-js"

import { serverApi } from "../lib/api-client"
import { getLogger } from "../lib/logger"
import { createSharedInterval } from "./shared-interval"
import { deleteThreadEvents, pruneThreadEvents, putThreadEvents } from "./thread-event-cache"
import type {
  FreebuffStatusResponse,
  FreebuffReleaseSlotResponse,
  FreebuffThreadMessage,
  FreebuffThreadView,
} from "../../../server/src/api-types"

const log = getLogger("freebuff")
const FREEBUFF_EVENT_TEXT_CHARS = 256 * 1024
const FREEBUFF_THREAD_EVENT_WEIGHT = 512 * 1024
const TRUNCATED_EVENT_PREFIX = "[…]\n"

export interface FreebuffAgentEventView {
  seq: number
  type: string
  text?: string
  toolName?: string
  stage?: string
  [key: string]: unknown
}

export interface FreebuffBusEventView {
  type: string
  threadId?: string
  seq?: number
  event?: FreebuffAgentEventView
  [key: string]: unknown
}

const [status, setStatus] = createSignal<FreebuffStatusResponse | null>(null)
const [threads, setThreads] = createSignal<FreebuffThreadView[]>([])
const [activeThreadId, setActiveThreadId] = createSignal<string | null>(null)
const [eventsByThread, setEventsByThread] = createSignal<Map<string, FreebuffAgentEventView[]>>(new Map())
const [busy, setBusy] = createSignal(false)
const [error, setError] = createSignal<string | null>(null)

let eventsSource: EventSource | null = null
let statusRefreshInFlight: Promise<void> | null = null
const statusPoller = createSharedInterval(() => {
  if (status()?.ready) void refreshFreebuffStatus()
}, 30_000)

export const freebuffStatus = status
export const freebuffThreads = threads
export const freebuffActiveThreadId = activeThreadId
export const freebuffEventsByThread = eventsByThread
export const freebuffBusy = busy
export const freebuffError = error

export function freebuffEventsFor(threadId: string | null): FreebuffAgentEventView[] {
  if (!threadId) return []
  return eventsByThread().get(threadId) ?? []
}

export function freebuffQuota() {
  return status()?.quota?.snapshot ?? null
}

/** True when codebuff.com reports another active hosted session on this network. */
export function freebuffSlotActive(): boolean {
  const counts = freebuffQuota()?.desktopSessionCounts
  if (!counts) return false
  return (counts.premium ?? 0) + (counts.unlimited ?? 0) > 0
}

export function freebuffAccountEmail(): string | null {
  return status()?.auth?.email ?? null
}

function connectEvents() {
  if (eventsSource) return
  const source = new EventSource("/api/freebuff/events")
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as FreebuffBusEventView
      handleBusEvent(event)
    } catch (error) {
      log.error("Failed to parse FreeBuff event", error)
    }
  }
  source.onerror = () => {
    // EventSource auto-reconnects; keep the reference valid.
    log.warn("FreeBuff events stream disconnected")
  }
  eventsSource = source
}

function handleBusEvent(event: FreebuffBusEventView) {
  if (event.type === "thread" && typeof event.threadId === "string") {
    const threadId = event.threadId
    setThreads((current) => {
      const snapshot = event as unknown as { thread?: FreebuffThreadView }
      if (!snapshot.thread) return current
      const existing = current.findIndex((thread) => thread.id === snapshot.thread!.id)
      if (snapshot.thread.status !== "open") {
        return existing >= 0 ? current.filter((thread) => thread.id !== snapshot.thread!.id) : current
      }
      if (existing >= 0) {
        const next = [...current]
        next[existing] = snapshot.thread!
        return next
      }
      return [snapshot.thread!, ...current]
    })
    const snapshot = (event as unknown as { thread?: FreebuffThreadView }).thread
    if (snapshot?.status !== "open") {
      setEventsByThread((current) => deleteThreadEvents(current, threadId))
      if (activeThreadId() === threadId) setActiveThreadId(null)
    }
    return
  }
  if (event.type === "agent" && typeof event.threadId === "string" && event.event) {
    const { seq: innerSeq, ...rest } = event.event
    const agentEvent = {
      ...rest,
      seq: typeof event.seq === "number" ? event.seq : (typeof innerSeq === "number" ? innerSeq : 0),
    } as FreebuffAgentEventView
    if (typeof agentEvent.text === "string") agentEvent.text = boundEventText(agentEvent.text)
    setEventsByThread((current) => {
      const next = new Map(current)
      const list = [...(next.get(event.threadId!) ?? [])]
      // Concatenate consecutive streamed text/reasoning deltas so token-level
      // chunks render as one growing paragraph instead of one block per token.
      const last = list[list.length - 1]
      if (last && (last.type === "text" || last.type === "reasoning" || last.type === "reasoning_delta")
        && agentEvent.type === last.type
        && typeof last.text === "string" && typeof agentEvent.text === "string") {
        list[list.length - 1] = { ...last, text: boundEventText(last.text + agentEvent.text) }
      } else {
        list.push(agentEvent)
      }
      return putFreebuffThreadEvents(next, event.threadId!, list)
    })
  }
}

export function refreshFreebuffStatus(): Promise<void> {
  if (statusRefreshInFlight) return statusRefreshInFlight
  const refresh = (async () => {
    try {
      const next = await serverApi.fetchFreebuffStatus()
      batch(() => {
        setStatus(next)
        setError(next.error ? next.error : null)
      })
      if (next.ready) connectEvents()
    } catch (cause) {
      log.error("Failed to load FreeBuff status", cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  })()
  const settled = refresh.finally(() => {
    if (statusRefreshInFlight === settled) statusRefreshInFlight = null
  })
  statusRefreshInFlight = settled
  return settled
}

export async function startFreebuffEngine(): Promise<FreebuffStatusResponse | null> {
  setBusy(true)
  setError(null)
  try {
    const next = await serverApi.startFreebuff()
    batch(() => {
      setStatus(next)
      if (!next.engineRunning && next.error) setError(next.error)
    })
    if (next.engineRunning) connectEvents()
    return next
  } catch (cause) {
    log.error("Failed to start FreeBuff engine", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
    return null
  } finally {
    setBusy(false)
  }
}

export async function stopFreebuffEngine(): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await serverApi.stopFreebuff()
    eventsSource?.close()
    eventsSource = null
    batch(() => {
      setStatus((current) => (current ? { ...current, engineRunning: false, ready: false, port: null } : current))
      setThreads([])
      setEventsByThread(new Map())
      setActiveThreadId(null)
    })
  } catch (cause) {
    log.error("Failed to stop FreeBuff engine", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
  } finally {
    setBusy(false)
  }
}

export async function refreshFreebuffThreads(): Promise<void> {
  if (!status()?.ready) return
  try {
    const response = await serverApi.fetchFreebuffThreads()
    batch(() => {
      setThreads(response.threads)
      const keep = new Set(response.threads.map((thread) => thread.id))
      const active = activeThreadId()
      if (active && !keep.has(active)) setActiveThreadId(null)
      setEventsByThread((current) => pruneThreadEvents(current, keep))
    })
  } catch (cause) {
    log.error("Failed to load FreeBuff threads", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
  }
}

export async function createFreebuffThread(folder: string, model: string, title?: string): Promise<FreebuffThreadView | null> {
  setBusy(true)
  setError(null)
  try {
    const thread = await serverApi.createFreebuffThread({ projectPath: folder, model, reasoningEffort: "high", ...(title?.trim() ? { title: title.trim() } : {}) })
    connectEvents()
    setActiveThreadId(thread.id)
    await refreshFreebuffThreads()
    return thread
  } catch (cause) {
    log.error("Failed to create FreeBuff thread", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
    return null
  } finally {
    setBusy(false)
  }
}

/** Starts the engine automatically when the FreeBuff surface opens and an install exists. */
export async function ensureFreebuffEngine(): Promise<boolean> {
  const current = status()
  if (!current) await refreshFreebuffStatus()
  const fresh = status()
  if (!fresh?.installFound) return false
  if (fresh.ready) {
    connectEvents()
    return true
  }
  const started = await startFreebuffEngine()
  return Boolean(started?.ready)
}

export async function freebuffPostMessage(threadId: string, text: string): Promise<boolean> {
  setError(null)
  try {
    await serverApi.freebuffPostMessage(threadId, text)
    return true
  } catch (cause) {
    log.error("Failed to dispatch FreeBuff prompt", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
    return false
  }
}

/**
 * Explicit slot-release sweep: closes every idle FreeBuff thread SAIWORK holds
 * and reports whether the network slot is free again. The recovery path when a
 * turn was rejected because another tab (often FreeBuff Desktop) holds the
 * slot. Failed admissions consume no quota.
 */
export async function releaseFreebuffSlot(): Promise<FreebuffReleaseSlotResponse | null> {
  setBusy(true)
  setError(null)
  try {
    const result = await serverApi.releaseFreebuffSlot()
    if (!result.slotFree && result.note) setError(result.note)
    await refreshFreebuffStatus()
    return result
  } catch (cause) {
    log.error("Failed to release FreeBuff slot", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
    return null
  } finally {
    setBusy(false)
  }
}

export async function freebuffStopTurn(threadId: string): Promise<void> {
  setError(null)
  try {
    await serverApi.freebuffStopThread(threadId)
  } catch (cause) {
    log.error("Failed to stop FreeBuff turn", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
  }
}

export function selectFreebuffThread(threadId: string | null): void {
  setActiveThreadId(threadId)
  if (threadId) void loadFreebuffThreadHistory(threadId)
}

/** Loads an existing thread's message history into the live event list. */
export async function loadFreebuffThreadHistory(threadId: string): Promise<void> {
  if (!status()?.ready) return
  try {
    const response = await serverApi.fetchFreebuffThread(threadId)
    const events = messagesToEvents(response.messages)
    setEventsByThread((current) => putFreebuffThreadEvents(current, threadId, events))
  } catch (cause) {
    log.error("Failed to load FreeBuff thread history", cause)
    setError(cause instanceof Error ? cause.message : String(cause))
  }
}

function messagesToEvents(messages: FreebuffThreadMessage[]): FreebuffAgentEventView[] {
  const events: FreebuffAgentEventView[] = []
  for (const message of messages) {
    const prefix = message.role === "user" ? "user" : "assistant"
    for (const part of message.parts ?? []) {
      const kind = part.kind
      if (kind === "text" || kind === "reasoning" || kind === "reasoning_delta") {
        events.push({ seq: events.length, type: prefix, text: boundEventText(part.text ?? "") })
      } else if (kind === "tool-call" || kind === "tool_call") {
        events.push({ seq: events.length, type: "tool_call", toolName: typeof part.toolName === "string" ? part.toolName : "tool" })
      } else {
        events.push({ seq: events.length, type: prefix, text: boundEventText(String(part.text ?? "")) })
      }
    }
  }
  return events
}

export function clearFreebuffEvents(threadId: string): void {
  setEventsByThread((current) => deleteThreadEvents(current, threadId))
}

export function startFreebuffStatusPolling(): () => void {
  return statusPoller.subscribe()
}

function putFreebuffThreadEvents(
  current: ReadonlyMap<string, FreebuffAgentEventView[]>,
  threadId: string,
  events: FreebuffAgentEventView[],
): Map<string, FreebuffAgentEventView[]> {
  return putThreadEvents(current, threadId, events, {
    maxWeightPerThread: FREEBUFF_THREAD_EVENT_WEIGHT,
    weight: (event) => (typeof event.text === "string" ? event.text.length : 0) + 256,
  })
}

function boundEventText(text: string): string {
  if (text.length <= FREEBUFF_EVENT_TEXT_CHARS) return text
  return TRUNCATED_EVENT_PREFIX + text.slice(-(FREEBUFF_EVENT_TEXT_CHARS - TRUNCATED_EVENT_PREFIX.length))
}
