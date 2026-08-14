import { randomUUID } from "crypto"
import type { PreviewSession } from "../api-types"

interface PreviewRecord {
  token: string
  sessionId: string
  target: URL
  createdAt: string
  lastAccessedAt: number
}

export interface PreviewManagerOptions {
  /** Hard cap on concurrent preview records; creating past it evicts LRU. */
  maxRecords?: number
  /** Idle expiry: a token untouched this long is pruned on access/create. */
  idleTtlMs?: number
  /** Absolute expiry from creation; the token dies even if actively used. */
  absoluteTtlMs?: number
}

const DEFAULT_MAX_RECORDS = 32
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000
const DEFAULT_ABSOLUTE_TTL_MS = 24 * 60 * 60 * 1000

export class PreviewManager {
  private readonly previews = new Map<string, PreviewRecord>()
  private readonly maxRecords: number
  private readonly idleTtlMs: number
  private readonly absoluteTtlMs: number

  constructor(options: PreviewManagerOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.absoluteTtlMs = options.absoluteTtlMs ?? DEFAULT_ABSOLUTE_TTL_MS
  }

  create(sessionId: string, rawUrl: string): PreviewSession {
    const now = Date.now()
    this.pruneExpired(now)
    if (this.previews.size >= this.maxRecords) {
      // One documented eviction rule: past the cap, the least-recently-accessed
      // record is evicted so the Map stays bounded no matter how many previews
      // are abandoned.
      const oldest = [...this.previews.values()].reduce((a, b) => (a.lastAccessedAt < b.lastAccessedAt ? a : b))
      this.previews.delete(oldest.token)
    }
    const target = this.normalizeTargetUrl(rawUrl)
    const token = randomUUID()
    const record: PreviewRecord = {
      token,
      sessionId,
      target,
      createdAt: new Date(now).toISOString(),
      lastAccessedAt: now,
    }
    this.previews.set(token, record)
    return this.toPreviewSession(record)
  }

  get(token: string): PreviewSession | undefined {
    const record = this.touch(token, Date.now())
    return record ? this.toPreviewSession(record) : undefined
  }

  delete(token: string): boolean {
    return this.previews.delete(token)
  }

  buildTargetUrl(token: string, incomingPath: string, search = ""): URL | undefined {
    const record = this.touch(token, Date.now())
    if (!record) return undefined

    const publicBase = this.buildProxyBasePath(token)
    let targetPath = incomingPath.startsWith(publicBase) ? incomingPath.slice(publicBase.length) : incomingPath
    if (!targetPath || targetPath === "/") {
      targetPath = record.target.pathname || "/"
    } else if (!targetPath.startsWith("/")) {
      targetPath = `/${targetPath}`
    }

    return new URL(`${targetPath}${search}`, record.target.origin)
  }

  buildProxyBasePath(token: string): string {
    return `/previews/${encodeURIComponent(token)}`
  }

  /** Clear every preview token; used on shutdown and on-demand. */
  clear(): void {
    this.previews.clear()
  }

  get size(): number {
    return this.previews.size
  }

  private touch(token: string, now: number): PreviewRecord | undefined {
    this.pruneExpired(now)
    const record = this.previews.get(token)
    if (!record) return undefined
    record.lastAccessedAt = now
    return record
  }

  private pruneExpired(now: number): void {
    for (const [token, record] of this.previews) {
      const age = now - Date.parse(record.createdAt)
      if (age >= this.absoluteTtlMs || now - record.lastAccessedAt >= this.idleTtlMs) {
        this.previews.delete(token)
      }
    }
  }

  private normalizeTargetUrl(rawUrl: string): URL {
    const trimmed = rawUrl.trim()
    const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
    const target = new URL(withProtocol)
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Preview URL must use HTTP or HTTPS")
    }
    if (target.username || target.password) {
      throw new Error("Preview URL cannot include credentials")
    }
    return target
  }

  private toPreviewSession(record: PreviewRecord): PreviewSession {
    return {
      token: record.token,
      sessionId: record.sessionId,
      targetUrl: record.target.toString(),
      proxyUrl: `${this.buildProxyBasePath(record.token)}${record.target.pathname}${record.target.search}${record.target.hash}`,
      createdAt: record.createdAt,
    }
  }
}
