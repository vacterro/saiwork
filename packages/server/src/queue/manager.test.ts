import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { MAX_QUEUED_ATTACHMENT_BYTES } from "../api-types"
import type { QueueMutation, QueueMutationResult, QueueState } from "../api-types"
import { EventBus } from "../events/bus"
import { QueueManager, type QueuePersistenceAdapter } from "./manager"

const tempDirs = new Set<string>()

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-queue-test-"))
  tempDirs.add(dir)
  return dir
}

function createManager(statePath: string | null = null, persistence?: Partial<QueuePersistenceAdapter>) {
  const eventBus = new EventBus()
  const events: Array<Extract<import("../api-types").WorkspaceEventPayload, { type: "queue.changed" }>> = []
  eventBus.on("queue.changed", (event) => events.push(event as never))
  const manager = new QueueManager({ statePath, eventBus, logger: { debug() {}, warn() {}, error() {}, info() {} } as never, persistence })
  return { eventBus, events, manager }
}

async function mutate(manager: QueueManager, key: string, expectedRevision: string, mutation: QueueMutation) {
  return manager.mutate(key, expectedRevision, mutation)
}

/** Unwraps a successful mutation, failing the test if the CAS refused it. */
async function okState(result: Promise<QueueMutationResult>): Promise<QueueState> {
  const value = await result
  assert.equal(value.ok, true, `expected the mutation to apply, got ${JSON.stringify(value)}`)
  if (!value.ok) throw new Error("unreachable")
  return value.state
}

async function seed(manager: QueueManager, key: string, text = "hello"): Promise<string> {
  const state = await okState(mutate(manager, key, "", { op: "enqueue", text, attachments: [] }))
  return state.revision
}

function textAttachment(value: string) {
  return {
    id: "attachment-1",
    type: "text" as const,
    display: "pasted text",
    url: "data:text/plain;base64,",
    filename: "pasted.txt",
    mediaType: "text/plain",
    source: { type: "text" as const, value },
  }
}

