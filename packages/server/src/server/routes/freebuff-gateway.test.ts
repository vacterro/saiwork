import assert from "node:assert/strict"
import Fastify from "fastify"
import { describe, it } from "node:test"

import { FREEBUFF_SHIM_API_KEY, registerFreebuffGatewayRoutes, runTurnWithSlotRetry } from "./freebuff-gateway"
import type { FreebuffClient } from "../../freebuff/client"
import type { FreebuffController } from "../../freebuff/controller"

function fakeClient(postImpl: () => Promise<unknown>): { client: FreebuffClient; emit: (event: unknown) => void } {
  let emitFn: ((event: unknown) => void) | null = null
  const client = {
    baseUrl: "http://127.0.0.1:18000",
    postMessage: postImpl,
    stopThread: async () => ({ ok: true }),
    closeThread: async () => ({ id: "t-1" }),
    subscribeEvents: (onEvent: (event: unknown) => void) => {
      emitFn = onEvent
      return Promise.resolve(() => {
        emitFn = null
      })
    },
  } as unknown as FreebuffClient
  return {
    client,
    emit: (event: unknown) => emitFn?.(event),
  }
}

const fakeController = (): FreebuffController => ({
  freeSlotFor: async () => {},
} as unknown as FreebuffController)

describe("freebuff gateway slot retry", () => {
  it("waits out a held slot and succeeds once the admission lands", async () => {
    let posts = 0
    const { client, emit } = fakeClient(async () => {
      posts += 1
      if (posts < 3) {
        throw new Error("Freebuff is limited to one tab at a time on your network. Close the other hosted-model tab and try again.")
      }
      return { ok: true }
    })

    const steps: string[] = []
    const turnPromise = runTurnWithSlotRetry(fakeController(), client, "t-1", "hello", () => {}, {
      onStep: (delta) => steps.push(delta),
      slotRetry: { attempts: 4, waitMs: 5 },
    })

    // Drive the successful third attempt to completion.
    await new Promise((resolve) => setTimeout(resolve, 250))
    while (posts < 3) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "running", status: "open" } })
    emit({ type: "agent", threadId: "t-1", seq: 1, event: { type: "text", text: "admitted" } })
    emit({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "idle", status: "open" } })

    const text = await turnPromise
    assert.equal(text, "admitted")
    assert.ok(posts >= 3, `expected at least 3 postMessage attempts, got ${posts}`)
    assert.deepEqual(steps, ["> waiting for the FreeBuff slot (another tab is holding it)…"])
  })

  it("fails with a no-quota-consumed message after retries are exhausted", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("Freebuff is limited to one tab at a time on your network. Close the other hosted-model tab and try again.")
    })

    const turnPromise = runTurnWithSlotRetry(fakeController(), client, "t-1", "hello", () => {}, {
      slotRetry: { attempts: 2, waitMs: 5 },
    })
    await assert.rejects(turnPromise, /No FreeBuff quota was consumed/)
  })

  it("does not retry non-slot engine errors", async () => {
    let posts = 0
    const { client } = fakeClient(async () => {
      posts += 1
      throw new Error("quota exhausted")
    })

    const turnPromise = runTurnWithSlotRetry(fakeController(), client, "t-1", "hello", () => {}, {
      slotRetry: { attempts: 4, waitMs: 5 },
    })
    await assert.rejects(turnPromise, /quota exhausted/)
    assert.equal(posts, 1)
  })

  it("a stale post-turn close never closes a thread reused by a newer turn", async () => {
    const closed: string[] = []
    const handlers: Array<(event: unknown) => void> = []
    const client = {
      baseUrl: "http://127.0.0.1:18000",
      postMessage: async () => ({ ok: true }),
      stopThread: async () => ({ ok: true }),
      closeThread: async (threadId: string) => {
        closed.push(threadId)
        return { id: threadId }
      },
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        handlers.push(onEvent)
        return Promise.resolve(() => {})
      },
    } as unknown as FreebuffClient
    const emit = (event: unknown) => {
      for (const handler of handlers) handler(event)
    }

    // Turn A completes and schedules its 750ms post-turn close.
    const turnA = runTurnWithSlotRetry(fakeController(), client, "t-gen", "hello", () => {}, {
      slotRetry: { attempts: 1, waitMs: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-gen", thread: { id: "t-gen", turnState: "running", status: "open" } })
    emit({ type: "thread", threadId: "t-gen", thread: { id: "t-gen", turnState: "idle", status: "open" } })
    await turnA

    // Turn B reuses the same thread quickly, bumping the generation.
    const turnB = runTurnWithSlotRetry(fakeController(), client, "t-gen", "again", () => {}, {
      slotRetry: { attempts: 1, waitMs: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-gen", thread: { id: "t-gen", turnState: "running", status: "open" } })

    // A's close timer fires while B is still running: it MUST stand down.
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.deepEqual(closed, [])

    // B completes; its own close fires and is the only one that closes.
    emit({ type: "thread", threadId: "t-gen", thread: { id: "t-gen", turnState: "idle", status: "open" } })
    await turnB
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.deepEqual(closed, ["t-gen"])
  })

  it("a closeThread failure does not leak an unhandled rejection", async () => {
    const handlers: Array<(event: unknown) => void> = []
    const client = {
      baseUrl: "http://127.0.0.1:18000",
      postMessage: async () => ({ ok: true }),
      stopThread: async () => ({ ok: true }),
      closeThread: async () => {
        throw new Error("engine gone")
      },
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        handlers.push(onEvent)
        return Promise.resolve(() => {})
      },
    } as unknown as FreebuffClient
    const emit = (event: unknown) => {
      for (const handler of handlers) handler(event)
    }

    const turnPromise = runTurnWithSlotRetry(fakeController(), client, "t-close-fail", "hello", () => {}, {
      slotRetry: { attempts: 1, waitMs: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-close-fail", thread: { id: "t-close-fail", turnState: "running", status: "open" } })
    emit({ type: "thread", threadId: "t-close-fail", thread: { id: "t-close-fail", turnState: "idle", status: "open" } })
    const text = await turnPromise
    assert.equal(text, "")
    await new Promise((resolve) => setTimeout(resolve, 900))
  })

  it("waits for an already-started stale close before reopening a thread", async () => {
    const handlers: Array<(event: unknown) => void> = []
    let releaseClose!: () => void
    let posts = 0
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve })
    const client = {
      baseUrl: "http://127.0.0.1:18000",
      postMessage: async () => { posts += 1; return { ok: true } },
      stopThread: async () => ({ ok: true }),
      closeThread: async () => { await closeGate; return { id: "t-close-race" } },
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        handlers.push(onEvent)
        return Promise.resolve(() => {})
      },
    } as unknown as FreebuffClient
    const emit = (event: unknown) => { for (const handler of handlers) handler(event) }

    const first = runTurnWithSlotRetry(fakeController(), client, "t-close-race", "first", () => {}, {
      slotRetry: { attempts: 1, waitMs: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-close-race", thread: { id: "t-close-race", turnState: "running" } })
    emit({ type: "thread", threadId: "t-close-race", thread: { id: "t-close-race", turnState: "idle" } })
    await first
    await new Promise((resolve) => setTimeout(resolve, 800))

    const second = runTurnWithSlotRetry(fakeController(), client, "t-close-race", "second", () => {}, {
      slotRetry: { attempts: 1, waitMs: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(posts, 1)
    releaseClose()
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(posts, 2)
    emit({ type: "thread", threadId: "t-close-race", thread: { id: "t-close-race", turnState: "running" } })
    emit({ type: "thread", threadId: "t-close-race", thread: { id: "t-close-race", turnState: "idle" } })
    await second
  })

  it("bounds a hung close instead of blocking every later reopen forever", async () => {
    const handlers: Array<(event: unknown) => void> = []
    let posts = 0
    let releaseClose!: () => void
    const client = {
      baseUrl: "http://127.0.0.1:18000",
      postMessage: async () => { posts += 1; return { ok: true } },
      stopThread: async () => ({ ok: true }),
      closeThread: async () => new Promise<{ id: string }>((resolve) => { releaseClose = () => resolve({ id: "t-close-hung" }) }),
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        handlers.push(onEvent)
        return Promise.resolve(() => {})
      },
    } as unknown as FreebuffClient
    const emit = (event: unknown) => { for (const handler of handlers) handler(event) }

    const first = runTurnWithSlotRetry(fakeController(), client, "t-close-hung", "first", () => {}, {
      slotRetry: { attempts: 1, waitMs: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-close-hung", thread: { id: "t-close-hung", turnState: "running" } })
    emit({ type: "thread", threadId: "t-close-hung", thread: { id: "t-close-hung", turnState: "idle" } })
    await first
    await new Promise((resolve) => setTimeout(resolve, 800))

    await assert.rejects(
      runTurnWithSlotRetry(fakeController(), client, "t-close-hung", "second", () => {}, {
        slotRetry: { attempts: 1, waitMs: 1 },
        closeWaitMs: 20,
      }),
      /close did not settle within 20ms/,
    )

    const third = runTurnWithSlotRetry(fakeController(), client, "t-close-hung", "third", () => {}, {
      slotRetry: { attempts: 1, waitMs: 1 },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(posts, 1)
    releaseClose()
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(posts, 2)
    emit({ type: "thread", threadId: "t-close-hung", thread: { id: "t-close-hung", turnState: "running" } })
    emit({ type: "thread", threadId: "t-close-hung", thread: { id: "t-close-hung", turnState: "idle" } })
    await third
  })

  it("aborts while waiting for an already-started close", async () => {
    const handlers: Array<(event: unknown) => void> = []
    const client = {
      baseUrl: "http://127.0.0.1:18000",
      postMessage: async () => ({ ok: true }),
      stopThread: async () => ({ ok: true }),
      closeThread: async () => new Promise(() => {}),
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        handlers.push(onEvent)
        return Promise.resolve(() => {})
      },
    } as unknown as FreebuffClient
    const emit = (event: unknown) => { for (const handler of handlers) handler(event) }
    const first = runTurnWithSlotRetry(fakeController(), client, "t-close-abort", "first", () => {}, { slotRetry: { attempts: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 250))
    emit({ type: "thread", threadId: "t-close-abort", thread: { id: "t-close-abort", turnState: "running" } })
    emit({ type: "thread", threadId: "t-close-abort", thread: { id: "t-close-abort", turnState: "idle" } })
    await first
    await new Promise((resolve) => setTimeout(resolve, 800))

    const abort = new AbortController()
    const second = runTurnWithSlotRetry(fakeController(), client, "t-close-abort", "second", () => {}, { signal: abort.signal })
    abort.abort()
    await assert.rejects(second, /Request aborted/)
  })

  it("aborts during the slot retry delay", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("Freebuff is limited to one tab at a time on your network.")
    })
    const abort = new AbortController()
    const turn = runTurnWithSlotRetry(fakeController(), client, "t-retry-abort", "hello", () => {}, {
      signal: abort.signal,
      slotRetry: { attempts: 3, waitMs: 5_000 },
    })
    setTimeout(() => abort.abort(), 20)
    await assert.rejects(turn, /Request aborted/)
  })
})

describe("freebuff gateway request validation", () => {
  it("serves a newly released backend model in the /fb/v1/models list", async () => {
    const app = Fastify({ logger: false })
    registerFreebuffGatewayRoutes(app, {
      freebuff: {} as FreebuffController,
      liveModelIds: async () => ["nova/nova-1.0", "deepseek/deepseek-v4-flash"],
    })
    const response = await app.inject({ method: "GET", url: "/fb/v1/models" })
    await app.close()
    const ids = response.json().data.map((model: { id: string }) => model.id)
    assert.ok(ids.includes("deepseek/deepseek-v4-flash"))
    assert.ok(ids.includes("nova/nova-1.0"), "a live backend model must appear in the gateway model list")
  })

  const request = async (messages: unknown[]) => {
    const app = Fastify({ logger: false })
    registerFreebuffGatewayRoutes(app, { freebuff: {} as FreebuffController })
    const response = await app.inject({
      method: "POST",
      url: "/fb/v1/chat/completions",
      headers: { authorization: `Bearer ${FREEBUFF_SHIM_API_KEY}`, "x-session-id": "validation-session" },
      payload: { model: "deepseek/deepseek-v4-flash", messages },
    })
    await app.close()
    return response
  }

  it("rejects oversized string-only histories", async () => {
    const response = await request([{ role: "user", content: "x".repeat(512 * 1024 + 1) }])
    assert.equal(response.statusCode, 400)
  })

  it("rejects image parts instead of silently discarding their URLs", async () => {
    const response = await request([{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.test/image.png" } }],
    }])
    assert.equal(response.statusCode, 400)
  })

  it("rejects requests without a conversation identity", async () => {
    const app = Fastify({ logger: false })
    registerFreebuffGatewayRoutes(app, {
      freebuff: {
        ensureRunning: async () => ({ engineRunning: true }),
        client: () => ({}),
      } as unknown as FreebuffController,
    })
    const response = await app.inject({
      method: "POST",
      url: "/fb/v1/chat/completions",
      headers: { authorization: `Bearer ${FREEBUFF_SHIM_API_KEY}` },
      payload: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "hello" }] },
    })
    await app.close()
    assert.equal(response.statusCode, 400)
    assert.match(response.json().error.message, /x-session-id/)
  })

  it("rejects invalid history and model boundaries before starting the engine", async () => {
    const cases: Array<{ messages: unknown[]; model?: string }> = [
      { messages: [] },
      { messages: Array.from({ length: 513 }, () => ({ role: "user", content: "x" })) },
      { messages: [{ role: "tool", content: "x" }] },
      { messages: [{ role: "user", content: "õ".repeat(300_000) }] },
      { messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(300_000) }, { type: "text", text: "y".repeat(300_000) }] }] },
      { messages: [{ role: "user", content: "x" }], model: "not-a-freebuff-model" },
    ]
    for (const testCase of cases) {
      const app = Fastify({ logger: false })
      registerFreebuffGatewayRoutes(app, { freebuff: {} as FreebuffController })
      const response = await app.inject({
        method: "POST",
        url: "/fb/v1/chat/completions",
        headers: { authorization: `Bearer ${FREEBUFF_SHIM_API_KEY}`, "x-session-id": "validation-session" },
        payload: { model: testCase.model ?? "deepseek/deepseek-v4-flash", messages: testCase.messages },
      })
      await app.close()
      assert.equal(response.statusCode, 400)
    }
  })
})

describe("freebuff gateway route lifecycle", () => {
  function routeHarness() {
    const handlers = new Set<(event: unknown) => void>()
    const emit = (event: unknown) => { for (const handler of handlers) handler(event) }
    const client = {
      baseUrl: "http://127.0.0.1:18000",
      createThread: async () => ({ id: "t-route" }),
      postMessage: async () => {
        emit({ type: "thread", threadId: "t-route", thread: { id: "t-route", turnState: "running" } })
        emit({ type: "agent", threadId: "t-route", event: { type: "text", text: "route result" } })
        emit({ type: "thread", threadId: "t-route", thread: { id: "t-route", turnState: "idle" } })
        return { ok: true }
      },
      stopThread: async () => ({ ok: true }),
      closeThread: async () => ({ id: "t-route" }),
      subscribeEvents: async (handler: (event: unknown) => void) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
    } as unknown as FreebuffClient
    const freebuff = {
      ensureRunning: async () => ({ engineRunning: true }),
      client: () => client,
      freeSlotFor: async () => {},
    } as unknown as FreebuffController
    return { client, emit, freebuff }
  }

  const payload = {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "run" }],
  }
  const headers = {
    authorization: `Bearer ${FREEBUFF_SHIM_API_KEY}`,
    "x-session-id": "route-session",
    "x-saiwork-workspace": "C:/project",
  }

  it("executes a valid request and replays its exact transport retry", async () => {
    const app = Fastify({ logger: false })
    registerFreebuffGatewayRoutes(app, { freebuff: routeHarness().freebuff })
    const inject = () => app.inject({ method: "POST", url: "/fb/v1/chat/completions", headers, payload })
    const first = await inject()
    const replay = await inject()
    await app.close()
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().choices[0].message.content, "route result")
    assert.equal(replay.statusCode, 200)
    assert.equal(replay.json().choices[0].message.content, "route result")
  })

  it("returns conflict for a concurrent request on the same thread", async () => {
    const app = Fastify({ logger: false })
    const { client, emit, freebuff } = routeHarness()
    let releasePost!: () => void
    ;(client as any).postMessage = () => new Promise<void>((resolve) => { releasePost = resolve })
    registerFreebuffGatewayRoutes(app, { freebuff })
    const request = () => app.inject({ method: "POST", url: "/fb/v1/chat/completions", headers, payload })
    const first = request()
    await new Promise((resolve) => setImmediate(resolve))
    const duplicate = await request()
    assert.equal(duplicate.statusCode, 409)
    await new Promise((resolve) => setTimeout(resolve, 250))
    releasePost()
    emit({ type: "thread", threadId: "t-route", thread: { id: "t-route", turnState: "running" } })
    emit({ type: "thread", threadId: "t-route", thread: { id: "t-route", turnState: "idle" } })
    assert.equal((await first).statusCode, 200)
    await app.close()
  })
})
