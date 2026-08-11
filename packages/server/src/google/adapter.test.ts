import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  resolveGoogleExecution,
  resolveGoogleFallback,
} from "./adapter"
import { googleModelsFor, scopedModelId } from "./models"
import {
  ANTIGRAVITY_PROVIDER_ID,
  GEMINI_API_PROVIDER_ID,
} from "./types"

describe("google adapter (execution boundary)", () => {
  it("maps gemini api to opencode google with api auth", () => {
    const resolution = resolveGoogleExecution(GEMINI_API_PROVIDER_ID, "gemini-3.1-pro-preview", {
      allowProviderFallback: false,
    })
    assert.equal(resolution.opencodeProvider, "google")
    assert.equal(resolution.opencodeModelId, "gemini-3.1-pro-preview")
    assert.equal(resolution.authMode, "api")
  })

  it("maps antigravity to opencode google with oauth auth", () => {
    const resolution = resolveGoogleExecution(ANTIGRAVITY_PROVIDER_ID, "gemini-3.1-pro-preview", {
      allowProviderFallback: false,
    })
    assert.equal(resolution.opencodeProvider, "google")
    assert.equal(resolution.opencodeModelId, "gemini-3.1-pro-preview")
    assert.equal(resolution.authMode, "oauth")
  })

  it("strips the provider prefix from scoped model ids", () => {
    const scoped = scopedModelId(GEMINI_API_PROVIDER_ID, "gemini-3.5-flash")
    const resolution = resolveGoogleExecution(GEMINI_API_PROVIDER_ID, scoped, {
      allowProviderFallback: false,
    })
    assert.equal(resolution.opencodeModelId, "gemini-3.5-flash")
  })

  it("blocks provider fallback by default", () => {
    const fallback = resolveGoogleFallback(GEMINI_API_PROVIDER_ID, "gemini-3.1-pro-preview", false)
    assert.equal(fallback, null)
    // In-provider resolution never crosses pools: gemini stays gemini, oauth
    // stays oauth. The only cross-pool path is resolveGoogleFallback, gated on
    // allowProviderFallback.
    const gemini = resolveGoogleExecution(GEMINI_API_PROVIDER_ID, "gemini-3.1-pro-preview", { allowProviderFallback: false })
    assert.equal(gemini.providerId, GEMINI_API_PROVIDER_ID)
    const antigravity = resolveGoogleExecution(ANTIGRAVITY_PROVIDER_ID, "gemini-3.1-pro-preview", { allowProviderFallback: false })
    assert.equal(antigravity.providerId, ANTIGRAVITY_PROVIDER_ID)
  })

  it("allows fallback only when explicitly enabled", () => {
    const fallback = resolveGoogleFallback(ANTIGRAVITY_PROVIDER_ID, "gemini-3.1-pro-preview", true)
    assert.ok(fallback)
    assert.equal(fallback!.providerId, GEMINI_API_PROVIDER_ID)
    assert.equal(fallback!.authMode, "api")
  })

  it("model catalogs are provider-scoped", () => {
    const geminiModels = googleModelsFor(GEMINI_API_PROVIDER_ID)
    const antigravityModels = googleModelsFor(ANTIGRAVITY_PROVIDER_ID)
    for (const model of geminiModels) {
      assert.equal(model.providerId, GEMINI_API_PROVIDER_ID)
    }
    for (const model of antigravityModels) {
      assert.equal(model.providerId, ANTIGRAVITY_PROVIDER_ID)
    }
  })
})
