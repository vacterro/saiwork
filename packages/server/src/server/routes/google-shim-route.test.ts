import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { registerGoogleShimRoutes } from "./google-shim"
import { ANTIGRAVITY_SHIM_API_KEY } from "../../google/adapter"
import type { AntigravityModelInfo, AntigravitySession } from "../../google/antigravity-session"

const liveModel = (id: string, displayName: string): AntigravityModelInfo => ({
  id,
  displayName,
  maxTokens: 1_048_576,
  maxOutputTokens: 65_536,
})

describe("google shim /v1/models", () => {
  it("serves a newly released backend model live", async () => {
    const app = Fastify({ logger: false })
    registerGoogleShimRoutes(app, {
      session: {
        listModels: async () => [liveModel("gemini-3.7-flash", "Gemini 3.7 Flash"), liveModel("gemini-pro-agent", "Gemini 3.1 Pro (High)")],
      } as unknown as AntigravitySession,
    })
    const response = await app.inject({ method: "GET", url: "/v1/models" })
    await app.close()
    assert.equal(response.statusCode, 200)
    const ids = response.json().data.map((model: { id: string }) => model.id)
    assert.ok(ids.includes("gemini-3.7-flash"), "a vendor-released model must be served by the shim")
  })

  it("falls back to the static catalog when the backend list fails", async () => {
    const app = Fastify({ logger: false })
    registerGoogleShimRoutes(app, {
      session: {
        listModels: async () => {
          throw new Error("no OAuth session")
        },
      } as unknown as AntigravitySession,
    })
    const response = await app.inject({ method: "GET", url: "/v1/models" })
    await app.close()
    assert.equal(response.statusCode, 200)
    const ids = response.json().data.map((model: { id: string }) => model.id)
    assert.ok(ids.includes("gemini-pro-agent"), "static catalog must stand in when the live fetch fails")
  })

  it("requires the shim bearer key for chat completions", async () => {
    const app = Fastify({ logger: false })
    registerGoogleShimRoutes(app)
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-session-id": "s1" },
      payload: { model: "gemini-pro-agent", messages: [{ role: "user", content: "hi" }] },
    })
    await app.close()
    assert.equal(response.statusCode, 401)
    void ANTIGRAVITY_SHIM_API_KEY
  })
})