describe("queue manager", () => {
  it("enqueues and dequeues with a CAS revision", async () => {
    const { manager } = createManager()
    const revision = await seed(manager, "inst:session", "first")
    assert.ok(revision.length > 0)

    const second = await mutate(manager, "inst:session", revision, { op: "enqueue", text: "second", attachments: [] })
    assert.equal(second.ok, true)
    const secondState = second as Extract<QueueMutationResult, { ok: true }>

    const dequeue = await mutate(manager, "inst:session", secondState.state.revision, { op: "dequeue" })
    assert.ok(dequeue.ok)
    if (!dequeue.ok) throw new Error("unreachable")
    assert.equal(dequeue.dequeued?.text, "first")

    const after = manager.get("inst:session")
    assert.deepEqual(after?.items.map((item) => item.text), ["second"])
  })

  it("rejects a stale mutation with a structured conflict and changes nothing", async () => {
    const { manager } = createManager()
    await seed(manager, "inst:session")

    const stale = await mutate(manager, "inst:session", "stale-revision", { op: "clear" })
    assert.equal(stale.ok, false)
    if (stale.ok) throw new Error("unreachable")
    assert.equal(stale.code, "conflict")
    assert.ok(stale.currentRevision.length > 0)

    const after = manager.get("inst:session")
    assert.deepEqual(after?.items.map((item) => item.text), ["hello"])
  })

  it("lets exactly one of two concurrent enqueues win (no lost item)", async () => {
    const { manager } = createManager()
    const [a, b] = await Promise.all([
      mutate(manager, "inst:session", "", { op: "enqueue", text: "A", attachments: [] }),
      mutate(manager, "inst:session", "", { op: "enqueue", text: "B", attachments: [] }),
    ])
    const okCount = [a, b].filter((result) => result.ok).length
    assert.equal(okCount, 1)
    assert.equal(manager.get("inst:session")?.items.length, 1)
  })

  it("lets exactly one of two concurrent dequeues win (at most one dispatch)", async () => {
    const { manager } = createManager()
    await seed(manager, "inst:session", "A")
    const revision = manager.get("inst:session")?.revision ?? ""

    const [first, second] = await Promise.all([
      mutate(manager, "inst:session", revision, { op: "dequeue" }),
      mutate(manager, "inst:session", revision, { op: "dequeue" }),
    ])
    const winners = [first, second].filter((result): result is Extract<QueueMutationResult, { ok: true }> => result.ok)
    assert.equal(winners.length, 1)
    assert.equal(winners[0]?.dequeued?.text, "A")
    assert.equal(manager.get("inst:session"), null)
  })

  it("refuses dequeue while paused or empty", async () => {
    const { manager } = createManager()
    assert.equal((await mutate(manager, "inst:session", "", { op: "dequeue" })).ok, false)
    const revision = await seed(manager, "inst:session")
    await mutate(manager, "inst:session", revision, { op: "set-paused", paused: true })
    assert.equal((await mutate(manager, "inst:session", manager.get("inst:session")!.revision, { op: "dequeue" })).ok, false)
  })

  it("moves, updates, removes, clears and pauses with revision bumps", async () => {
    const { manager } = createManager()
    let revision = await seed(manager, "inst:session", "A")
    revision = (await okState(mutate(manager, "inst:session", revision, { op: "enqueue", text: "B", attachments: [] }))).revision
    revision = (await okState(mutate(manager, "inst:session", revision, { op: "enqueue", text: "C", attachments: [] }))).revision

    const ids = manager.get("inst:session")!.items.map((item) => item.id)
    revision = (await okState(mutate(manager, "inst:session", revision, { op: "move", id: ids[2]!, delta: -2 }))).revision
    assert.deepEqual(manager.get("inst:session")!.items.map((item) => item.text), ["C", "A", "B"])

    revision = (await okState(mutate(manager, "inst:session", revision, { op: "update", id: ids[1]!, text: "A2" }))).revision
    assert.deepEqual(manager.get("inst:session")!.items.map((item) => item.text), ["C", "A", "A2"])

    revision = (await okState(mutate(manager, "inst:session", revision, { op: "remove", id: ids[0]! }))).revision
    assert.deepEqual(manager.get("inst:session")!.items.map((item) => item.text), ["C", "A2"])

    revision = (await okState(mutate(manager, "inst:session", revision, { op: "set-paused", paused: true }))).revision
    assert.equal(manager.get("inst:session")!.paused, true)

    revision = (await okState(mutate(manager, "inst:session", revision, { op: "clear" }))).revision
    assert.deepEqual(manager.get("inst:session")!.items, [])
    assert.equal(manager.get("inst:session")!.paused, true)
  })

  it("publishes queue.changed after a successful mutation", async () => {
    const { manager, events } = createManager()
    await seed(manager, "inst:session")
    assert.equal(events.length, 1)
    assert.equal(events[0]!.type, "queue.changed")
    assert.equal(events[0]!.key, "inst:session")
    assert.deepEqual(events[0]!.state.items.map((item) => item.text), ["hello"])
  })

  it("returns the absent queue revision after dequeuing the final item", async () => {
    const manager = createManager().manager
    const revision = await seed(manager, "inst:session", "only")
    const result = await mutate(manager, "inst:session", revision, { op: "dequeue" })
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.equal(result.state.revision, "")
    assert.equal(manager.get("inst:session"), null)
    assert.equal((await mutate(manager, "inst:session", "", { op: "enqueue", text: "next" })).ok, true)
  })

  it("enforces UTF-8 attachment limits on enqueue and update", async () => {
    const { manager } = createManager()
    const oversized = textAttachment("é".repeat(MAX_QUEUED_ATTACHMENT_BYTES / 2))

    const enqueue = await mutate(manager, "inst:session", "", { op: "enqueue", text: "A", attachments: [oversized] })
    assert.deepEqual(enqueue, { ok: false, code: "too-large" })
    assert.equal(manager.get("inst:session"), null)

    const revision = await seed(manager, "inst:session", "A")
    const update = await mutate(manager, "inst:session", revision, {
      op: "update",
      id: manager.get("inst:session")!.items[0]!.id,
      text: "A",
      attachments: [oversized],
    })
    assert.deepEqual(update, { ok: false, code: "too-large" })
    assert.equal(manager.get("inst:session")!.revision, revision)
    assert.deepEqual(manager.get("inst:session")!.items[0]!.attachments, [])
  })

  it("imports a legacy item idempotently without changing its identity or order", async () => {
    const manager = createManager().manager
    const item = { id: "legacy-1", text: "saved prompt", attachments: [], createdAt: 123 }
    const first = await mutate(manager, "inst:session", "", { op: "import-legacy", item })
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error("unreachable")
    const second = await mutate(manager, "inst:session", first.state.revision, { op: "import-legacy", item })
    assert.equal(second.ok, true)
    assert.deepEqual(manager.get("inst:session")?.items, [item])
  })

  it("restores a definitely unsent dequeue at the front and pauses atomically", async () => {
    const manager = createManager().manager
    let revision = await seed(manager, "inst:session", "first")
    const second = await mutate(manager, "inst:session", revision, { op: "enqueue", text: "second" })
    assert.equal(second.ok, true)
    if (!second.ok) throw new Error("unreachable")
    const dequeued = await mutate(manager, "inst:session", second.state.revision, { op: "dequeue" })
    assert.equal(dequeued.ok, true)
    if (!dequeued.ok || !dequeued.dequeued) throw new Error("unreachable")
    revision = dequeued.state.revision
    const restored = await mutate(manager, "inst:session", revision, { op: "restore", item: dequeued.dequeued, pause: true })
    assert.equal(restored.ok, true)
    if (!restored.ok) throw new Error("unreachable")
    assert.deepEqual(restored.state.items.map((item) => item.text), ["first", "second"])
    assert.equal(restored.state.paused, true)
  })

  it("rejects an invalid key", async () => {
    const { manager } = createManager()
    assert.equal(QueueManager.isValidKey("inst:session"), true)
    assert.equal(QueueManager.isValidKey("../../etc"), false)
    assert.equal(QueueManager.isValidKey("no-separator"), false)
    assert.equal(QueueManager.isValidKey("a:b c"), false)
    const result = await mutate(manager, "../../etc", "", { op: "enqueue", text: "x", attachments: [] })
    assert.equal(result.ok, false)
  })

  it("persists state and reloads it in a fresh manager", async () => {
    const dir = createTempDir()
    const statePath = path.join(dir, "prompt-queue.json")
    const first = createManager(statePath)
    const revision = await seed(first.manager, "inst:session", "persisted")
    await mutate(first.manager, "inst:session", revision, { op: "enqueue", text: "second", attachments: [] })
    await first.manager.flush()

    const second = createManager(statePath)
    const state = second.manager.get("inst:session")
    assert.deepEqual(state?.items.map((item) => item.text), ["persisted", "second"])
  })

  it("serializes concurrent mutations for different keys through one file transaction", async () => {
    const writes: string[] = []
    const persistence: Partial<QueuePersistenceAdapter> = {
      exists: async () => false,
      mkdir: async () => {},
      write: async (_filePath, content) => { writes.push(content) },
      rename: async () => {},
      remove: async () => {},
      syncDirectory: async () => {},
    }
    const { manager, events } = createManager("virtual/prompt-queue.json", persistence)

    const [first, second] = await Promise.all([
      mutate(manager, "inst:first", "", { op: "enqueue", text: "A", attachments: [] }),
      mutate(manager, "inst:second", "", { op: "enqueue", text: "B", attachments: [] }),
    ])

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(writes.length, 2)
    assert.match(writes[0]!, /"inst:first"/)
    assert.doesNotMatch(writes[0]!, /"inst:second"/)
    assert.match(writes[1]!, /"inst:first"/)
    assert.match(writes[1]!, /"inst:second"/)
    assert.deepEqual(events.map((event) => event.key), ["inst:first", "inst:second"])
  })

  it("flush waits for a mutation admitted before shutdown", async () => {
    const manager = createManager().manager
    const mutation = manager.mutate("inst:session", "", { op: "enqueue", text: "pending" })
    await manager.flush()
    const result = await mutation
    assert.equal(result.ok, true)
    assert.equal(manager.get("inst:session")?.items[0]?.text, "pending")
  })

  it("returns a structured write failure without memory, revision, or event success", async () => {
    const persistence: Partial<QueuePersistenceAdapter> = {
      exists: async () => false,
      mkdir: async () => {},
      write: async () => { throw new Error("injected write failure") },
      rename: async () => {},
      remove: async () => {},
    }
    const { manager, events } = createManager("virtual/prompt-queue.json", persistence)

    const result = await mutate(manager, "inst:session", "", { op: "enqueue", text: "not durable", attachments: [] })

    assert.equal(result.ok, false)
    if (result.ok || result.code !== "storage") throw new Error("expected storage failure")
    assert.equal(result.error.operation, "write")
    assert.equal(manager.get("inst:session"), null)
    assert.deepEqual(events, [])
  })

  it("returns no dequeued item on rename failure and reloads the original item after restart", async () => {
    const dir = createTempDir()
    const statePath = path.join(dir, "prompt-queue.json")
    const seeded = createManager(statePath)
    await seed(seeded.manager, "inst:session", "durable")
    const originalBytes = fs.readFileSync(statePath, "utf8")

    const failing = createManager(statePath, {
      rename: async () => { throw new Error("injected rename failure") },
    })
    const revision = failing.manager.get("inst:session")!.revision
    const result = await mutate(failing.manager, "inst:session", revision, { op: "dequeue" })

    assert.equal(result.ok, false)
    if (result.ok || result.code !== "storage") throw new Error("expected storage failure")
    assert.equal(result.error.operation, "rename")
    assert.equal("dequeued" in result, false)
    assert.deepEqual(failing.manager.get("inst:session")!.items.map((item) => item.text), ["durable"])
    assert.deepEqual(failing.events, [])
    assert.equal(fs.readFileSync(statePath, "utf8"), originalBytes)

    const restarted = createManager(statePath)
    assert.deepEqual(restarted.manager.get("inst:session")!.items.map((item) => item.text), ["durable"])
  })

  it("rolls back a directory fsync failure before reporting storage failure", async () => {
    const dir = createTempDir()
    const statePath = path.join(dir, "prompt-queue.json")
    const seeded = createManager(statePath)
    await seed(seeded.manager, "inst:session", "durable")
    const revision = seeded.manager.get("inst:session")!.revision
    let syncCalls = 0
    const failing = createManager(statePath, {
      syncDirectory: async () => {
        syncCalls += 1
        if (syncCalls === 1) throw new Error("injected directory fsync failure")
      },
    })
    const result = await mutate(failing.manager, "inst:session", revision, { op: "dequeue" })
    assert.equal(result.ok, false)
    if (result.ok) throw new Error("unreachable")
    assert.equal(result.code, "storage")
    if (result.code === "storage") assert.equal(result.error.operation, "fsync")
    assert.equal("dequeued" in result, false)
    assert.equal(failing.manager.get("inst:session")?.items[0]?.text, "durable")
    assert.equal(createManager(statePath).manager.get("inst:session")?.items[0]?.text, "durable")
  })

  it("fails closed on corrupt and future persistence without overwriting bytes", async () => {
    const dir = createTempDir()
    const fixtures = ["{ not json", JSON.stringify({ version: 2, queues: {} })]

    for (const [index, bytes] of fixtures.entries()) {
      const statePath = path.join(dir, `prompt-queue-${index}.json`)
      fs.writeFileSync(statePath, bytes)
      const { manager, events } = createManager(statePath)
      assert.equal(manager.getStorageFailure()?.operation, "load")

      const result = await mutate(manager, "inst:session", "", { op: "enqueue", text: "must not land", attachments: [] })
      assert.equal(result.ok, false)
      if (result.ok || result.code !== "storage") throw new Error("expected storage failure")
      assert.equal(result.error.operation, "load")
      assert.equal(fs.readFileSync(statePath, "utf8"), bytes)
      assert.equal(manager.get("inst:session"), null)
      assert.deepEqual(events, [])
    }
  })
})

