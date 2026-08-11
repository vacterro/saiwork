import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { FreebuffController } from "./controller"
import type { FreebuffEngineManager, FreebuffEngineStatus } from "./engine"

const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger }

function fakeEngineManager(port: number | null): FreebuffEngineManager {
  let ready = port !== null
  const status = (): FreebuffEngineStatus => ({
    installFound: true,
    engineRunning: ready,
    ready,
    port: ready ? port : null,
    root: "C:/freebuff",
    auth: { token: "tok", user: { id: "u1" } },
    error: null,
  })
  const manager = {
    get status() {
      return status()
    },
    start: async () => {
      ready = true
      return status()
    },
    stop: async () => {
      ready = false
    },
  }
  return manager as unknown as FreebuffEngineManager
}

function sseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

const threadEvent = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  type: "thread",
  threadId: id,
  thread: { id, status, projectId: "P:/proj", updatedAt: 1, ...extra },
  items: [],
})

describe("FreebuffController thread registry", () => {
  it("mirrors open threads from the engine event stream", async () => {
    const originalFetch = globalThis.fetch
    const frames = [
      { type: "auth", authed: true },
      threadEvent("t1", "open", { title: "Alpha" }),
      threadEvent("t2", "open", { title: "Beta" }),
      threadEvent("t3", "closed", { title: "Gone" }),
    ]
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      if (url.endsWith("/api/events")) return sseResponse(frames)
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    try {
      const controller = new FreebuffController({
        engineManager: fakeEngineManager(19_001),
        logger: logger as never,
      })
      await controller.ensureRunning()
      // Let the async event subscription drain.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const threads = controller.listThreads()
      assert.equal(threads.length, 2)
      assert.deepEqual(threads.map((t) => t.id).sort(), ["t1", "t2"])
      assert.ok(!threads.some((t) => t.id === "t3"))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("clears the registry on stop", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      if (url.endsWith("/api/events")) return sseResponse([threadEvent("t1", "open")])
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    try {
      const controller = new FreebuffController({
        engineManager: fakeEngineManager(19_002),
        logger: logger as never,
      })
      await controller.ensureRunning()
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(controller.listThreads().length, 1)
      await controller.stop()
      assert.equal(controller.listThreads().length, 0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
