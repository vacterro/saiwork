import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import { MAX_QUEUED_ATTACHMENT_BYTES } from "../../../server/src/api-types"
import { isQueuedAttachment, isQueuedPrompt } from "../../../server/src/queue/validation"
import type {
  QueueMutation as ServerQueueMutation,
  QueuedPrompt as ServerQueuedPrompt,
  QueueState as ServerQueueState,
  WorkspaceEventPayload,
} from "../../../server/src/api-types"
import {
  __resetQueueTransport,
  __setQueueTransport,
  clearQueue,
  dequeuePrompt,
  enqueuePrompt,
  enqueuePromptFanOut,
  getQueue,
  getQueueLength,
  moveQueuedPrompt,
  migrateLegacyQueueStorage,
  removeQueuedPrompt,
  resetQueues,
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
  listOverride: (() => Promise<Record<string, ServerQueueState>>) | null = null

  readonly transport: QueueTransport = {
    list: async () => {
      this.listCalls += 1
      if (this.listOverride) return this.listOverride()
      const out: Record<string, ServerQueueState> = {}
      for (const [key, state] of this.queues) out[key] = state
      return out
    },
    mutate: (key, expectedRevision, mutation) => this.mutate(key, expectedRevision, mutation),
    mutateMany: async (targets, text, attachments) => {
      // Atomic, mirroring the real server transaction: validate EVERY revision
      // first; if any conflicts, commit NONE.
      for (const target of targets) {
        const current = this.queues.get(target.key)
        if ((current?.revision ?? "") !== target.expectedRevision) {
          return {
            ok: false,
            code: "conflict",
            currentRevision: current?.revision ?? "",
            error: "queue changed; refresh and retry",
          }
        }
      }
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return { ok: false, code: "empty" }
      if (!attachments.every(isQueuedAttachment)) return { ok: false, code: "invalid" }
      const items: ServerQueuedPrompt[] = []
      for (const target of targets) {
        const current = this.queues.get(target.key)
        const item: ServerQueuedPrompt = {
          id: `id-${++idCounter}`,
          text: trimmed,
          attachments,
          createdAt: Date.now(),
        }
        const state = this.set(target.key, [...(current?.items ?? []), item], current?.paused ?? false)
        items.push(item)
        // Mirror the server's per-key `queue.changed` broadcast.
        this.emitExternal(target.key, state)
      }
      return { ok: true, items }
    },
    onChange: (handler) => {
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
        const attachments = mutation.attachments ?? []
        if (!attachments.every(isQueuedAttachment)) return { status: "failed", code: "invalid" }
        const item: ServerQueuedPrompt = {
          id: `id-${++idCounter}`,
          text: trimmed,
          attachments,
          createdAt: Date.now(),
        }
        const state = this.set(key, [...items, item], paused)
        return { status: "ok", state }
      }
      case "import-legacy": {
        const imported = mutation.item
        if (!isQueuedPrompt(imported)) return { status: "failed", code: "invalid" }
        const existing = items.find((item) => item.id === imported.id)
        if (existing) return { status: "ok", state: current! }
        return { status: "ok", state: this.set(key, [...items, imported], paused) }
      }
      case "restore": {
        const restored = mutation.item
        if (!isQueuedPrompt(restored)) return { status: "failed", code: "invalid" }
        return {
          status: "ok",
          state: this.set(key, [restored, ...items.filter((item) => item.id !== restored.id)], mutation.pause === true || paused),
        }
      }
      case "dequeue": {
        if (paused) return { status: "failed", code: "paused" }
        if (items.length === 0) return { status: "failed", code: "empty" }
        const [head, ...rest] = items
        const state = this.set(key, rest, paused)
        return { status: "ok", state, dequeued: head }
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
        const attachments = mutation.attachments
        if (attachments && !attachments.every(isQueuedAttachment)) return { status: "failed", code: "invalid" }
        const updated = trimmed
          ? items.map((item) =>
              item.id === mutation.id
                ? { ...item, text: trimmed, ...(attachments !== undefined ? { attachments } : {}) }
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
  world.listOverride = null
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
    const oversized = {
      id: "large",
      type: "text" as const,
      display: "pasted text",
      url: "data:text/plain;base64,",
      filename: "large.txt",
      mediaType: "text/plain",
      source: { type: "text" as const, value: "é".repeat(MAX_QUEUED_ATTACHMENT_BYTES / 2) },
    }
    const tooLarge = await enqueuePrompt("one", "session", "text", [oversized])
    assert.deepEqual(tooLarge, { ok: false, reason: "too-large" })
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

  it("does not let a conflict resync GET overwrite a newer SSE state", async () => {
    await expectQueued(enqueuePrompt("one", "session", "A"))
    const key = "one:session"
    const serverRevision = world.queues.get(key)!.revision
    await world.transport.mutate(key, serverRevision, { op: "dequeue" })

    let resolveList!: (queues: Record<string, ServerQueueState>) => void
    const delayedList = new Promise<Record<string, ServerQueueState>>((resolve) => {
      resolveList = resolve
    })
    world.listOverride = () => delayedList

    const lostDequeue = dequeuePrompt("one", "session")
    await new Promise<void>((resolve) => setImmediate(resolve))

    const external = await world.transport.mutate(key, "", { op: "enqueue", text: "newer SSE", attachments: [] })
    assert.equal(external.status, "ok")
    if (external.status !== "ok") throw new Error("unreachable")
    world.emitExternal(key, external.state)

    resolveList({})
    assert.equal(await lostDequeue, null)
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["newer SSE"])
  })

  it("does not let an older mutation response overwrite a newer GET snapshot", async () => {
    const original = await expectQueued(enqueuePrompt("one", "session", "original"))
    const key = "one:session"
    let resolveMutation!: (outcome: QueueMutateOutcome) => void
    const delayedMutation = new Promise<QueueMutateOutcome>((resolve) => { resolveMutation = resolve })
    __setQueueTransport({
      ...world.transport,
      mutate: () => delayedMutation,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    const pending = updateQueuedPrompt("one", "session", original.id, "stale response")
    await new Promise<void>((resolve) => setImmediate(resolve))
    const originalServer: ServerQueuedPrompt = { id: original.id, text: original.text, attachments: [], createdAt: original.createdAt }
    const newer: ServerQueueState = {
      items: [{ ...originalServer, text: "newer GET" }],
      paused: false,
      revision: "rev-newer-get",
    }
    world.queues.set(key, newer)
    world.open()
    await new Promise<void>((resolve) => setImmediate(resolve))

    resolveMutation({
      status: "ok",
      state: { ...newer, items: [{ ...originalServer, text: "stale response" }], revision: "rev-old-response" },
    })
    await pending
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["newer GET"])
  })

  it("migrates the 0.0.2 localStorage queue once after durable server imports", async () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => { values.delete(key) },
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size },
    }
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
    values.set("saiwork.prompt-queue.v1", JSON.stringify({
      "one:legacy-session": {
        items: [{ id: "legacy-1", text: "legacy prompt", attachments: [], createdAt: 123 }],
        paused: true,
      },
    }))
    try {
      assert.equal(await migrateLegacyQueueStorage(), true)
      assert.equal(values.has("saiwork.prompt-queue.v1"), false)
      assert.deepEqual(getQueue("one", "legacy-session").map((item) => item.id), ["legacy-1"])
      assert.equal(world.queues.get("one:legacy-session")?.paused, true)
    } finally {
      delete (globalThis as { localStorage?: Storage }).localStorage
    }
  })

  it("migrates a legacy snapshot updated by another window before cleanup", async () => {
    const first = JSON.stringify({
      "one:first": { items: [{ id: "legacy-1", text: "first", attachments: [], createdAt: 1 }], paused: false },
    })
    const second = JSON.stringify({
      "one:first": { items: [{ id: "legacy-1", text: "first", attachments: [], createdAt: 1 }], paused: false },
      "one:second": { items: [{ id: "legacy-2", text: "second", attachments: [], createdAt: 2 }], paused: false },
    })
    let reads = 0
    let removed = false
    const storage = {
      getItem: () => removed ? null : (++reads === 1 ? first : second),
      setItem() {},
      removeItem: () => { removed = true },
      clear() {},
      key: () => null,
      get length() { return removed ? 0 : 1 },
    }
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
    try {
      assert.equal(await migrateLegacyQueueStorage(), true)
      assert.equal(removed, true)
      assert.deepEqual(getQueue("one", "first").map((item) => item.id), ["legacy-1"])
      assert.deepEqual(getQueue("one", "second").map((item) => item.id), ["legacy-2"])
    } finally {
      delete (globalThis as { localStorage?: Storage }).localStorage
    }
  })

  it("fans out to each unique target", async () => {
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

  it("atomic fan-out: one stale target aborts the whole batch", async () => {
    // Another window adds to target B without this renderer knowing, so the
    // mirror's revision for B is stale. The server transaction aborts the WHOLE
    // batch: target A gets nothing either -- never a partial fan-out.
    await world.transport.mutate("two:session-b", "", { op: "enqueue", text: "foreign", attachments: [] })

    const result = await enqueuePromptFanOut(
      [{ instanceId: "one", sessionId: "session-a" }, { instanceId: "two", sessionId: "session-b" }],
      "shared",
    )
    assert.equal(result.ok, false)
    // Target A did NOT receive a partial enqueue.
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
