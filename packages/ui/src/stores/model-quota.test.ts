import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { antigravityAvailabilityFrom, freebuffAvailabilityFrom } from "./model-quota"

describe("model quota availability", () => {
  it("marks a freebuff model exhausted when the daily turns are used up", () => {
    const snapshot = { rateLimitsByModel: { "mimo/mimo-v2.5": { model: "mimo/mimo-v2.5", limit: 6, recentCount: 6, resetAt: "2026-08-13T07:00:00Z", period: "pacific_day" } } }
    const exhausted = freebuffAvailabilityFrom(snapshot, "mimo/mimo-v2.5")
    assert.equal(exhausted.usable, false)
    assert.equal(exhausted.exhausted, true)
    assert.equal(exhausted.remainingLabel, "0/6")
    assert.equal(exhausted.resetAt, Date.parse("2026-08-13T07:00:00Z"))
  })

  it("shows remaining freebuff turns without float noise", () => {
    const snapshot = { rateLimitsByModel: { "mimo/mimo-v2.5": { model: "mimo/mimo-v2.5", limit: 6, recentCount: 4.6000000000000005, period: "pacific_day" } } }
    const available = freebuffAvailabilityFrom(snapshot, "mimo/mimo-v2.5")
    assert.equal(available.usable, true)
    assert.equal(available.exhausted, false)
    assert.equal(available.remainingLabel, "1.4/6")
  })

  it("treats unknown freebuff models as usable (no data yet)", () => {
    const available = freebuffAvailabilityFrom(null, "deepseek/deepseek-v4-flash")
    assert.equal(available.usable, true)
    assert.equal(available.known, false)
  })

  it("marks an antigravity model exhausted at zero percent", () => {
    const models = { "gemini-pro-agent": { remainingPercent: 0, resetAt: "2026-08-12T12:00:00Z" } }
    const exhausted = antigravityAvailabilityFrom(models, "gemini-pro-agent")
    assert.equal(exhausted.exhausted, true)
    assert.equal(exhausted.remainingLabel, "0%")
    assert.equal(exhausted.resetAt, Date.parse("2026-08-12T12:00:00Z"))
  })

  it("shows the antigravity remaining percent", () => {
    const models = { "gemini-3.6-flash-medium": { remainingPercent: 98, resetAt: null } }
    const available = antigravityAvailabilityFrom(models, "gemini-3.6-flash-medium")
    assert.equal(available.usable, true)
    assert.equal(available.remainingLabel, "98%")
    assert.equal(available.resetAt, undefined)
  })

  it("treats missing antigravity quota as usable", () => {
    assert.equal(antigravityAvailabilityFrom(null, "gemini-pro-agent").usable, true)
    assert.equal(antigravityAvailabilityFrom({ "x": { remainingPercent: null, resetAt: null } }, "gemini-pro-agent").usable, true)
  })
})
