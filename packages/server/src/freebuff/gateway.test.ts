import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  firstUserText,
  FreebuffThreadRegistry,
  freebuffThreadKey,
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

  it("derives a stable thread key", () => {
    assert.equal(freebuffThreadKey("C:/proj", "hello world"), freebuffThreadKey("C:/proj", "hello world"))
    assert.notEqual(freebuffThreadKey("C:/proj", "hello world"), freebuffThreadKey("C:/other", "hello world"))
    assert.notEqual(freebuffThreadKey("C:/proj", "hello world"), freebuffThreadKey("C:/proj", "goodbye"))
  })

  it("registry reuses a thread per conversation and dedupes replays", async () => {
    let created = 0
    const client = {
      createThread: async (params: { title?: string }) => {
        created += 1
        return { id: `t-${created}`, title: params.title }
      },
    } as unknown as FreebuffClient
    const registry = new FreebuffThreadRegistry()

    const first = await registry.getOrCreate(client, "C:/proj", "mimo/mimo-v2.5", "hello", "hello")
    assert.equal(first.skip, false)
    assert.equal(created, 1)

    const retry = await registry.getOrCreate(client, "C:/proj", "mimo/mimo-v2.5", "hello", "hello")
    assert.equal(retry.skip, true)
    assert.equal(retry.threadId, first.threadId)
    assert.equal(created, 1)

    const next = await registry.getOrCreate(client, "C:/proj", "mimo/mimo-v2.5", "hello", "follow up")
    assert.equal(next.skip, false)
    assert.equal(next.threadId, first.threadId)
    assert.equal(created, 1)

    const otherConv = await registry.getOrCreate(client, "C:/proj", "mimo/mimo-v2.5", "different start", "different start")
    assert.equal(otherConv.skip, false)
    assert.notEqual(otherConv.threadId, first.threadId)
    assert.equal(created, 2)
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

    const turnPromise = runFreebuffTurn(client, "t-2", "hello", () => {}, { timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    emit!({ type: "error", message: "quota exhausted" })

    await assert.rejects(turnPromise, /quota exhausted/)
  })

  it("resolves with partial text on timeout", async () => {
    const client = {
      postMessage: async () => ({ ok: true }),
      stopThread: async () => ({ ok: true }),
      subscribeEvents: (onEvent: (event: unknown) => void) => {
        // Drive the turn but never return to idle.
        setTimeout(() => {
          onEvent({ type: "thread", threadId: "t-3", thread: { id: "t-3", turnState: "running" } })
          onEvent({ type: "agent", threadId: "t-3", seq: 1, event: { type: "text", text: "partial" } })
        }, 100)
        return Promise.resolve(() => {})
      },
    } as unknown as FreebuffClient

    const text = await runFreebuffTurn(client, "t-3", "hello", () => {}, { timeoutMs: 600 })
    assert.equal(text, "partial")
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
