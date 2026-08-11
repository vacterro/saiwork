import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { fetchFreebuffQuota, parseSessionSnapshot } from "./quota"

const SNAPSHOT = {
  status: "none",
  accessTier: "limited",
  rateLimitsByModel: {
    "deepseek/deepseek-v4-flash": {
      model: "deepseek/deepseek-v4-flash",
      entitlementBreakdown: { base: 6, referral: 0, streak: 0 },
      limit: 6,
      period: "pacific_day",
      resetTimeZone: "America/Los_Angeles",
      resetAt: "2026-08-12T07:00:00.000Z",
      windowHours: 24,
      recentCount: 1.1,
    },
  },
  desktopSessionCounts: { premium: 1, unlimited: 0, nextExpiryAt: "2026-08-11T21:19:26.000Z" },
}

describe("parseSessionSnapshot", () => {
  it("extracts the quota fields SAIWORK renders", () => {
    const snapshot = parseSessionSnapshot(SNAPSHOT)
    assert.ok(snapshot)
    assert.equal(snapshot!.accessTier, "limited")
    assert.equal(snapshot!.rateLimitsByModel!["deepseek/deepseek-v4-flash"].limit, 6)
    assert.equal(snapshot!.rateLimitsByModel!["deepseek/deepseek-v4-flash"].recentCount, 1.1)
    assert.equal(snapshot!.rateLimitsByModel!["deepseek/deepseek-v4-flash"].resetAt, "2026-08-12T07:00:00.000Z")
    assert.equal(snapshot!.desktopSessionCounts!.premium, 1)
    assert.equal(snapshot!.desktopSessionCounts!.nextExpiryAt, "2026-08-11T21:19:26.000Z")
  })

  it("rejects non-session payloads", () => {
    assert.equal(parseSessionSnapshot({ hello: "world" }), null)
    assert.equal(parseSessionSnapshot(null), null)
  })

  it("tolerates malformed rate-limit entries without failing the snapshot", () => {
    const snapshot = parseSessionSnapshot({
      status: "none",
      accessTier: "limited",
      rateLimitsByModel: { bad: { limit: "nope" }, good: SNAPSHOT.rateLimitsByModel["deepseek/deepseek-v4-flash"] },
    })
    assert.ok(snapshot)
    assert.ok(snapshot!.rateLimitsByModel!.good)
    assert.equal(snapshot!.rateLimitsByModel!.bad, undefined)
  })
})

describe("fetchFreebuffQuota", () => {
  it("sends the read-only display headers and parses the response", async () => {
    let capturedUrl = ""
    let capturedInit: RequestInit | null | undefined = null
    const result = await fetchFreebuffQuota(() => "tok", {
      fetch: async (url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return new Response(JSON.stringify(SNAPSHOT), { status: 200 })
      },
    })
    assert.ok(result.snapshot)
    assert.equal(result.error, null)
    assert.ok(capturedUrl.endsWith("/api/v1/freebuff/session"))
    const headers = capturedInit!.headers as Record<string, string>
    assert.equal(headers["Authorization"], "Bearer tok")
    assert.equal(headers["x-freebuff-multi-session"], "1")
    assert.equal(headers["x-freebuff-include-unused-rate-limits"], "1")
  })

  it("reports unauthenticated when no token is available", async () => {
    const result = await fetchFreebuffQuota(() => null, { fetch: async () => new Response("{}") })
    assert.equal(result.configured, false)
    assert.equal(result.snapshot, null)
  })

  it("surfaces HTTP failures as errors", async () => {
    const result = await fetchFreebuffQuota(() => "tok", {
      fetch: async () => new Response("nope", { status: 429 }),
    })
    assert.equal(result.snapshot, null)
    assert.match(result.error ?? "", /429/)
  })

  it("surfaces network failures as errors", async () => {
    const result = await fetchFreebuffQuota(() => "tok", {
      fetch: async () => { throw new Error("ECONNRESET") },
    })
    assert.equal(result.snapshot, null)
    assert.match(result.error ?? "", /ECONNRESET/)
  })
})
