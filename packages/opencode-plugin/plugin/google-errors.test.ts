import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { maybeClassifyGoogleError, redactSecrets } from "./lib/google-errors.js"

function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; arg: unknown }> = []
  const client = {
    classifyGoogleError: async (payload: unknown) => {
      calls.push({ name: "classify", arg: payload })
      return overrides.classifyResult ?? { code: "FREE_TIER_QUOTA_EXCEEDED", providerId: "google_gemini_api", message: "normalized", retryable: false }
    },
    postEvent: async (event: unknown) => {
      calls.push({ name: "postEvent", arg: event })
    },
  }
  return { client, calls }
}

describe("maybeClassifyGoogleError", () => {
  it("classifies a free-tier google error and forwards the normalized event", async () => {
    const { client, calls } = fakeClient()
    const error = {
      name: "APIError",
      data: {
        message: "GenerateContentRequest.generate_content_free_tier_input_token_count exceeds the limit",
        statusCode: 429,
      },
    }
    await maybeClassifyGoogleError(error as never, client as never)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].name, "classify")
    const payload = calls[0].arg as { providerId: string }
    assert.equal(payload.providerId, "google_gemini_api")
    const event = calls[1].arg as { type: string; properties: { code: string } }
    assert.equal(event.type, "saiwork.googleError")
    assert.equal(event.properties.code, "FREE_TIER_QUOTA_EXCEEDED")
  })

  it("ignores non-google errors", async () => {
    const { client, calls } = fakeClient()
    await maybeClassifyGoogleError({ name: "APIError", data: { message: "some other provider failed" } } as never, client as never)
    assert.equal(calls.length, 0)
  })

  it("never throws, even when classification fails", async () => {
    const client = {
      classifyGoogleError: async () => { throw new Error("boom") },
      postEvent: async () => { throw new Error("boom") },
    }
    await maybeClassifyGoogleError({ data: { message: "google free_tier exceeded" } } as never, client as never)
  })

  it("redacts credentials from the logged message", async () => {
    const redacted = redactSecrets("key AIzaSyB1234567890123456789012345678 token ya29.abcdefg")
    assert.ok(!redacted.includes("AIzaSyB1234567890123456789012345678"))
    assert.ok(!redacted.includes("ya29.abcdefg"))
    assert.ok(redacted.includes("[REDACTED]"))
  })
})
