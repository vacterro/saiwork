/**
 * Rollups for how long the agent actually spent thinking.
 *
 * Storage is one bucket per calendar day, keyed `YYYY-MM-DD`. Day buckets are
 * the smallest unit anyone asked to see and they roll up into week, month and
 * year by prefix or by range -- storing per-reply rows instead would grow
 * without bound for a number nobody reads at that resolution.
 *
 * Everything here is pure. The store owns persistence; these functions own the
 * arithmetic, so the arithmetic can be tested without touching localStorage.
 */

export interface ThinkingDayBucket {
  /** Milliseconds the agent spent inside reasoning parts. */
  thinkingMs: number
  /** Assistant replies counted. */
  replies: number
  /** Replies that carried at least one reasoning part. */
  thinkingReplies: number
  tokens: number
  toolCalls: number
  /** Distinct sessions seen on this day. */
  sessions: number
}

export type ThinkingBuckets = Record<string, ThinkingDayBucket>

export type ThinkingRange = "day" | "week" | "month" | "year" | "all"

export interface ThinkingTotals extends ThinkingDayBucket {
  /** Days in the range that recorded anything at all. */
  activeDays: number
}

export function emptyBucket(): ThinkingDayBucket {
  return { thinkingMs: 0, replies: 0, thinkingReplies: 0, tokens: 0, toolCalls: 0, sessions: 0 }
}

export function dayKey(at: Date): string {
  const year = at.getFullYear()
  const month = `${at.getMonth() + 1}`.padStart(2, "0")
  const day = `${at.getDate()}`.padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Start of the ISO week (Monday). The alternative -- "the last seven days" --
 * makes "this week" mean something different every time you look at it.
 */
export function startOfWeek(at: Date): Date {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  // getDay(): 0 is Sunday, so Sunday is 6 days into the ISO week.
  const isoDayIndex = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - isoDayIndex)
  return start
}

export function rangeStart(range: ThinkingRange, now: Date): Date | null {
  switch (range) {
    case "day":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate())
    case "week":
      return startOfWeek(now)
    case "month":
      return new Date(now.getFullYear(), now.getMonth(), 1)
    case "year":
      return new Date(now.getFullYear(), 0, 1)
    case "all":
      return null
  }
}

/**
 * Sums the day buckets that fall inside the range.
 *
 * `sessions` is summed rather than deduplicated across days on purpose: a
 * session worked on across three days is three days of work, and the store
 * cannot tell otherwise without keeping every session id forever.
 */
export function totalsForRange(buckets: ThinkingBuckets, range: ThinkingRange, now = new Date()): ThinkingTotals {
  const start = rangeStart(range, now)
  const startKey = start ? dayKey(start) : null
  const endKey = dayKey(now)

  const totals: ThinkingTotals = { ...emptyBucket(), activeDays: 0 }

  for (const [key, bucket] of Object.entries(buckets)) {
    if (startKey && key < startKey) continue
    if (key > endKey) continue

    totals.thinkingMs += bucket.thinkingMs
    totals.replies += bucket.replies
    totals.thinkingReplies += bucket.thinkingReplies
    totals.tokens += bucket.tokens
    totals.toolCalls += bucket.toolCalls
    totals.sessions += bucket.sessions
    totals.activeDays += 1
  }

  return totals
}

/** Mean thinking time per reply that actually thought, in ms. 0 when none did. */
export function averageThinkingMs(totals: ThinkingTotals): number {
  if (totals.thinkingReplies === 0) return 0
  return Math.round(totals.thinkingMs / totals.thinkingReplies)
}

/**
 * `2h 14m`, `14m 03s`, `9.4s`, `320ms`.
 *
 * Two units at most: the third is never the reason anyone looked.
 */
export function formatThinkingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  if (ms < 1000) return `${Math.round(ms)}ms`

  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${`${minutes}`.padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${`${seconds}`.padStart(2, "0")}s`
  if (totalSeconds < 10) return `${(ms / 1000).toFixed(1)}s`
  return `${totalSeconds}s`
}

/**
 * Merges one reply into a day bucket.
 *
 * An aborted reply still counts as a reply and still contributes whatever
 * thinking it managed before it stopped -- the time was spent either way, and
 * dropping it would make the totals quietly optimistic.
 */
export function addReplyToBucket(
  bucket: ThinkingDayBucket,
  reply: { thinkingMs?: number; tokens?: number; toolCalls?: number; newSession?: boolean },
): ThinkingDayBucket {
  const thinkingMs = Math.max(0, Math.round(reply.thinkingMs ?? 0))
  return {
    thinkingMs: bucket.thinkingMs + thinkingMs,
    replies: bucket.replies + 1,
    thinkingReplies: bucket.thinkingReplies + (thinkingMs > 0 ? 1 : 0),
    tokens: bucket.tokens + Math.max(0, Math.round(reply.tokens ?? 0)),
    toolCalls: bucket.toolCalls + Math.max(0, Math.round(reply.toolCalls ?? 0)),
    sessions: bucket.sessions + (reply.newSession ? 1 : 0),
  }
}

/** Drops buckets older than `keepDays` so the record cannot grow forever. */
export function pruneBuckets(buckets: ThinkingBuckets, keepDays: number, now = new Date()): ThinkingBuckets {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cutoff.setDate(cutoff.getDate() - keepDays)
  const cutoffKey = dayKey(cutoff)

  const kept: ThinkingBuckets = {}
  for (const [key, bucket] of Object.entries(buckets)) {
    if (key >= cutoffKey) kept[key] = bucket
  }
  return kept
}
