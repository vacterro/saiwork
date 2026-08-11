import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { handlePluginEvent } from "./handlers"

const logger = { debug() {}, warn() {}, info() {}, error() {} }

describe("handlePluginEvent", () => {
  it("re-broadcasts normalized google errors without logging raw properties", async () => {
    const published: unknown[] = []
    const warned: Array<Record<string, unknown>> = []
    handlePluginEvent("ws-1", {
      type: "saiwork.googleError",
      properties: {
        providerId: "google_gemini_api",
        code: "FREE_TIER_QUOTA_EXCEEDED",
        message: "Gemini Developer API Free Tier quota exhausted.",
        retryable: false,
      },
    }, {
      workspaceManager: {} as never,
      eventBus: { publish: (event: unknown) => { published.push(event) } } as never,
      logger: { ...logger, warn: (data: Record<string, unknown>) => { warned.push(data) } } as never,
    })

    assert.equal(published.length, 1)
    const event = published[0] as { type: string; workspaceId: string; properties: Record<string, unknown> }
    assert.equal(event.type, "saiwork.googleError")
    assert.equal(event.workspaceId, "ws-1")
    assert.equal(event.properties.code, "FREE_TIER_QUOTA_EXCEEDED")
    // The warning only carries the code, never the message/credentials.
    assert.equal(warned.length, 1)
    assert.equal(warned[0].code, "FREE_TIER_QUOTA_EXCEEDED")
    assert.equal("message" in warned[0], false)
  })

  it("defaults unknown google errors to a safe code", async () => {
    const published: unknown[] = []
    handlePluginEvent("ws-1", { type: "saiwork.googleError", properties: {} }, {
      workspaceManager: {} as never,
      eventBus: { publish: (event: unknown) => { published.push(event) } } as never,
      logger: logger as never,
    })
    const event = published[0] as { properties: { code: string } }
    assert.equal(event.properties.code, "UNKNOWN_PROVIDER_ERROR")
  })
})
