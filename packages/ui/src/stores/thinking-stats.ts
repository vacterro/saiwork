import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"
import {
  addReplyToBucket,
  dayKey,
  emptyBucket,
  pruneBuckets,
  totalsForRange,
  type ThinkingBuckets,
  type ThinkingRange,
  type ThinkingTotals,
} from "../lib/thinking-stats"

const log = getLogger("actions")

const STORAGE_KEY = "saiwork.thinking-stats.v1"

/**
 * Two years of day buckets is roughly 730 small objects -- small enough to keep
 * in localStorage, and it is the longest range the UI offers, so anything older
 * could never be displayed anyway.
 */
const RETENTION_DAYS = 760

/**
 * Replies already counted, so a re-render or a late event cannot double count.
 * Bounded: the store keeps only the ids it has seen this run, and a reply
 * counted in a previous run is already in the persisted bucket.
 */
const countedReplies = new Set<string>()

const [buckets, setBuckets] = createSignal<ThinkingBuckets>(loadPersisted())

function loadPersisted(): ThinkingBuckets {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ThinkingBuckets
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed
  } catch (error) {
    log.warn("Failed to restore thinking stats:", error)
    return {}
  }
}

function persist(next: ThinkingBuckets) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (error) {
    // A full quota must not take the session down: the stats are an extra, and
    // losing a day of them is cheaper than losing the reply that triggered it.
    log.warn("Failed to persist thinking stats:", error)
  }
}

export interface RecordedReply {
  /** Stable id for the reply, used to make recording idempotent. */
  replyId: string
  thinkingMs?: number
  tokens?: number
  toolCalls?: number
  /** True for the first reply of a session, so sessions can be counted. */
  newSession?: boolean
  at?: Date
}

export function recordReply(reply: RecordedReply): void {
  if (!reply.replyId || countedReplies.has(reply.replyId)) return
  countedReplies.add(reply.replyId)

  const at = reply.at ?? new Date()
  const key = dayKey(at)

  setBuckets((prev) => {
    const current = prev[key] ?? emptyBucket()
    const next: ThinkingBuckets = { ...prev, [key]: addReplyToBucket(current, reply) }
    const pruned = pruneBuckets(next, RETENTION_DAYS, at)
    persist(pruned)
    return pruned
  })
}

export function getThinkingTotals(range: ThinkingRange, now = new Date()): ThinkingTotals {
  return totalsForRange(buckets(), range, now)
}

export function getThinkingBuckets(): ThinkingBuckets {
  return buckets()
}

export function clearThinkingStats(): void {
  countedReplies.clear()
  setBuckets({})
  persist({})
}
