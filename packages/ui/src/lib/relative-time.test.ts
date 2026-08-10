import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { formatRelativeTime } from "./relative-time.ts"

const t = (key: string, params?: Record<string, unknown>) => {
  const count = typeof params?.count === "number" ? String(params.count) : ""
  return `${key}${count ? `:${count}` : ""}`
}

describe("formatRelativeTime", () => {
  it("labels just-now under a minute", () => {
    assert.equal(formatRelativeTime(1_000, 1_500, t), "time.relative.justNow")
  })

  it("labels minutes, hours and days", () => {
    assert.equal(formatRelativeTime(1_000, 61_000, t), "time.relative.minutesAgoShort:1")
    assert.equal(formatRelativeTime(1_000, 3_601_000, t), "time.relative.hoursAgoShort:1")
    assert.equal(formatRelativeTime(1_000, 172_801_000, t), "time.relative.daysAgoShort:2")
  })

  it("is monotonic in elapsed time", () => {
    const minutes = formatRelativeTime(1_000, 5_000_000, t)
    const hours = formatRelativeTime(1_000, 60_000_000, t)
    const days = formatRelativeTime(1_000, 200_000_000, t)
    assert.notEqual(minutes, hours)
    assert.notEqual(hours, days)
  })
})
