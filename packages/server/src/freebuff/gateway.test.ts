import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  firstUserText,
  FreebuffThreadRegistry,
  isFreebuffSessionLimitError,
  lastUserText,
  runFreebuffTurn,
  stepMarker,
  type FreebuffOpenAiMessage,
} from "./gateway"
import type { FreebuffClient } from "./client"

const MESSAGES: FreebuffOpenAiMessage[] = [
  { role: "system", content: "ignore me" },
  { role: "user", content: "first question" },
  { role: "assistant", content: "answer" },
  { role: "user", content: [{ type: "text", text: "second question" }] },
]

describe("freebuff gateway", () => {
  it("recognizes session limit errors", () => {
    assert.equal(
      isFreebuffSessionLimitError(new Error("Freebuff is limited to one tab at a time on your network. Close the other hosted-model tab and try again.")),
      true,
    )
    assert.equal(isFreebuffSessionLimitError(new Error("All 5 unlimited-model tabs are in use. Close one.")), true)
    assert.equal(isFreebuffSessionLimitError(new Error("session_limit_reached")), true)
    assert.equal(isFreebuffSessionLimitError(new Error("quota exhausted")), false)
  })

  it("extracts first and last user text", () => {
    assert.equal(firstUserText(MESSAGES), "first question")
    assert.equal(lastUserText(MESSAGES), "second question")
    assert.equal(firstUserText([{ role: "assistant", content: "x" }]), "")
  })

  it("registry keys threads by workspace + session id, never prompt text", async () => {
    let created = 0
    const client = {
      createThread: async (params: { title?: string }) => {
        created += 1
        return { id: `t-${created}`, title: params.title }
      },
    } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const message = (text: string): FreebuffOpenAiMessage[] => [{ role: "user", content: text }]

    // Same workspace + same first prompt + DIFFERENT sessions => different threads.
    const sessionA = await registry.getOrCreate(client, "C:/proj", "sess-a", "mimo/mimo-v2.5", message("hello"))
    const sessionB = await registry.getOrCreate(client, "C:/proj", "sess-b", "mimo/mimo-v2.5", message("hello"))
    assert.equal(sessionA.action.kind, "execute")
    assert.equal(sessionB.action.kind, "execute")
    assert.notEqual(sessionA.threadId, sessionB.threadId)
    assert.equal(created, 2)

    // Same session => same thread across turns.
    const sameSession = await registry.getOrCreate(client, "C:/proj", "sess-a", "mimo/mimo-v2.5", message("hello"))
    assert.equal(sameSession.threadId, sessionA.threadId)
    assert.equal(created, 2)

    // Different workspace => different thread.
    const otherWorkspace = await registry.getOrCreate(client, "C:/other", "sess-a", "mimo/mimo-v2.5", message("hello"))
    assert.notEqual(otherWorkspace.threadId, sessionA.threadId)
    assert.equal(created, 3)
  })

  it("replays an exact completed request and executes an intentional repeated prompt", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const firstTurn = [{ role: "user", content: "continue" }] as FreebuffOpenAiMessage[]

    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", firstTurn)
    assert.equal(first.action.kind, "execute")
    registry.completeTurn(first.threadId, first.fingerprint, "answer one")

    // Exact transport replay returns the recorded result, not an empty fake.
    const replay = await registry.getOrCreate(client, "C:/proj", "s1", "m", firstTurn)
    assert.equal(replay.action.kind, "replay")
    assert.equal(replay.action.result, "answer one")

    // Intentional second "continue": the assistant answer now sits in history,
    // so the fingerprint differs and the turn executes normally.
    const secondTurn = [
      ...firstTurn,
      { role: "assistant", content: "answer one" },
      { role: "user", content: "continue" },
    ] as FreebuffOpenAiMessage[]
    const second = await registry.getOrCreate(client, "C:/proj", "s1", "m", secondTurn)
    assert.equal(second.action.kind, "execute")
  })

  it("replays an older completed fingerprint after a newer turn finishes", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const firstTurn = [{ role: "user", content: "first" }] as FreebuffOpenAiMessage[]
    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", firstTurn)
    registry.completeTurn(first.threadId, first.fingerprint, "first result")
    const secondTurn = [...firstTurn, { role: "assistant", content: "first result" }, { role: "user", content: "second" }]
    const second = await registry.getOrCreate(client, "C:/proj", "s1", "m", secondTurn)
    registry.completeTurn(second.threadId, second.fingerprint, "second result")

    const delayedReplay = await registry.getOrCreate(client, "C:/proj", "s1", "m", firstTurn)
    assert.equal(delayedReplay.action.kind, "replay")
    assert.equal(delayedReplay.action.result, "first result")
  })

  it("retains a completion tombstone when a replay result exceeds the byte cap", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry(10, 1_000, 4, 10)
    const turn = [{ role: "user", content: "large" }] as FreebuffOpenAiMessage[]
    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    registry.completeTurn(first.threadId, first.fingerprint, "12345")

    const retry = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    assert.equal(retry.action.kind, "completed-unavailable")
  })

  it("evicts oldest replay results to enforce the global byte cap", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry(10, 1_000, 10, 6)
    const firstTurn = [{ role: "user", content: "first" }] as FreebuffOpenAiMessage[]
    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", firstTurn)
    registry.completeTurn(first.threadId, first.fingerprint, "1234")
    const secondTurn = [...firstTurn, { role: "assistant", content: "1234" }, { role: "user", content: "second" }]
    const second = await registry.getOrCreate(client, "C:/proj", "s1", "m", secondTurn)
    registry.completeTurn(second.threadId, second.fingerprint, "5678")

    const oldReplay = await registry.getOrCreate(client, "C:/proj", "s1", "m", firstTurn)
    assert.equal(oldReplay.action.kind, "completed-unavailable")
  })

  it("retains tombstones when the per-thread result cache rolls over", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry(10, 1_000, 100, 10_000, 32, 16)
    const turns: FreebuffOpenAiMessage[][] = []
    for (let index = 0; index < 17; index += 1) {
      const messages = [{ role: "user", content: `turn-${index}` }] as FreebuffOpenAiMessage[]
      turns.push(messages)
      const turn = await registry.getOrCreate(client, "C:/proj", "s1", "m", messages)
      registry.completeTurn(turn.threadId, turn.fingerprint, `result-${index}`)
    }
    const oldest = await registry.getOrCreate(client, "C:/proj", "s1", "m", turns[0])
    assert.equal(oldest.action.kind, "completed-unavailable")
  })

  it("concurrent identical requests surface in-flight instead of double-posting", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const turn = [{ role: "user", content: "run" }] as FreebuffOpenAiMessage[]

    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    assert.equal(first.action.kind, "execute")
    const concurrent = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    assert.equal(concurrent.action.kind, "in-flight")
  })

  it("blocks a different turn while the current thread turn is in flight", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "first" }])
    assert.equal(first.action.kind, "execute")
    const second = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "second" }])
    assert.equal(second.action.kind, "in-flight")
  })

  it("creates a new engine thread when a conversation switches model", async () => {
    let created = 0
    const client = { createThread: async () => ({ id: `t-${++created}` }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const turn = [{ role: "user", content: "hello" }] as FreebuffOpenAiMessage[]
    const first = await registry.getOrCreate(client, "C:/proj", "s1", "model-a", turn)
    const switched = await registry.getOrCreate(client, "C:/proj", "s1", "model-b", turn)
    assert.notEqual(first.threadId, switched.threadId)
    assert.equal(created, 2)
  })

  it("coalesces concurrent first requests into one thread creation", async () => {
    let release!: () => void
    let creations = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    const client = {
      createThread: async () => {
        creations += 1
        await gate
        return { id: "t-shared" }
      },
    } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const turn = [{ role: "user", content: "run" }] as FreebuffOpenAiMessage[]

    const first = registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    const duplicate = registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(creations, 1)
    release()
    const [left, right] = await Promise.all([first, duplicate])
    assert.equal(left.threadId, "t-shared")
    assert.equal(right.threadId, "t-shared")
    assert.equal(right.action.kind, "in-flight")
  })

  it("protects a newly created thread until its first dispatch is registered", async () => {
    let competing: Promise<{ error?: unknown }> | undefined
    const registry = new FreebuffThreadRegistry(1)
    const client = {
      createThread: async () => ({
        get id() {
          queueMicrotask(() => {
            competing = registry.getOrCreate(
                client as unknown as FreebuffClient,
                "C:/proj",
                "s2",
                "m",
                [{ role: "user", content: "other" }],
              )
              .then(() => ({}), (error) => ({ error }))
          })
          return "t-first"
        },
      }),
    } as unknown as FreebuffClient

    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "first" }])
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(String((await competing!).error), /at capacity with active turns/)
    const duplicate = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "first" }])
    assert.equal(duplicate.threadId, first.threadId)
    assert.equal(duplicate.action.kind, "in-flight")
  })

  it("bounds completed replay records with oldest-session eviction", async () => {
    let created = 0
    const client = { createThread: async () => ({ id: `t-${++created}` }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry(2)
    const message = (text: string) => [{ role: "user", content: text }] as FreebuffOpenAiMessage[]

    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", message("one"))
    registry.completeTurn(first.threadId, first.fingerprint, "large result")
    const second = await registry.getOrCreate(client, "C:/proj", "s2", "m", message("two"))
    registry.completeTurn(second.threadId, second.fingerprint, "second result")
    const third = await registry.getOrCreate(client, "C:/proj", "s3", "m", message("three"))
    registry.completeTurn(third.threadId, third.fingerprint, "third result")
    const recreated = await registry.getOrCreate(client, "C:/proj", "s1", "m", message("one"))

    assert.notEqual(recreated.threadId, first.threadId)
    assert.equal(recreated.action.kind, "execute")
  })

  it("does not evict a current session merely because the registry is full", async () => {
    let created = 0
    const client = { createThread: async () => ({ id: `t-${++created}` }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry(2)
    const turn = [{ role: "user", content: "one" }] as FreebuffOpenAiMessage[]
    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    registry.completeTurn(first.threadId, first.fingerprint, "done")
    await registry.getOrCreate(client, "C:/proj", "s2", "m", [{ role: "user", content: "two" }])
    const replay = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)

    assert.equal(replay.threadId, first.threadId)
    assert.equal(replay.action.kind, "replay")
    assert.equal(created, 2)
  })

  it("does not evict an active in-flight thread at capacity", async () => {
    let created = 0
    const client = { createThread: async () => ({ id: `t-${++created}` }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry(1)
    const active = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "active" }])
    await assert.rejects(
      registry.getOrCreate(client, "C:/proj", "s2", "m", [{ role: "user", content: "other" }]),
      /at capacity with active turns/,
    )
    const duplicate = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "active" }])
    assert.equal(duplicate.threadId, active.threadId)
    assert.equal(duplicate.action.kind, "in-flight")
  })

  it("never expires an in-flight turn even after the normal TTL", async () => {
    let now = 1_000
    const originalNow = Date.now
    Date.now = () => now
    try {
      const client = { createThread: async () => ({ id: "t-active" }) } as unknown as FreebuffClient
      const registry = new FreebuffThreadRegistry(2, 10)
      const active = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "active" }])
      now += 100
      await registry.getOrCreate(client, "C:/proj", "s2", "m", [{ role: "user", content: "other" }])
      const duplicate = await registry.getOrCreate(client, "C:/proj", "s1", "m", [{ role: "user", content: "different" }])
      assert.equal(duplicate.threadId, active.threadId)
      assert.equal(duplicate.action.kind, "in-flight")
    } finally {
      Date.now = originalNow
    }
  })

  it("does not poison a retry after a failed dispatch", async () => {
    const client = { createThread: async () => ({ id: "t-1" }) } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()
    const turn = [{ role: "user", content: "run" }] as FreebuffOpenAiMessage[]

    const first = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    registry.failTurn(first.threadId, first.fingerprint)
    const retry = await registry.getOrCreate(client, "C:/proj", "s1", "m", turn)
    assert.equal(retry.action.kind, "execute")
  })

  it("requests the maximum reasoning effort when creating a thread", async () => {
    const createdParams: Array<Record<string, unknown>> = []
    const client = {
      createThread: async (params: Record<string, unknown>) => {
        createdParams.push(params)
        return { id: `t-${createdParams.length}` }
      },
    } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()

    await registry.getOrCreate(client, "C:/proj", "s1", "deepseek/deepseek-v4-flash", [{ role: "user", content: "hello" }])
    assert.equal(createdParams[0].reasoningEffort, "high")
    // A catalog model without an explicit range still falls back to high.
    await registry.getOrCreate(client, "C:/proj", "s2", "mimo/mimo-v2.5", [{ role: "user", content: "other" }])
    assert.equal(createdParams[1].reasoningEffort, "high")
  })

  it("runs a turn, collects text and resolves on idle", async () => {
    let postCalled = false
    let emit: ((event: unknown) => void) | null = null
    const client = {
      postMessage: async () => {
        postCalled = true
        return { ok: true }
      },
      stopThread: async () => ({ ok: true }),
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        emit = onEvent
        return Promise.resolve(() => {
          emit = null
        })
      },
    } as unknown as FreebuffClient

    const chunks: string[] = []
    const turnPromise = runFreebuffTurn(client, "t-1", "hello", (chunk) => chunks.push(chunk), { timeoutMs: 5000 })

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(postCalled, true)
    emit!({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "running", status: "open" } })
    emit!({ type: "agent", threadId: "t-1", seq: 1, event: { type: "text", text: "Hel" } })
    emit!({ type: "agent", threadId: "t-1", seq: 2, event: { type: "text", text: "lo" } })
    emit!({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "idle", status: "open" } })

    const text = await turnPromise
    assert.equal(text, "Hello")
    assert.deepEqual(chunks, ["Hel", "lo"])
  })

  it("rejects on engine error events", async () => {
    let emit: ((event: unknown) => void) | null = null
    let releaseStop!: () => void
    let rejected = false
    const client = {
      postMessage: async () => ({ ok: true }),
      stopThread: async () => new Promise<{ ok: true }>((resolve) => { releaseStop = () => resolve({ ok: true }) }),
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        emit = onEvent
        return Promise.resolve(() => {
          emit = null
        })
      },
    } as unknown as FreebuffClient

    const turnPromise = runFreebuffTurn(client, "t-2", "hello", () => {}, { timeoutMs: 5000 })
      .catch((error) => { rejected = true; throw error })
    await new Promise((resolve) => setTimeout(resolve, 300))
    emit!({ type: "error", message: "quota exhausted" })

    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(rejected, false)
    releaseStop()
    await assert.rejects(turnPromise, /quota exhausted/)
  })

  it("turns a hard timeout into a failure: stops the thread once and rejects", async () => {
    let stopCalls = 0
    const client = {
      postMessage: async () => ({ ok: true }),
      stopThread: async () => {
        stopCalls += 1
        return { ok: true }
      },
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        // Drive the turn but never return to idle.
        setTimeout(() => {
          onEvent({ type: "thread", threadId: "t-timeout", thread: { id: "t-timeout", turnState: "running" } })
          onEvent({ type: "agent", threadId: "t-timeout", seq: 1, event: { type: "text", text: "partial" } })
        }, 100)
        return Promise.resolve(() => {})
      },
    } as unknown as FreebuffClient

    await assert.rejects(
      runFreebuffTurn(client, "t-timeout", "hello", () => {}, { timeoutMs: 120 }),
      /timed out after 120ms/,
    )
    assert.equal(stopCalls, 1)
  })

  it("aborts a running turn: stops the thread exactly once and rejects", async () => {
    let stopCalls = 0
    let emit: ((event: unknown) => void) | null = null
    const client = {
      postMessage: async () => ({ ok: true }),
      stopThread: async () => {
        stopCalls += 1
        return { ok: true }
      },
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        emit = onEvent
        return Promise.resolve(() => {
          emit = null
        })
      },
    } as unknown as FreebuffClient

    const controller = new AbortController()
    const turnPromise = runFreebuffTurn(client, "t-abort", "hello", () => {}, { signal: controller.signal, timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    emit!({ type: "thread", threadId: "t-abort", thread: { id: "t-abort", turnState: "running" } })
    controller.abort()
    await assert.rejects(turnPromise, /aborted/)
    assert.equal(stopCalls, 1)
  })

  it("does not reject an aborted turn until dispatch and stop cleanup settle", async () => {
    let postSignal: AbortSignal | undefined
    let rejectDispatch!: (error: Error) => void
    let releaseStop!: () => void
    let stopCalls = 0
    const client = {
      subscribeEvents: async () => () => {},
      postMessage: async (_threadId: string, _prompt: string, _attachments: string[], options?: { signal?: AbortSignal }) => {
        postSignal = options?.signal
        return new Promise<never>((_resolve, reject) => { rejectDispatch = reject })
      },
      stopThread: async () => {
        stopCalls += 1
        return new Promise<{ ok: true }>((resolve) => { releaseStop = () => resolve({ ok: true }) })
      },
    } as unknown as FreebuffClient
    const abort = new AbortController()
    let rejected = false
    const turn = runFreebuffTurn(client, "t-cleanup", "hello", () => {}, { signal: abort.signal })
      .catch((error) => { rejected = true; throw error })

    await new Promise((resolve) => setTimeout(resolve, 250))
    abort.abort()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(postSignal?.aborted, true)
    assert.equal(stopCalls, 0)
    assert.equal(rejected, false)

    rejectDispatch(new Error("dispatch aborted"))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(stopCalls, 1)
    assert.equal(rejected, false)
    releaseStop()
    await assert.rejects(turn, /Request aborted/)
  })

  it("does not stop a reused thread when an old turn's signal aborts after completion", async () => {
    const stopped: string[] = []
    let emit: ((event: unknown) => void) | null = null
    const client = {
      postMessage: async () => ({ ok: true }),
      stopThread: async (threadId: string) => {
        stopped.push(threadId)
        return { ok: true }
      },
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        emit = onEvent
        return Promise.resolve(() => {
          emit = null
        })
      },
    } as unknown as FreebuffClient

    const controllerA = new AbortController()
    const turnA = runFreebuffTurn(client, "t-1", "hello", () => {}, { signal: controllerA.signal, timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    emit!({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "running" } })
    emit!({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "idle" } })
    await turnA

    // Turn B reuses the same thread; A's stale signal must not stop it.
    const turnB = runFreebuffTurn(client, "t-1", "again", () => {}, { timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    controllerA.abort()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(stopped, [])
    emit!({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "running" } })
    emit!({ type: "thread", threadId: "t-1", thread: { id: "t-1", turnState: "idle" } })
    await turnB
    assert.deepEqual(stopped, [])
  })

  it("inserts newlines between sentence-ending steps but not mid-sentence chunks", async () => {
    let emit: ((event: unknown) => void) | null = null
    const client = {
      postMessage: async () => ({ ok: true }),
      stopThread: async () => ({ ok: true }),
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        emit = onEvent
        return Promise.resolve(() => {
          emit = null
        })
      },
    } as unknown as FreebuffClient

    const deltas: string[] = []
    const turnPromise = runFreebuffTurn(client, "t-4", "hello", (delta) => deltas.push(delta), { timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const running = () => emit!({ type: "thread", threadId: "t-4", thread: { id: "t-4", turnState: "running" } })
    running()
    emit!({ type: "agent", threadId: "t-4", seq: 1, event: { type: "text", text: "First step." } })
    emit!({ type: "agent", threadId: "t-4", seq: 2, event: { type: "text", text: "Sec" } })
    emit!({ type: "agent", threadId: "t-4", seq: 3, event: { type: "text", text: "ond step." } })
    emit!({ type: "thread", threadId: "t-4", thread: { id: "t-4", turnState: "idle" } })

    const text = await turnPromise
    assert.equal(text, "First step.\nSecond step.")
    assert.deepEqual(deltas, ["First step.", "\nSec", "ond step."])
  })

  it("forwards agent steps through onStep", async () => {
    let emit: ((event: unknown) => void) | null = null
    const client = {
      postMessage: async () => ({ ok: true }),
      stopThread: async () => ({ ok: true }),
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        emit = onEvent
        return Promise.resolve(() => {
          emit = null
        })
      },
    } as unknown as FreebuffClient

    const steps: string[] = []
    const turnPromise = runFreebuffTurn(client, "t-5", "hello", () => {}, {
      timeoutMs: 5000,
      onStep: (delta) => steps.push(delta),
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    emit!({ type: "thread", threadId: "t-5", thread: { id: "t-5", turnState: "running" } })
    emit!({ type: "agent", threadId: "t-5", seq: 1, event: { type: "status", stage: "planning" } })
    emit!({ type: "agent", threadId: "t-5", seq: 2, event: { type: "tool_call", toolName: "bash" } })
    emit!({ type: "agent", threadId: "t-5", seq: 3, event: { type: "subagent_start", agentType: "hunter" } })
    emit!({ type: "agent", threadId: "t-5", seq: 4, event: { type: "text", text: "done." } })
    emit!({ type: "thread", threadId: "t-5", thread: { id: "t-5", turnState: "idle" } })

    const text = await turnPromise
    assert.deepEqual(steps, ["> planning", "\n> tool: bash", "\n> subagent: hunter"])
    assert.equal(text, "> planning\n> tool: bash\n> subagent: hunter\ndone.")
  })

  it("stepMarker produces font-safe markers only for process events", () => {
    assert.equal(stepMarker({ type: "status", stage: "planning" }), "> planning")
    assert.equal(stepMarker({ type: "tool_call", toolName: "read_file" }), "> tool: read_file")
    assert.equal(stepMarker({ type: "subagent_start", agentType: "hunter" }), "> subagent: hunter")
    assert.equal(stepMarker({ type: "subagent_start", agentId: "sub-1" }), "> subagent: sub-1")
    assert.equal(stepMarker({ type: "status" }), null)
    assert.equal(stepMarker({ type: "tool_result", toolName: "bash" }), null)
    assert.equal(stepMarker({ type: "text", text: "x" }), null)
    assert.equal(stepMarker({ type: "reasoning_delta", text: "x" }), null)
  })

  it("stepMarker shows what a tool is acting on from its input", () => {
    assert.equal(
      stepMarker({ type: "tool_call", toolName: "str_replace", input: { file_path: "src/sessions.py" } }),
      "> tool: str_replace · src/sessions.py",
    )
    assert.equal(
      stepMarker({ type: "tool_call", toolName: "run_terminal_command", input: { command: "npm test" } }),
      "> tool: run_terminal_command · npm test",
    )
    assert.equal(stepMarker({ type: "tool_call", toolName: "read_files", input: { file_path: "a/b/c.py" } }), "> tool: read_files · a/b/c.py")
    assert.equal(stepMarker({ type: "tool_call", toolName: "write_file", input: "not an object" }), "> tool: write_file")
    const longCommand = "python -m pytest " + "x".repeat(100)
    const marker = stepMarker({ type: "tool_call", toolName: "run_terminal_command", input: { command: longCommand } })
    assert.ok(marker!.length < 100, "long commands are truncated")
    assert.ok(!marker!.includes("x".repeat(50)), "command body is cut, not the whole line")
  })
})
