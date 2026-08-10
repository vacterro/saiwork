import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  addReplyToBucket,
  averageThinkingMs,
  dayKey,
  emptyBucket,
  formatThinkingDuration,
  pruneBuckets,
  startOfWeek,
  totalsForRange,
  type ThinkingBuckets,
} from "./thinking-stats.ts"

function bucketWith(thinkingMs: number, replies = 1, extra: Partial<ReturnType<typeof emptyBucket>> = {}) {
  return { ...emptyBucket(), thinkingMs, replies, thinkingReplies: thinkingMs > 0 ? replies : 0, ...extra }
}

describe("thinking stats aggregation", () => {
  it("counts one reply with one thinking block", () => {
    const bucket = addReplyToBucket(emptyBucket(), { thinkingMs: 4_000, tokens: 120, toolCalls: 2 })
    assert.equal(bucket.thinkingMs, 4_000)
    assert.equal(bucket.replies, 1)
    assert.equal(bucket.thinkingReplies, 1)
    assert.equal(bucket.tokens, 120)
    assert.equal(bucket.toolCalls, 2)
  })

  it("sums several thinking blocks in one reply", () => {
    // The caller sums the parts; the bucket sees one reply carrying the total.
    const bucket = addReplyToBucket(emptyBucket(), { thinkingMs: 1_500 + 2_500 + 900 })
    assert.equal(bucket.thinkingMs, 4_900)
    assert.equal(bucket.replies, 1, "several blocks are still one reply")
    assert.equal(bucket.thinkingReplies, 1)
  })

  it("keeps the thinking an aborted reply managed before it stopped", () => {
    const bucket = addReplyToBucket(emptyBucket(), { thinkingMs: 2_200, tokens: 0 })
    assert.equal(bucket.thinkingMs, 2_200)
    assert.equal(bucket.replies, 1)
  })

  it("counts a reply that never thought without inflating the average", () => {
    let bucket = addReplyToBucket(emptyBucket(), { thinkingMs: 6_000 })
    bucket = addReplyToBucket(bucket, { thinkingMs: 0 })

    assert.equal(bucket.replies, 2)
    assert.equal(bucket.thinkingReplies, 1)
    assert.equal(averageThinkingMs({ ...bucket, activeDays: 1 }), 6_000)
  })

  it("ignores negative and non-finite input", () => {
    const bucket = addReplyToBucket(emptyBucket(), { thinkingMs: -5, tokens: -100, toolCalls: -1 })
    assert.equal(bucket.thinkingMs, 0)
    assert.equal(bucket.tokens, 0)
    assert.equal(bucket.toolCalls, 0)
    assert.equal(bucket.thinkingReplies, 0)
  })
})

describe("thinking stats rollups", () => {
  // Wednesday. ISO week runs Mon 2026-08-03 .. Sun 2026-08-09.
  const now = new Date(2026, 7, 5, 12, 0, 0)

  const buckets: ThinkingBuckets = {
    "2026-08-05": bucketWith(3_600_000), // today
    "2026-08-03": bucketWith(1_800_000), // Monday, same ISO week
    "2026-08-02": bucketWith(600_000), // Sunday, previous ISO week, same month
    "2026-07-20": bucketWith(900_000), // previous month, same year
    "2025-12-31": bucketWith(120_000), // previous year
  }

  it("rolls up day, week, month, year and all", () => {
    assert.equal(totalsForRange(buckets, "day", now).thinkingMs, 3_600_000)
    assert.equal(totalsForRange(buckets, "week", now).thinkingMs, 3_600_000 + 1_800_000)
    assert.equal(totalsForRange(buckets, "month", now).thinkingMs, 3_600_000 + 1_800_000 + 600_000)
    assert.equal(totalsForRange(buckets, "year", now).thinkingMs, 3_600_000 + 1_800_000 + 600_000 + 900_000)
    assert.equal(totalsForRange(buckets, "all", now).thinkingMs, 3_600_000 + 1_800_000 + 600_000 + 900_000 + 120_000)
  })

  it("counts active days rather than calendar days", () => {
    assert.equal(totalsForRange(buckets, "month", now).activeDays, 3)
    assert.equal(totalsForRange(buckets, "day", now).activeDays, 1)
  })

  it("excludes days after today, so a clock skew cannot leak into a total", () => {
    const withFuture = { ...buckets, "2026-08-09": bucketWith(999_000) }
    assert.equal(totalsForRange(withFuture, "week", now).thinkingMs, 3_600_000 + 1_800_000)
  })

  it("starts the week on Monday", () => {
    assert.equal(dayKey(startOfWeek(now)), "2026-08-03")
    // Sunday belongs to the week that started the previous Monday.
    assert.equal(dayKey(startOfWeek(new Date(2026, 7, 9))), "2026-08-03")
  })

  it("prunes buckets older than the retention window", () => {
    const kept = pruneBuckets(buckets, 30, now)
    assert.ok(kept["2026-08-05"], "today survives")
    assert.ok(kept["2026-07-20"], "16 days back survives a 30 day window")
    assert.equal(kept["2025-12-31"], undefined, "last year is dropped")
  })
})

describe("thinking duration formatting", () => {
  it("uses at most two units", () => {
    assert.equal(formatThinkingDuration(0), "0s")
    assert.equal(formatThinkingDuration(320), "320ms")
    assert.equal(formatThinkingDuration(9_400), "9.4s")
    assert.equal(formatThinkingDuration(43_000), "43s")
    assert.equal(formatThinkingDuration(843_000), "14m 03s")
    assert.equal(formatThinkingDuration(8_040_000), "2h 14m")
  })

  it("survives nonsense input", () => {
    assert.equal(formatThinkingDuration(-1), "0s")
    assert.equal(formatThinkingDuration(Number.NaN), "0s")
  })
})
