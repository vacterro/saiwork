import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"

import { registerGoogleRoutes } from "./google"
import { ANTIGRAVITY_PROVIDER_ID, GEMINI_API_PROVIDER_ID } from "../../google/types"

const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger }

function createApp(settingsOverrides: Record<string, unknown> = {}) {
  const app = Fastify({ logger: false })
  let settings: Record<string, unknown> = {
    settings: {
      allowProviderFallback: false,
      antigravityAcknowledged: false,
      ...settingsOverrides,
    },
  }
  const settingsService = {
    getOwner: (_kind: string, owner: string) => (owner === "ui" ? settings : {}),
    mergePatchOwner: (_kind: string, owner: string, patch: Record<string, unknown>) => {
      if (owner === "ui") {
        const merged = { ...settings, ...(patch.settings ? { settings: { ...(settings.settings as object), ...(patch.settings as object) } } : {}) }
        settings = merged
        return merged
      }
      return {}
    },
  }
  registerGoogleRoutes(app, { settings: settingsService as never, logger: logger as never })
  return app
}

describe("registerGoogleRoutes", () => {
  it("reports both google providers as distinct", async () => {
    const response = await createApp().inject({ method: "GET", url: "/api/google/providers" })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    const ids = body.providers.map((p: { id: string }) => p.id)
    assert.ok(ids.includes(GEMINI_API_PROVIDER_ID))
    assert.ok(ids.includes(ANTIGRAVITY_PROVIDER_ID))
    assert.equal(body.allowProviderFallback, false)
  })

  it("lists provider-scoped models", async () => {
    const response = await createApp().inject({ method: "GET", url: `/api/google/models?providerId=${GEMINI_API_PROVIDER_ID}` })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.providerId, GEMINI_API_PROVIDER_ID)
    for (const model of body.models) {
      assert.equal(model.providerId, GEMINI_API_PROVIDER_ID)
    }
  })

  it("classifies a free-tier error with the normalized message", async () => {
    const response = await createApp().inject({
      method: "POST",
      url: "/api/google/classify-error",
      payload: { providerId: GEMINI_API_PROVIDER_ID, message: "generate_content_free_tier_input_token_count exceeded" },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.code, "FREE_TIER_QUOTA_EXCEEDED")
    assert.match(body.message, /not your Google AI Pro \/ Antigravity quota/)
  })

  it("resolves gemini api to opencode google with api auth", async () => {
    const response = await createApp().inject({
      method: "POST",
      url: "/api/google/resolve",
      payload: { providerId: GEMINI_API_PROVIDER_ID, modelId: "gemini-3.1-pro-preview" },
    })
    assert.equal(response.statusCode, 200)
    const { resolution } = response.json()
    assert.equal(resolution.opencodeProvider, "google")
    assert.equal(resolution.authMode, "api")
  })

  it("persists google settings through the ui owner", async () => {
    const app = createApp()
    const response = await app.inject({
      method: "POST",
      url: "/api/google/settings",
      payload: { allowProviderFallback: true, antigravityAcknowledged: true },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().allowProviderFallback, true)
    assert.equal(response.json().antigravityAcknowledged, true)
    // Persisted: a second read reflects it.
    const reread = await app.inject({ method: "GET", url: "/api/google/providers" })
    assert.equal(reread.json().allowProviderFallback, true)
  })
})