describe("QueueManager.mutateMany atomic fan-out", () => {
  it("commits all targets on success with one new item each", async () => {
    const { manager } = createManager()
    const revA = await seed(manager, "i:a")
    const revB = await seed(manager, "i:b")
    const result = await manager.mutateMany([
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "fan", attachments: [] } },
      { key: "i:b", expectedRevision: revB, mutation: { op: "enqueue", text: "fan", attachments: [] } },
    ])
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.equal(result.states.length, 2)
    for (const { state } of result.states) assert.equal(state.items.length, 2)
    assert.equal(manager.get("i:a")!.items[1].text, "fan")
    assert.equal(manager.get("i:b")!.items[1].text, "fan")
  })

  it("second target conflict => zero targets changed", async () => {
    const { manager } = createManager()
    const revA = await seed(manager, "i:a")
    const revB = await seed(manager, "i:b")
    const result = await manager.mutateMany([
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "fan", attachments: [] } },
      { key: "i:b", expectedRevision: "stale", mutation: { op: "enqueue", text: "fan", attachments: [] } },
    ])
    assert.equal(result.ok, false)
    if (result.ok) throw new Error("unreachable")
    assert.equal(result.code, "conflict")
    assert.equal(manager.get("i:a")!.items.length, 1, "target A must NOT have committed")
    assert.equal(manager.get("i:b")!.items.length, 1)
  })

  it("persistence failure => zero targets changed and disk untouched", async () => {
    const dir = createTempDir()
    const statePath = path.join(dir, "queue.json")
    let failRename = false
    const { manager } = createManager(statePath, {
      rename: async (from: string, to: string) => {
        if (failRename) throw new Error("EACCES")
        fs.renameSync(from, to)
      },
    })
    const revA = await seed(manager, "i:a")
    const revB = await seed(manager, "i:b")
    const onDiskBefore = fs.readFileSync(statePath, "utf8")
    failRename = true
    const result = await manager.mutateMany([
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "fan", attachments: [] } },
      { key: "i:b", expectedRevision: revB, mutation: { op: "enqueue", text: "fan", attachments: [] } },
    ])
    assert.equal(result.ok, false)
    if (result.ok) throw new Error("unreachable")
    assert.equal(result.code, "storage")
    assert.equal(manager.get("i:a")!.items.length, 1)
    assert.equal(manager.get("i:b")!.items.length, 1)
    assert.equal(fs.readFileSync(statePath, "utf8"), onDiskBefore, "disk snapshot must be unchanged")
  })

  it("duplicate targets are deduped to one item per unique key", async () => {
    const { manager } = createManager()
    const revA = await seed(manager, "i:a")
    const result = await manager.mutateMany([
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "fan", attachments: [] } },
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "fan", attachments: [] } },
    ])
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.equal(result.states.length, 1)
    assert.equal(manager.get("i:a")!.items.length, 2)
  })

  it("two racing fan-outs serialize to one coherent winner, never partial", async () => {
    const { manager } = createManager()
    const revA = await seed(manager, "i:a")
    const revB = await seed(manager, "i:b")
    const first = manager.mutateMany([
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "first", attachments: [] } },
      { key: "i:b", expectedRevision: revB, mutation: { op: "enqueue", text: "first", attachments: [] } },
    ])
    const second = manager.mutateMany([
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "second", attachments: [] } },
      { key: "i:b", expectedRevision: revB, mutation: { op: "enqueue", text: "second", attachments: [] } },
    ])
    const [r1, r2] = await Promise.all([first, second])
    const okCount = [r1, r2].filter((r) => r.ok).length
    assert.equal(okCount, 1, "exactly one fan-out wins the race")
    assert.equal(manager.get("i:a")!.items.length, 2, "winner committed on A")
    assert.equal(manager.get("i:b")!.items.length, 2, "winner committed on B")
  })

  it("no ghost prompt can dispatch after a failed fan-out", async () => {
    const { manager } = createManager()
    const revA = await seed(manager, "i:a")
    const revB = await seed(manager, "i:b")
    await manager.mutateMany([
      { key: "i:a", expectedRevision: revA, mutation: { op: "enqueue", text: "ghost", attachments: [] } },
      { key: "i:b", expectedRevision: "stale", mutation: { op: "enqueue", text: "ghost", attachments: [] } },
    ])
    const stateA = manager.get("i:a")!
    const stateB = manager.get("i:b")!
    assert.equal(stateA.items.length, 1)
    assert.equal(stateB.items.length, 1)
    const dequeuedA = await manager.mutate("i:a", stateA.revision, { op: "dequeue" })
    assert.equal(dequeuedA.ok, true)
    if (!dequeuedA.ok) throw new Error("unreachable")
    assert.equal(dequeuedA.dequeued?.text, "hello", "only the seed may dispatch; the ghost never queued")
  })
})

