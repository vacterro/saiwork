import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import type { QueueState } from "../api-types"
import { EventBus } from "../events/bus"
import { QueueManager, type QueueMutation, type QueueMutationResult } from "./manager"

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

function createManager(statePath: string | null = null) {
  const eventBus = new EventBus()
  const events: Array<Extract<import("../api-types").WorkspaceEventPayload, { type: "queue.changed" }>> = []
  eventBus.on("queue.changed", (event) => events.push(event as never))
  const manager = new QueueManager({ statePath, eventBus, logger: { debug() {}, warn() {}, error() {}, info() {} } as never })
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

  it("restores a failed dequeue at the front and dedupes by id", async () => {
    const { manager } = createManager()
    const revision = await seed(manager, "inst:session", "A")
    await mutate(manager, "inst:session", revision, { op: "enqueue", text: "B", attachments: [] })
    const before = manager.get("inst:session")!
    const dequeue = await mutate(manager, "inst:session", before.revision, { op: "dequeue" })
    assert.ok(dequeue.ok)
    if (!dequeue.ok) throw new Error("unreachable")
    const item = dequeue.dequeued
    assert.ok(item)

    await mutate(manager, "inst:session", manager.get("inst:session")!.revision, { op: "restore", item })
    await mutate(manager, "inst:session", manager.get("inst:session")!.revision, { op: "restore", item })
    const after = manager.get("inst:session")!
    assert.deepEqual(after.items.map((queued) => queued.text), ["A", "B"])
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

  it("starts empty on an unreadable persistence file", async () => {
    const dir = createTempDir()
    const statePath = path.join(dir, "prompt-queue.json")
    fs.writeFileSync(statePath, "{ not json")
    const { manager } = createManager(statePath)
    assert.equal(manager.getAll()["inst:session"], undefined)
  })
})
