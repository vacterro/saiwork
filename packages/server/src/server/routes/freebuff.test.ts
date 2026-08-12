import assert from "node:assert/strict"
import { describe, it } from "node:test"
import Fastify from "fastify"

import { registerFreebuffRoutes } from "./freebuff"
import type { FreebuffController } from "../../freebuff/controller"
import type { FreebuffClient } from "../../freebuff/client"

const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger }

function fakeClient(): FreebuffClient {
  return {
    baseUrl: "http://127.0.0.1:19000",
    authStatus: async () => ({ authed: true }),
    listThreads: async () => [{ id: "t1", status: "open" }],
    getThread: async (id: string) => ({ id, status: "open" }),
    createThread: async (params: { projectPath: string }) => ({ id: "created", ...params }),
    postMessage: async () => ({ ok: true }),
    enqueue: async () => ({ id: "item1", threadId: "t1" }),
    sendNow: async () => ({ ok: true }),
    stopThread: async () => ({ ok: true }),
    resumeThread: async () => ({ ok: true }),
    listProjects: async () => [],
    subscribeEvents: async () => () => {},
  } as unknown as FreebuffClient
}

function createApp(overrides: Partial<{ client: FreebuffClient | null; status: Record<string, unknown> }> = {}) {
  const app = Fastify({ logger: false })
  const controller = {
    status: () => overrides.status ?? { installFound: true, engineRunning: true, ready: true, port: 19_000, root: null, auth: null, error: null },
    ensureRunning: async () => overrides.status ?? { installFound: true, engineRunning: true, ready: true, port: 19_000, root: null, auth: null, error: null },
    client: () => overrides.client === undefined ? fakeClient() : overrides.client,
    auth: () => null,
    quota: async () => ({ configured: true, snapshot: null, error: null }),
    stop: async () => {},
    freeSlotFor: async () => {},
    releaseSlotNow: async () => ({ closedThreads: 1, slotFree: true, sessionsActive: 0, note: null }),
  } as unknown as FreebuffController
  registerFreebuffRoutes(app, { freebuff: controller, logger: logger as never })
  return app
}

describe("registerFreebuffRoutes", () => {
  it("lists the FreeBuff model catalog", async () => {
    const response = await createApp().inject({ method: "GET", url: "/api/freebuff/models" })
    assert.equal(response.statusCode, 200)
    const ids = response.json().models.map((model: { id: string }) => model.id)
    assert.ok(ids.includes("deepseek/deepseek-v4-flash"))
    assert.ok(ids.includes("mimo/mimo-v2.5"))
  })

  it("reports engine status including quota", async () => {
    const response = await createApp().inject({ method: "GET", url: "/api/freebuff/status" })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.engineRunning, true)
    assert.equal(body.quota.configured, true)
  })

  it("creates a thread with the codebuff harness", async () => {
    const response = await createApp().inject({
      method: "POST",
      url: "/api/freebuff/threads",
      payload: { projectPath: "C:/proj", model: "deepseek/deepseek-v4-flash" },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().id, "created")
  })

  it("validates thread creation bodies", async () => {
    const response = await createApp().inject({
      method: "POST",
      url: "/api/freebuff/threads",
      payload: {},
    })
    assert.equal(response.statusCode, 400)
  })

  it("dispatches a prompt to a thread", async () => {
    const response = await createApp().inject({
      method: "POST",
      url: "/api/freebuff/threads/t1/message",
      payload: { text: "fix the build" },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
  })

  it("returns 503 when the engine is not running", async () => {
    const app = createApp({ client: null, status: { installFound: true, engineRunning: false, ready: false, port: null, root: null, auth: null, error: "not ready" } })
    const response = await app.inject({ method: "GET", url: "/api/freebuff/threads" })
    assert.equal(response.statusCode, 503)
  })

  it("runs the explicit slot-release sweep", async () => {
    const response = await createApp().inject({ method: "POST", url: "/api/freebuff/release-slot" })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { closedThreads: 1, slotFree: true, sessionsActive: 0, note: null })
  })

  it("returns 503 for release-slot when the engine is not running", async () => {
    const app = createApp({ client: null, status: { installFound: true, engineRunning: false, ready: false, port: null, root: null, auth: null, error: "not ready" } })
    const response = await app.inject({ method: "POST", url: "/api/freebuff/release-slot" })
    assert.equal(response.statusCode, 503)
  })
})
