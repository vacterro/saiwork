import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import type {
  QueuedPrompt as ServerQueuedPrompt,
  QueueState as ServerQueueState,
  WorkspaceEventPayload,
} from "../../../server/src/api-types"
import type { QueueMutation as ServerQueueMutation } from "../../../server/src/queue/manager"
import {
  __resetQueueTransport,
  __setQueueTransport,
  clearQueue,
  dequeuePrompt,
  enqueuePrompt,
  enqueuePromptFanOut,
  getQueue,
  getQueueLength,
  isQueuePaused,
  moveQueuedPrompt,
  removeQueuedPrompt,
  resetQueues,
  restoreDequeuedPrompt,
  updateQueuedPrompt,
  type EnqueueResult,
  type QueueMutateOutcome,
  type QueueTransport,
  type QueuedPrompt,
} from "./prompt-queue.ts"

/**
 * A mini-server that enforces the same CAS semantics the real QueueManager
 * does, so the store tests exercise the mirror mechanics without a live server.
 */
let idCounter = 0
let revisionCounter = 0

class FakeQueueWorld {
  readonly queues = new Map<string, ServerQueueState>()
  private readonly changeHandlers = new Set<(event: Extract<WorkspaceEventPayload, { type: "queue.changed" }>) => void>()
  private readonly openHandlers = new Set<() => void>()
  listCalls = 0

  readonly transport: QueueTransport = {
    list: async () => {
      this.listCalls += 1
      const out: Record<string, ServerQueueState> = {}
      for (const [key, state] of this.queues) out[key] = state
      return out
    },
    mutate: (key, expectedRevision, mutation) => this.mutate(key, expectedRevision, mutation),    onChange: (handler) => {
      this.changeHandlers.add(handler)
      return () => this.changeHandlers.delete(handler)
    },
    onOpen: (handler) => {
      this.openHandlers.add(handler)
      return () => this.openHandlers.delete(handler)
    },
  }

  private set(key: string, items: ServerQueuedPrompt[], paused: boolean): ServerQueueState {
    const state: ServerQueueState = { items, paused, revision: `rev-${++revisionCounter}` }
    if (items.length === 0 && !paused) this.queues.delete(key)
    else this.queues.set(key, state)
    return state
  }

  private async mutate(key: string, expectedRevision: string, mutation: ServerQueueMutation): Promise<QueueMutateOutcome> {
    const current = this.queues.get(key)
    if ((current?.revision ?? "") !== expectedRevision) {
      return { status: "conflict", currentRevision: current?.revision ?? "" }
    }
    const items = [...(current?.items ?? [])]
    const paused = current?.paused ?? false

    switch (mutation.op) {
      case "enqueue": {
        const trimmed = mutation.text.trim()
        if (!trimmed && (mutation.attachments?.length ?? 0) === 0) return { status: "failed", code: "empty" }
        const item: ServerQueuedPrompt = {
          id: `id-${++idCounter}`,
          text: trimmed,
          attachments: mutation.attachments ?? [],
          createdAt: Date.now(),
        }
        const state = this.set(key, [...items, item], paused)
        return { status: "ok", state }
      }
      case "dequeue": {
        if (paused) return { status: "failed", code: "paused" }
        if (items.length === 0) return { status: "failed", code: "empty" }
        const [head, ...rest] = items
        const state = this.set(key, rest, paused)
        return { status: "ok", state, dequeued: head }
      }
      case "restore": {
        const restored = [mutation.item, ...items.filter((item) => item.id !== mutation.item.id)]
        const state = this.set(key, restored, mutation.pause === true ? true : paused)
        return { status: "ok", state }
      }
      case "move": {
        const index = items.findIndex((item) => item.id === mutation.id)
        if (index < 0) return { status: "failed", code: "empty" }
        const target = Math.max(0, Math.min(items.length - 1, index + mutation.delta))
        const [moved] = items.splice(index, 1)
        items.splice(target, 0, moved)
        return { status: "ok", state: this.set(key, items, paused) }
      }
      case "remove": {
        return { status: "ok", state: this.set(key, items.filter((item) => item.id !== mutation.id), paused) }
      }
      case "update": {
        const trimmed = mutation.text.trim()
        const updated = trimmed
          ? items.map((item) =>
              item.id === mutation.id
                ? { ...item, text: trimmed, ...(mutation.attachments !== undefined ? { attachments: mutation.attachments } : {}) }
                : item,
            )
          : items.filter((item) => item.id !== mutation.id)
        return { status: "ok", state: this.set(key, updated, paused) }
      }
      case "clear": {
        return { status: "ok", state: this.set(key, [], paused) }
      }
      case "set-paused": {
        return { status: "ok", state: this.set(key, items, mutation.paused) }
      }
    }
  }

