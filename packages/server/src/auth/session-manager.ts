import crypto from "crypto"

export const DEFAULT_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_SESSION_LIMIT = 128

export interface SessionInfo {
  id: string
  createdAt: number
  lastAccessAt: number
  username: string
}

export interface SessionManagerOptions {
  idleTtlMs?: number
  absoluteTtlMs?: number
  maxSessions?: number
  now?: () => number
  createId?: () => string
}

interface SessionRecord extends SessionInfo {
  sequence: number
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly idleTtlMs: number
  private readonly absoluteTtlMs: number
  private readonly maxSessions: number
  private readonly now: () => number
  private readonly createId: () => string
  private nextSequence = 0

  constructor(options: SessionManagerOptions = {}) {
    this.idleTtlMs = requirePositiveInteger(
      options.idleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS,
      "idleTtlMs",
    )
    this.absoluteTtlMs = requirePositiveInteger(
      options.absoluteTtlMs ?? DEFAULT_SESSION_ABSOLUTE_TTL_MS,
      "absoluteTtlMs",
    )
    this.maxSessions = requirePositiveInteger(options.maxSessions ?? DEFAULT_SESSION_LIMIT, "maxSessions")
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? (() => crypto.randomBytes(32).toString("base64url"))
  }

  createSession(username: string): SessionInfo {
    const now = this.now()
    this.pruneExpired(now)
    while (this.sessions.size >= this.maxSessions) {
      this.evictOldest()
    }

    const id = this.createUniqueId()
    const record: SessionRecord = {
      id,
      createdAt: now,
      lastAccessAt: now,
      username,
      sequence: this.nextSequence++,
    }
    this.sessions.set(id, record)
    return toSessionInfo(record)
  }

  getSession(id: string | undefined): SessionInfo | undefined {
    if (!id) return undefined
    const now = this.now()
    this.pruneExpired(now)

    const record = this.sessions.get(id)
    if (!record) return undefined
    record.lastAccessAt = Math.max(record.lastAccessAt, now)
    return toSessionInfo(record)
  }

  revokeSession(id: string | undefined): boolean {
    if (!id) return false
    return this.sessions.delete(id)
  }

  revokeAllSessions(): void {
    this.sessions.clear()
  }

  getSessionCount(): number {
    this.pruneExpired(this.now())
    return this.sessions.size
  }

  private createUniqueId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.createId()
      if (id && !this.sessions.has(id)) {
        return id
      }
    }
    throw new Error("Unable to create a unique session ID")
  }

  private pruneExpired(now: number): void {
    for (const [id, record] of this.sessions) {
      if (now - record.lastAccessAt >= this.idleTtlMs || now - record.createdAt >= this.absoluteTtlMs) {
        this.sessions.delete(id)
      }
    }
  }

  private evictOldest(): void {
    let oldest: SessionRecord | undefined
    for (const record of this.sessions.values()) {
      if (!oldest || compareSessions(record, oldest) < 0) {
        oldest = record
      }
    }
    if (oldest) {
      this.sessions.delete(oldest.id)
    }
  }
}

function compareSessions(left: SessionRecord, right: SessionRecord): number {
  return (
    left.lastAccessAt - right.lastAccessAt ||
    left.createdAt - right.createdAt ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  )
}

function toSessionInfo(record: SessionRecord): SessionInfo {
  return {
    id: record.id,
    createdAt: record.createdAt,
    lastAccessAt: record.lastAccessAt,
    username: record.username,
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}
