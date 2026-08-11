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
    this.clientCache = null
    this.threadsByProject.clear()
    await this.options.engineManager.stop()
  }

  private startListening(): void {
    if (this.listenerStarted || this.unsubscribeListener) return
    const client = this.client()
    if (!client) return
    this.stopped = false
    this.listenerStarted = true
    const onEvent = (event: FreebuffBusEvent) => {
      if (event.type === "thread") this.recordThreadEvent(event)
    }
    void client.subscribeEvents(onEvent, () => {
      this.listenerStarted = false
      this.unsubscribeListener = null
    }).then((unsubscribe) => {
      this.unsubscribeListener = unsubscribe
      if (!this.listenerStarted) unsubscribe()
    })
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
    }
  }
}