describe("queue manager purge", () => {
  it("atomically removes matching keys and survives a restart with no key or attachment left", async () => {
    const dir = createTempDir()
    const statePath = path.join(dir, "queue.json")
    const first = createManager(statePath)
    await seed(first.manager, "ws:sessA", "with attachment")
    await first.manager.mutate("ws:sessA", first.manager.get("ws:sessA")!.revision, {
      op: "enqueue",
      text: "",
      attachments: [textAttachment("pasted")],
    })
    await seed(first.manager, "ws:sessB", "stays")
    await seed(first.manager, "other:sess", "untouched")

    const result = await first.manager.purgeKeys("ws:sessA")
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.deepEqual(result.removedKeys, ["ws:sessA"])
    assert.equal(first.manager.get("ws:sessA"), null)
    assert.equal(first.manager.get("ws:sessB")?.items.length, 1)
    assert.equal(first.manager.get("other:sess")?.items.length, 1)

    const restarted = createManager(statePath)
    assert.equal(restarted.manager.get("ws:sessA"), null, "purged key must not resurrect on restart")
    assert.equal(restarted.manager.get("ws:sessB")?.items.length, 1)
    assert.equal(restarted.manager.get("other:sess")?.items.length, 1)
  })

  it("purges every key under an instance prefix in one transaction", async () => {
    const { manager, events } = createManager()
    await seed(manager, "ws:sessA")
    await seed(manager, "ws:sessB")
    await seed(manager, "other:sess")
    const eventsBefore = events.length

    const result = await manager.purgeKeys("ws:")
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error("unreachable")
    assert.deepEqual(new Set(result.removedKeys), new Set(["ws:sessA", "ws:sessB"]))
    assert.equal(manager.get("ws:sessA"), null)
    assert.equal(manager.get("ws:sessB"), null)
    assert.equal(manager.get("other:sess")?.items.length, 1)
    assert.equal(events.length - eventsBefore, 2, "one empty-state event per purged key")
  })

  it("rejects an invalid prefix and reports an empty match without error", async () => {
    const { manager } = createManager()
    const invalid = await manager.purgeKeys("no-colon")
    assert.equal(invalid.ok, false)
    if (invalid.ok) throw new Error("unreachable")
    assert.equal(invalid.code, "invalid")

    const empty = await manager.purgeKeys("ws:")
    assert.equal(empty.ok, true)
    if (!empty.ok) throw new Error("unreachable")
    assert.deepEqual(empty.removedKeys, [])
  })

  it("surfaces a persistence failure without committing memory", async () => {
    const dir = createTempDir()
    const statePath = path.join(dir, "queue.json")
    let writes = 0
    const { manager } = createManager(statePath, {
      write: async (filePath, content) => {
        writes += 1
        if (writes === 2) throw new Error("injected persistence failure")
        fs.writeFileSync(filePath, content)
      },
    })
    await seed(manager, "ws:sessA")
    const result = await manager.purgeKeys("ws:")
    assert.equal(result.ok, false)
    if (result.ok) throw new Error("unreachable")
    assert.equal(result.code, "storage")
    assert.equal(manager.get("ws:sessA")?.items.length, 1, "memory must not commit on a failed purge")
  })

  it("slow async persistence does not block unrelated event-loop work", async () => {
    const { manager } = createManager("virtual/prompt-queue.json", {
      exists: async () => false,
      mkdir: async () => {},
      write: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
      },
      rename: async () => {},
      remove: async () => {},
      syncDirectory: async () => {},
    })
    const mutation = mutate(manager, "inst:session", "", { op: "enqueue", text: "slow disk", attachments: [] })
    const started = Date.now()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const tickLatency = Date.now() - started
    assert.ok(tickLatency < 100, `event loop blocked during async persistence: ${tickLatency}ms`)
    const result = await mutation
    assert.equal(result.ok, true)
  })
})