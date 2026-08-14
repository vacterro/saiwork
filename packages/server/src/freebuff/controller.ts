import type { Logger } from "../logger"
import { createFreebuffClient, type FreebuffClient } from "./client"
import type { FreebuffEngineManager, FreebuffEngineStatus } from "./engine"
import { readFreebuffAuth } from "./install"
import { fetchFreebuffQuota, type FreebuffQuotaResult } from "./quota"
import type { FreebuffAuthState, FreebuffBusEvent, FreebuffThread } from "./types"

export interface FreebuffControllerOptions {
  engineManager: FreebuffEngineManager
  logger: Logger
  /** Resolve the account token for quota reads; defaults to the install auth. */
  getToken?: () => string | null
  /**
   * Close an open thread after this much time with no engine activity. FreeBuff
   * holds a hosted-session slot while a thread is open; idle tabs waste that
   * slot and count against the network limit. Sending a message later reopens
   * the thread, so closing idle tabs is lossless.
   */
  idleCloseMs?: number
  /** How often the idle sweep runs. */
  idleSweepIntervalMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

/** Result of the explicit slot-release sweep (see `releaseSlotNow`). */
export interface FreebuffReleaseSlotResult {
  /** Idle slot-holding threads SAIWORK closed during the sweep. */
  closedThreads: number
  /** True when the network session counter reports no other active session. */
  slotFree: boolean
  /** Active hosted sessions reported by codebuff.com at the end of the sweep. */
  sessionsActive: number
  /** Human-readable explanation when the slot is still held. */
  note: string | null
}

/**
 * Facade over the FreeBuff engine used by SAIWORK's HTTP routes.
 *
 * Ensures the engine is running before returning a client, and keeps quota
 * reads independent of engine state (the quota endpoint is reachable directly
 * from codebuff.com and does not consume a session slot).
 *
 * The orchestrator has no bulk thread-list route; open threads arrive only as
 * `thread` events on its /api/events stream (including on subscribe). The
 * controller keeps one engine subscription alive and mirrors those events into
 * a thread registry, so `/api/freebuff/threads` can answer truthfully instead
 * of returning an empty list.
 */
export class FreebuffController {
  private clientCache: FreebuffClient | null = null
  private readonly options: FreebuffControllerOptions
  private threadsByProject = new Map<string, Map<string, FreebuffThread>>()
  private listenerStarted = false
  private unsubscribeListener: (() => void) | null = null
  private stopped = true
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null
  /** Threads currently holding a hosted-model session slot. */
  private activeSessionThreads = new Set<string>()
  /** Queued-prompt count per thread, from thread events (idle close skips these). */
  private queueCountByThread = new Map<string, number>()

  constructor(options: FreebuffControllerOptions) {
    this.options = options
  }

  get engineManager(): FreebuffEngineManager {
    return this.options.engineManager
  }

  status(): FreebuffEngineStatus {
    return this.options.engineManager.status
  }

  async ensureRunning(): Promise<FreebuffEngineStatus> {
    const status = await this.options.engineManager.start()
    if (status.ready) this.startListening()
    return status
  }

  client(): FreebuffClient | null {
    const port = this.options.engineManager.status.port
    if (!port) return null
    if (this.clientCache && this.clientCache.baseUrl === `http://127.0.0.1:${port}`) {
      return this.clientCache
    }
    this.clientCache = createFreebuffClient({ baseUrl: `http://127.0.0.1:${port}` })
    return this.clientCache
  }

  auth(): FreebuffAuthState | null {
    return this.options.engineManager.status.auth ?? readFreebuffAuth()
  }

  async quota(): Promise<FreebuffQuotaResult> {
    const getToken = this.options.getToken ?? (() => this.auth()?.token ?? null)
    return fetchFreebuffQuota(getToken)
  }

  /** Open threads across every registered project, newest first. */
  listThreads(): FreebuffThread[] {
    // Self-heal: re-attach the mirror listener if the engine is up but the
    // subscription died (e.g. after an engine restart).
    if (!this.listenerStarted && this.options.engineManager.status.ready) {
      this.startListening()
    }
    const threads: FreebuffThread[] = []
    for (const byId of this.threadsByProject.values()) {
      for (const thread of byId.values()) {
        if (thread.status === "open") threads.push(thread)
      }
    }
    return threads.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopListening()
    this.stopIdleSweep()
    this.clientCache = null
    this.threadsByProject.clear()
    this.activeSessionThreads.clear()
    this.queueCountByThread.clear()
    await this.options.engineManager.stop()
  }