  /** Simulates the SSE broadcast another window's mutation would cause. */
  emitExternal(key: string, state: ServerQueueState): void {
    for (const handler of this.changeHandlers) handler({ type: "queue.changed", key, state })
  }

  open(): void {
    for (const handler of this.openHandlers) handler()
  }
}

const world = new FakeQueueWorld()

beforeEach(() => {
  world.queues.clear()
  world.listCalls = 0
  resetQueues()
  __setQueueTransport(world.transport)
})

/** Unwraps a queue result, failing the test if the prompt was refused. */
async function expectQueued(result: Promise<EnqueueResult>): Promise<QueuedPrompt> {
  const value = await result
  assert.equal(value.ok, true, `expected the prompt to queue, got ${JSON.stringify(value)}`)
  if (!value.ok) throw new Error("unreachable")
  return value.item
}

describe("prompt queue mirror", () => {
  it("enqueues through the transport and reflects the authoritative state", async () => {
    const item = await expectQueued(enqueuePrompt("one", "session-a", "first"))
    assert.ok(item.id.length > 0)
    assert.deepEqual(getQueue("one", "session-a").map((queued) => queued.text), ["first"])
    assert.equal(getQueueLength("one", "session-a"), 1)
  })

  it("refuses empty and oversized prompts without touching the server", async () => {
    assert.equal((await enqueuePrompt("one", "session", "   ")).ok, false)
    assert.equal((await enqueuePrompt("one", "session", "")).ok, false)
    assert.equal(getQueue("one", "session").length, 0)
  })

  it("updates the mirror from an external queue.changed event", async () => {
    const external: ServerQueueState = {
      items: [{ id: "x-1", text: "from another window", attachments: [], createdAt: 1 }],
      paused: false,
      revision: "rev-external",
    }
    world.emitExternal("one:session", external)
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["from another window"])
  })

  it("refreshes the mirror after losing a dequeue race", async () => {
    await enqueuePrompt("one", "session", "A")
    // Another window dequeues first.
    await world.transport.mutate("one:session", world.queues.get("one:session")!.revision, { op: "dequeue" })
    const callsBefore = world.listCalls

    const lost = await dequeuePrompt("one", "session")
    assert.equal(lost, null)
    assert.ok(world.listCalls > callsBefore, "a conflict must trigger a mirror refresh")
    assert.equal(getQueue("one", "session").length, 0)
  })

  it("restores a failed head once at the original front with the same identity", async () => {
    const first = await expectQueued(enqueuePrompt("one", "session", "A"))
    const second = await expectQueued(enqueuePrompt("one", "session", "B"))

    const failed = await dequeuePrompt("one", "session")
    assert.equal(failed?.id, first.id)

    await restoreDequeuedPrompt("one", "session", failed!)
    await restoreDequeuedPrompt("one", "session", failed!)
    assert.deepEqual(getQueue("one", "session").map((item) => item.id), [first.id, second.id])
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["A", "B"])
  })

  it("pauses after restoring a failed head so idle effects cannot retry it", async () => {
    const first = await expectQueued(enqueuePrompt("one", "session", "A"))
    await expectQueued(enqueuePrompt("one", "session", "B"))

    const failed = await dequeuePrompt("one", "session")
    await restoreDequeuedPrompt("one", "session", failed!, { pause: true })

    assert.equal(isQueuePaused("one", "session"), true)
    assert.equal(await dequeuePrompt("one", "session"), null)
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["A", "B"])
  })

  it("fans out to each unique target atomically", async () => {
    await expectQueued(enqueuePrompt("one", "session-a", "first"))
    const result = await enqueuePromptFanOut(
      [
        { instanceId: "one", sessionId: "session-a" },
        { instanceId: "two", sessionId: "session-b" },
        { instanceId: "one", sessionId: "session-a" },
      ],
      " shared prompt ",
    )
    assert.ok(result.ok)
    if (result.ok) assert.equal(result.items.length, 2)
    assert.deepEqual(getQueue("one", "session-a").map((item) => item.text), ["first", "shared prompt"])
    assert.deepEqual(getQueue("two", "session-b").map((item) => item.text), ["shared prompt"])
  })

  it("stores edited pasted text and drops its consumed placeholder attachment", async () => {
    const pasted = {
      id: "paste-1",
      type: "text" as const,
      display: "pasted #1 (4 lines)",
      url: "data:text/plain;base64,cGFzdGVkIGJvZHk=",
      filename: "paste-1.txt",
      mediaType: "text/plain",
      source: { type: "text" as const, value: "pasted body" },
    }
    const file = {
      id: "file-1",
      type: "file" as const,
      display: "@notes.txt",
      url: "file://notes.txt",
      filename: "notes.txt",
      mediaType: "text/plain",
      source: { type: "file" as const, path: "notes.txt", mime: "text/plain" },
    }
    const unusedPaste = {
      ...pasted,
      id: "paste-2",
      display: "pasted #2 (4 lines)",
      filename: "paste-2.txt",
      source: { type: "text" as const, value: "second pasted body" },
    }
    const item = await expectQueued(enqueuePrompt("one", "session", "Before [pasted #1] after", [pasted, unusedPaste, file]))

    await updateQueuedPrompt("one", "session", item.id, "Before edited pasted body after [pasted #2]")

    assert.equal(getQueue("one", "session")[0].text, "Before edited pasted body after [pasted #2]")
    assert.deepEqual(getQueue("one", "session")[0].attachments, [unusedPaste, file])
  })

  it("does nothing for empty prompts or target lists", async () => {
    assert.equal((await enqueuePromptFanOut([], "prompt")).ok, false)
    assert.equal((await enqueuePromptFanOut([{ instanceId: "one", sessionId: "session" }], "  ")).ok, false)
    assert.equal(getQueue("one", "session").length, 0)
  })

  it("rolls back a partial fan-out when one target loses the race", async () => {
    // Another window adds to target B without this renderer knowing, so the
    // mirror's revision for B is stale and the fan-out enqueue there conflicts.
    await world.transport.mutate("two:session-b", "", { op: "enqueue", text: "foreign", attachments: [] })

    const result = await enqueuePromptFanOut(
      [{ instanceId: "one", sessionId: "session-a" }, { instanceId: "two", sessionId: "session-b" }],
      "shared",
    )
    assert.equal(result.ok, false)
    // Target A's partial enqueue was rolled back.
    assert.equal(world.queues.get("one:session-a")?.items.length ?? 0, 0)
    // Target B keeps the foreign item (server truth, never clobbered).
    assert.deepEqual(world.queues.get("two:session-b")?.items.map((item) => item.text), ["foreign"])
  })

  it("moves, removes and clears through the transport", async () => {
    const a = await expectQueued(enqueuePrompt("one", "session", "A"))
    const b = await expectQueued(enqueuePrompt("one", "session", "B"))
    const c = await expectQueued(enqueuePrompt("one", "session", "C"))

    await updateQueuedPrompt("one", "session", b.id, "B2")
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["A", "B2", "C"])

    await moveQueuedPrompt("one", "session", c.id, -2)
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["C", "A", "B2"])

    await removeQueuedPrompt("one", "session", a.id)
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["C", "B2"])

    const cleared = await clearQueue("one", "session")
    assert.equal(cleared, true)
    assert.equal(getQueue("one", "session").length, 0)
  })
})
