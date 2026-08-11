import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  classifyGoogleError,
  isRetryableGoogleErrorCode,
} from "./errors"
import { ANTIGRAVITY_PROVIDER_ID, GEMINI_API_PROVIDER_ID } from "./types"

const FREE_TIER_STDERR_FIXTURE = `Error: 429 RESOURCE_EXHAUSTED
{
  "error": {
    "code": 429,
    "message": "GenerateContentRequest.generate_content_free_tier_input_token_count[2] exceeds the limit of 5000.",
    "status": "RESOURCE_EXHAUSTED"
  }
}`

describe("classifyGoogleError", () => {
  it("classifies the free-tier fixture as Gemini API free-tier quota, not Antigravity", () => {
    const result = classifyGoogleError(GEMINI_API_PROVIDER_ID, { message: FREE_TIER_STDERR_FIXTURE })
    assert.equal(result.code, "FREE_TIER_QUOTA_EXCEEDED")
    assert.equal(result.providerId, GEMINI_API_PROVIDER_ID)
    assert.match(result.message, /Free Tier quota exhausted/)
    assert.match(result.message, /not your Google AI Pro \/ Antigravity quota/)
    // The key fix is billing, not rotating the key.
    assert.match(result.message, /Google AI Studio billing/)
    assert.equal(result.retryable, false)
  })

  it("classifies free-tier even when reported through the Antigravity provider id", () => {
    // A free-tier failure is a Gemini Developer API fact regardless of which
    // SAIWORK provider label the session used; it must never be mislabeled as
    // an Antigravity quota error.
    const result = classifyGoogleError(ANTIGRAVITY_PROVIDER_ID, {
      message: "generate_content_free_tier_input_token_count exceeded",
    })
    assert.equal(result.code, "FREE_TIER_QUOTA_EXCEEDED")
    assert.equal(result.providerId, ANTIGRAVITY_PROVIDER_ID)
  })

  it("classifies a plain quota error against the correct provider pool", () => {
    const gemini = classifyGoogleError(GEMINI_API_PROVIDER_ID, { status: 429, message: "rate limit exceeded" })
    assert.equal(gemini.code, "PAID_API_QUOTA_EXCEEDED")

    const antigravity = classifyGoogleError(ANTIGRAVITY_PROVIDER_ID, { status: 429, message: "quota" })
    assert.equal(antigravity.code, "ANTIGRAVITY_QUOTA_EXCEEDED")
  })

  it("classifies auth failures by provider", () => {
    const gemini = classifyGoogleError(GEMINI_API_PROVIDER_ID, { status: 401, message: "invalid API key" })
    assert.equal(gemini.code, "INVALID_API_KEY")

    const antigravity = classifyGoogleError(ANTIGRAVITY_PROVIDER_ID, { status: 403, message: "unauthorized" })
    assert.equal(antigravity.code, "AUTH_REQUIRED")
  })

  it("classifies model and network failures", () => {
    const model = classifyGoogleError(GEMINI_API_PROVIDER_ID, { message: "model gemini-9 not found" })
    assert.equal(model.code, "MODEL_UNAVAILABLE")

    const network = classifyGoogleError(GEMINI_API_PROVIDER_ID, { message: "fetch failed: ECONNRESET" })
    assert.equal(network.code, "NETWORK_ERROR")
    assert.equal(network.retryable, true)
  })

  it("only marks transient classes retryable", () => {
    assert.equal(isRetryableGoogleErrorCode("NETWORK_ERROR"), true)
    assert.equal(isRetryableGoogleErrorCode("PROVIDER_UNAVAILABLE"), true)
    assert.equal(isRetryableGoogleErrorCode("FREE_TIER_QUOTA_EXCEEDED"), false)
    assert.equal(isRetryableGoogleErrorCode("PAID_API_QUOTA_EXCEEDED"), false)
  })
})