  /**
   * Free the hosted-model session slot for `targetThreadId` by closing every
   * OTHER thread SAIWORK knows is holding one. FreeBuff allows one hosted tab
   * per network; a new turn can only be admitted once the stale holders
   * release their slots. Closing a thread releases the slot and later messages
   * reopen it, so no conversation is lost.
   *
   * A holder that is currently RUNNING a turn is never closed: killing it would
   * destroy minutes/hours of agent work (long FreeBuff turns are expected).
   * The caller then surfaces the honest "another tab is using the slot" error;
   * the running turn finishes and its thread closes, after which the slot is
   * free for a retry.
   */
  async freeSlotFor(targetThreadId: string, options: { waitMs?: number; signal?: AbortSignal; operationTimeoutMs?: number } = {}): Promise<void> {
    throwIfAborted(options.signal)
    const client = this.client()
    if (!client) return
    const operationTimeoutMs = options.operationTimeoutMs ?? 5_000
    const holders = await this.collectIdleHolders(targetThreadId, options.signal, operationTimeoutMs)
    throwIfAborted(options.signal)
    if (holders.length === 0) return
    await Promise.all(holders.map(async (threadId) => {
      try {
        return await boundedOperation(
          (signal) => client.closeThread(threadId, { signal }),
          options.signal,
          operationTimeoutMs,
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        return undefined
      }
    }))
    throwIfAborted(options.signal)
    // Give the engine time to observe the release and drop the server-side
    // usage count before the next admission is attempted.
    const waitMs = options.waitMs ?? 400
    if (waitMs > 0) await abortableDelay(waitMs, options.signal)
  }

  /**
   * Explicit "release the slot now" sweep for the FreeBuff status panel. Closes
   * EVERY idle holder SAIWORK can reach (the same probe that `freeSlotFor`
   * runs, minus a target exemption), then confirms against the codebuff.com
   * session counter whether the network slot actually dropped. This is the
   * recovery path when a turn was rejected because the slot is held elsewhere
   * (a FreeBuff Desktop tab the user opened manually, or a thread SAIWORK
   * abandoned). Running turns are never touched.
   */
  async releaseSlotNow(options: { confirmTimeoutMs?: number } = {}): Promise<FreebuffReleaseSlotResult> {
    const client = this.client()
    if (!client) {
      return { closedThreads: 0, slotFree: false, sessionsActive: 0, note: "FreeBuff engine is not running" }
    }
    const holders = await this.collectIdleHolders()
    const closed = holders.length > 0
      ? (await Promise.all(holders.map((threadId) => client.closeThread(threadId).catch(() => undefined)))).filter(Boolean)
      : []
    // The release propagates to the cloud within a few seconds; poll the
    // session counter for a bounded window before declaring the result.
    const confirmTimeoutMs = options.confirmTimeoutMs ?? 6_000
    const deadline = Date.now() + confirmTimeoutMs
    let sessionsActive = 0
    let note: string | null = null
    while (true) {
      const snapshot = (await this.quota()).snapshot
      const counts = snapshot?.desktopSessionCounts
      sessionsActive = counts ? (counts.premium ?? 0) + (counts.unlimited ?? 0) : 0
      if (sessionsActive === 0) break
      if (Date.now() >= deadline) {
        note = counts?.nextExpiryAt
          ? `Another hosted session is still active on this network; it expires automatically (${counts.nextExpiryAt}). No FreeBuff quota was consumed.`
          : "Another hosted session is still active on this network (FreeBuff Desktop or another tab). No FreeBuff quota was consumed."
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    return { closedThreads: closed.length, slotFree: sessionsActive === 0, sessionsActive, note }
  }

  /**
   * Threads SAIWORK can safely close to free a slot: mirror-known holders that
   * are not mid-turn, plus holders missing from the mirror that the engine
   * confirms are idle (never a blind kill on an unknown). Excludes
   * `exceptThreadId` when freeing a slot for that thread's own turn.
   */
  private async collectIdleHolders(exceptThreadId?: string, signal?: AbortSignal, operationTimeoutMs = 5_000): Promise<string[]> {
    const client = this.client()
    if (!client) return []
    const holders: string[] = []
    for (const threadId of [...this.activeSessionThreads]) {
      if (threadId === exceptThreadId) continue
      const thread = this.findThread(threadId)
      if (thread !== null) {
        // Never close a holder whose turn is running: it would destroy hours of
        // agent work.
        if (thread.turnState !== "running") holders.push(threadId)
        continue
      }
      // Unknown to the mirror (possible desync): probe the engine before
      // deciding, and only close a holder the engine confirms is idle.
      try {
        const live = await boundedOperation(
          (operationSignal) => client.getThread(threadId, { signal: operationSignal }),
          signal,
          operationTimeoutMs,
        )
        const state = (live as { thread?: { turnState?: string } }).thread ?? live
        if (state?.turnState === "idle") holders.push(threadId)
      } catch (error) {
        if (signal?.aborted) throw error
        // Unreachable: leave it alone rather than risk a blind kill.
      }
    }
    return holders
  }

  private findThread(threadId: string): FreebuffThread | null {
    for (const byId of this.threadsByProject.values()) {
      const thread = byId.get(threadId)
      if (thread) return thread
    }
    return null
  }

  private startListening(): void {
    if (this.listenerStarted || this.unsubscribeListener) return
    const client = this.client()
    if (!client) return
    this.stopped = false
    this.listenerStarted = true
    const onEvent = (event: FreebuffBusEvent) => {
      if (event.type === "thread") this.recordThreadEvent(event)
      if (event.type === "state" && "snapshot" in event && typeof event.snapshot === "object" && event.snapshot !== null) {
        const snapshot = event.snapshot as {
          sessions?: { activeSessionsByThread?: Record<string, unknown> }
          activeSessionsByThread?: Record<string, unknown>
        }
        const byThread = snapshot.sessions?.activeSessionsByThread ?? snapshot.activeSessionsByThread
        this.activeSessionThreads = new Set(Object.keys(byThread ?? {}))
      }
    }
    void client.subscribeEvents(onEvent, () => {
      this.listenerStarted = false
      this.unsubscribeListener = null
    }).then((unsubscribe) => {
      this.unsubscribeListener = unsubscribe
      if (!this.listenerStarted) unsubscribe()
    })

    this.startIdleSweep()
  }

  private startIdleSweep(): void {
    if (this.idleSweepTimer) return
    const intervalMs = this.options.idleSweepIntervalMs ?? 60_000
    const idleCloseMs = this.options.idleCloseMs ?? 6 * 60 * 1000
    if (intervalMs <= 0 || idleCloseMs <= 0) return
    this.idleSweepTimer = setInterval(() => {
      void this.closeIdleThreads(idleCloseMs)
    }, intervalMs)
    if (this.idleSweepTimer.unref) this.idleSweepTimer.unref()
  }

  private stopIdleSweep(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = null
    }
  }

  /**
   * Manually trigger the idle sweep. Also runs automatically on its interval;
   * exposed for tests and for a caller that just joined and wants a pass now.
   */
  async sweepIdleThreadsNow(): Promise<void> {
    const idleCloseMs = this.options.idleCloseMs ?? 6 * 60 * 1000
    await this.closeIdleThreads(idleCloseMs)
  }

  /**
   * Close open threads that have been idle (no engine activity) for longer than
   * `idleMs`. Running threads are never touched; a closed thread reopens on its
   * next message, so no conversation is lost. Releases the hosted-session slot
   * so it is not burned on an abandoned tab.
   */
  private async closeIdleThreads(idleMs: number): Promise<void> {
    const client = this.client()
    if (!client) return
    const now = (this.options.now ?? Date.now)()
    const candidates: string[] = []
    for (const byId of this.threadsByProject.values()) {
      for (const thread of byId.values()) {
        if (thread.status !== "open") continue
        if (thread.turnState === "running") continue
        // A thread with queued prompts still has pending work: closing it would
        // interrupt the queue's delivery, so only genuinely abandoned threads
        // are closed.
        if ((this.queueCountByThread.get(thread.id) ?? 0) > 0) continue
        const lastActivity = thread.updatedAt ?? thread.createdAt ?? 0
        if (lastActivity > 0 && now - lastActivity >= idleMs) candidates.push(thread.id)
      }
    }
    if (candidates.length === 0) return
    const closed = await Promise.all(candidates.map((threadId) => client.closeThread(threadId).catch(() => undefined)))
    const closedCount = closed.filter(Boolean).length
    if (closedCount > 0) {
      this.options.logger.info({ threads: candidates.length, closed: closedCount, idleMs }, "Closed idle FreeBuff threads to release hosted-session slots")
    }
  }

  private stopListening(): void {
    this.listenerStarted = false
    this.unsubscribeListener?.()
    this.unsubscribeListener = null
  }

  private recordThreadEvent(event: FreebuffBusEvent): void {
    if (this.stopped) return
    if (!("thread" in event) || typeof event.thread !== "object" || event.thread === null) return
    const thread = event.thread as FreebuffThread
    const items = Array.isArray((event as { items?: unknown }).items) ? (event as { items: unknown[] }).items : []
    this.queueCountByThread.set(thread.id, items.length)
    const project = typeof thread.projectId === "string" ? thread.projectId : "default"
    let byId = this.threadsByProject.get(project)
    if (!byId) {
      byId = new Map()
      this.threadsByProject.set(project, byId)
    }
    if (thread.status === "open") {
      byId.set(thread.id, thread)
    } else {
      byId.delete(thread.id)
      this.queueCountByThread.delete(thread.id)
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Request aborted")
}

function abortableDelay(waitMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("Request aborted"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, waitMs)
    if (timer.unref) timer.unref()
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function boundedOperation<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const operationAbort = new AbortController()
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const onAbort = () => {
      operationAbort.abort()
      finish(new Error("Request aborted"))
    }
    const timer = setTimeout(() => {
      operationAbort.abort()
      finish(new Error(`FreeBuff operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    if (timer.unref) timer.unref()
    try {
      operation(operationAbort.signal).then((value) => finish(null, value), finish)
    } catch (error) {
      finish(error)
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
}
