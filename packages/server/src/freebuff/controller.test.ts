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

  it("freeSlotFor closes sibling slot holders but never the target", async () => {
    const originalFetch = globalThis.fetch
    const closed: string[] = []
    const stateEvent = {
      type: "state",
      snapshot: {
        sessions: {
          activeSessionsByThread: {
            t1: { model: "deepseek/deepseek-v4-flash" },
            t2: { model: "mimo/mimo-v2.5" },
            t3: { model: "deepseek/deepseek-v4-flash" },
          },
        },
      },
    }
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      if (url.endsWith("/api/events")) return sseResponse([stateEvent])
      if (url.includes("/api/thread/") && init?.method === "POST") {
        const match = /\/api\/thread\/([^/]+)\/close/.exec(url)
        if (match) closed.push(match[1])
        return new Response("{}", { status: 200 })
      }
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    try {
      const controller = new FreebuffController({
        engineManager: fakeEngineManager(19_003),
        logger: logger as never,
      })
      await controller.ensureRunning()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await controller.freeSlotFor("t2", { waitMs: 0 })
      assert.deepEqual(closed.sort(), ["t1", "t3"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("freeSlotFor never closes a holder that is currently running a turn", async () => {
    const originalFetch = globalThis.fetch
    const closed: string[] = []
    const stateEvent = {
      type: "state",
      snapshot: {
        sessions: {
          activeSessionsByThread: {
            t1: { model: "deepseek/deepseek-v4-flash" },
            t2: { model: "mimo/mimo-v2.5" },
          },
        },
      },
    }
    const runningHolder = threadEvent("t1", "open", { turnState: "running", updatedAt: 1 })
    const idleHolder = threadEvent("t2", "open", { updatedAt: 1 })
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      if (url.endsWith("/api/events")) return sseResponse([stateEvent, runningHolder, idleHolder])
      if (url.includes("/api/thread/") && init?.method === "POST") {
        const match = /\/api\/thread\/([^/]+)\/close/.exec(url)
        if (match) closed.push(match[1])
        return new Response("{}", { status: 200 })
      }
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    try {
      const controller = new FreebuffController({
        engineManager: fakeEngineManager(19_005),
        logger: logger as never,
      })
      await controller.ensureRunning()
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Free the slot for a third thread; the running t1 must survive so its
      // long turn is not destroyed, while the idle t2 slot is released.
      await controller.freeSlotFor("t3", { waitMs: 0 })
      assert.deepEqual(closed, ["t2"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("closes only open threads idle past the threshold", async () => {
    const originalFetch = globalThis.fetch
    const closed: string[] = []
    const now = 1_800_000_000_000
    const oldThread = threadEvent("idle-old", "open", { updatedAt: now - 10 * 60_000 })
    const freshThread = threadEvent("fresh", "open", { updatedAt: now - 60_000 })
    const runningThread = threadEvent("running", "open", { updatedAt: now - 20 * 60_000, turnState: "running" })
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input)
      if (url.endsWith("/api/events")) return sseResponse([oldThread, freshThread, runningThread])
      if (url.includes("/api/thread/") && init?.method === "POST") {
        const match = /\/api\/thread\/([^/]+)\/close/.exec(url)
        if (match) closed.push(match[1])
        return new Response("{}", { status: 200 })
      }
      return new Response("{}", { status: 200 })
    }) as typeof fetch

    try {
      const controller = new FreebuffController({
        engineManager: fakeEngineManager(19_004),
        logger: logger as never,
        idleCloseMs: 6 * 60_000,
        now: () => now,
      })
      await controller.ensureRunning()
      await new Promise((resolve) => setTimeout(resolve, 50))
      await controller.sweepIdleThreadsNow()
      // Only the old idle thread is closed; the fresh and running ones survive.
      assert.deepEqual(closed, ["idle-old"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
