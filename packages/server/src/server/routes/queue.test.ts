import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import Fastify from "fastify"

import type { QueueState } from "../../api-types"
import { EventBus } from "../../events/bus"
import { QueueManager, type QueuePersistenceAdapter } from "../../queue/manager"
import { registerQueueRoutes } from "./queue"

const managers: QueueManager[] = []

afterEach(async () => {
  for (const manager of managers) await manager.flush()
  managers.length = 0
})

function createApp(options?: { statePath?: string; persistence?: Partial<QueuePersistenceAdapter> }) {
  const eventBus = new EventBus()
  const queueManager = new QueueManager({
    statePath: options?.statePath ?? null,
    eventBus,
    logger: { debug() {}, warn() {}, error() {} } as never,
    persistence: options?.persistence,
  })
  managers.push(queueManager)
  const app = Fastify({ logger: false })
  registerQueueRoutes(app, { queueManager })
  return { app, queueManager, eventBus }
}

const MUTATE = "/api/queue/mutate"

describe("queue routes", () => {
  it("lists queues and returns empty state for unknown keys", async () => {
    const { app } = createApp()
    const empty = await app.inject({ method: "GET", url: "/api/queue" })
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json(), { queues: {} })

    const single = await app.inject({ method: "GET", url: "/api/queue?key=inst%3Asession" })
    assert.deepEqual(single.json(), { queues: {} })
    await app.close()
  })

  it("enqueues, lists and dequeues through the API", async () => {
    const { app } = createApp()
    const enqueue = await app.inject({
      method: "POST",
      url: MUTATE,
      payload: { op: "enqueue", key: "inst:session", expectedRevision: "", text: "hello", attachments: [] },
    })
    assert.equal(enqueue.statusCode, 200)
    const created = enqueue.json() as { ok: true; state: QueueState }
    assert.equal(created.state.items[0]?.text, "hello")
    assert.ok(created.state.revision.length > 0)

    const list = await app.inject({ method: "GET", url: "/api/queue?key=inst%3Asession" })
    assert.equal(list.json().queues["inst:session"].items.length, 1)

    const dequeue = await app.inject({
      method: "POST",
      url: MUTATE,
      payload: { op: "dequeue", key: "inst:session", expectedRevision: created.state.revision },
    })
    assert.equal(dequeue.statusCode, 200)
    const body = dequeue.json() as { ok: true; dequeued: { text: string } }
    assert.equal(body.dequeued.text, "hello")
    await app.close()
  })

  it("returns a structured 409 with the current revision on a stale mutation", async () => {
    const { app } = createApp()
    await app.inject({ method: "POST", url: MUTATE, payload: { op: "enqueue", key: "inst:session", expectedRevision: "", text: "hello", attachments: [] } })

    const stale = await app.inject({ method: "POST", url: MUTATE, payload: { op: "clear", key: "inst:session", expectedRevision: "stale" } })
    assert.equal(stale.statusCode, 409)
    const body = stale.json() as { ok: false; code: string; currentRevision: string; error: string }
    assert.equal(body.code, "conflict")
    assert.match(body.error, /queue changed/)
    assert.ok(body.currentRevision.length > 0)

    const list = await app.inject({ method: "GET", url: "/api/queue?key=inst%3Asession" })
    assert.equal(list.json().queues["inst:session"].items.length, 1, "stale writer must not destroy the queue")
    await app.close()
  })

  it("rejects an invalid key and an invalid body", async () => {
    const { app } = createApp()
    const badKey = await app.inject({ method: "POST", url: MUTATE, payload: { op: "enqueue", key: "../../etc", expectedRevision: "", text: "x" } })
    assert.equal(badKey.statusCode, 400)
    const badBody = await app.inject({ method: "POST", url: MUTATE, payload: { op: "nope", key: "a:b", expectedRevision: "" } })
    assert.equal(badBody.statusCode, 400)
    await app.close()
  })

  it("two clients cannot both dequeue the same item (at most one dispatch)", async () => {
    const { app } = createApp()
    await app.inject({ method: "POST", url: MUTATE, payload: { op: "enqueue", key: "inst:session", expectedRevision: "", text: "only", attachments: [] } })
    const revision = (await app.inject({ method: "GET", url: "/api/queue?key=inst%3Asession" })).json().queues["inst:session"].revision

    const dequeue = () => app.inject({
      method: "POST",
      url: MUTATE,
      payload: { op: "dequeue", key: "inst:session", expectedRevision: revision },
    })
    // Two detached-window renderers racing on the same idle transition.
    const [a, b] = await Promise.all([dequeue(), dequeue()])
    const statuses = [a, b].map((response) => response.statusCode).sort()
    assert.deepEqual(statuses, [200, 409])

    const list = await app.inject({ method: "GET", url: "/api/queue?key=inst%3Asession" })
    assert.deepEqual(list.json().queues, {}, "the item was dispatched exactly once")
    await app.close()
  })

  it("two clients cannot both enqueue over the same revision (no lost item)", async () => {
    const { app } = createApp()
    const enqueue = (text: string) => app.inject({
      method: "POST",
      url: MUTATE,
      payload: { op: "enqueue", key: "inst:session", expectedRevision: "", text, attachments: [] },
    })
    const [a, b] = await Promise.all([enqueue("A"), enqueue("B")])
    const statuses = [a, b].map((response) => response.statusCode).sort()
    assert.deepEqual(statuses, [200, 409])

    const list = await app.inject({ method: "GET", url: "/api/queue?key=inst%3Asession" })
    const items = list.json().queues["inst:session"].items as Array<{ text: string }>
    assert.equal(items.length, 1)
    await app.close()
  })

  it("publishes queue.changed over the event bus", async () => {
    const { app, eventBus } = createApp()
    const changes: string[] = []
    eventBus.on("queue.changed", (event) => changes.push((event as { key: string }).key))

    await app.inject({ method: "POST", url: MUTATE, payload: { op: "enqueue", key: "inst:session", expectedRevision: "", text: "hi", attachments: [] } })
    assert.deepEqual(changes, ["inst:session"])
    await app.close()
  })

  it("returns a structured 503 when durable storage fails", async () => {
    const { app, queueManager } = createApp({
      statePath: "virtual/prompt-queue.json",
      persistence: {
        exists: () => false,
        mkdir() {},
        write: () => { throw new Error("injected write failure") },
        rename() {},
        remove() {},
      },
    })

    const response = await app.inject({
      method: "POST",
      url: MUTATE,
      payload: { op: "enqueue", key: "inst:session", expectedRevision: "", text: "not durable", attachments: [] },
    })

    assert.equal(response.statusCode, 503)
    assert.deepEqual(response.json(), {
      ok: false,
      code: "storage",
      error: { operation: "write", message: "Failed to write prompt queue persistence" },
    })
    assert.equal(queueManager.get("inst:session"), null)
    await app.close()
  })

  it("returns a structured 503 for unsupported persisted state", async () => {
    let wrote = false
    const { app } = createApp({
      statePath: "virtual/prompt-queue.json",
      persistence: {
        exists: () => true,
        read: () => JSON.stringify({ version: 2, queues: {} }),
        write: () => { wrote = true },
      },
    })

    const list = await app.inject({ method: "GET", url: "/api/queue" })
    assert.equal(list.statusCode, 503)
    assert.deepEqual(list.json(), {
      ok: false,
      code: "storage",
      error: { operation: "load", message: "Failed to load prompt queue persistence" },
    })

    const mutation = await app.inject({
      method: "POST",
      url: MUTATE,
      payload: { op: "enqueue", key: "inst:session", expectedRevision: "", text: "must not overwrite" },
    })
    assert.equal(mutation.statusCode, 503)
    assert.equal(wrote, false)
    await app.close()
  })
})
describe("queue fanout route", () => {
  it("atomically enqueues one item per unique target", async () => {
    const { app, queueManager } = createApp()
    await queueManager.mutate("i:a", "", { op: "enqueue", text: "seed", attachments: [] })
    await queueManager.mutate("i:b", "", { op: "enqueue", text: "seed", attachments: [] })
    const revA = queueManager.get("i:a")!.revision
    const revB = queueManager.get("i:b")!.revision
    const response = await app.inject({
      method: "POST",
      url: "/api/queue/fanout",
      payload: { targets: [{ key: "i:a", expectedRevision: revA }, { key: "i:b", expectedRevision: revB }], text: "fan" },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.ok, true)
    assert.equal(body.items.length, 2)
    assert.equal(queueManager.get("i:a")!.items.length, 2)
    assert.equal(queueManager.get("i:b")!.items.length, 2)
    await app.close()
  })

  it("conflict on any target returns 409 and commits nothing", async () => {
    const { app, queueManager } = createApp()
    await queueManager.mutate("i:a", "", { op: "enqueue", text: "seed", attachments: [] })
    const revA2 = queueManager.get("i:a")!.revision
    const response = await app.inject({
      method: "POST",
      url: "/api/queue/fanout",
      payload: { targets: [{ key: "i:a", expectedRevision: revA2 }, { key: "i:b", expectedRevision: "stale" }], text: "fan" },
    })
    assert.equal(response.statusCode, 409)
    assert.equal(queueManager.get("i:a")!.items.length, 1, "A must not have committed")
    assert.equal(queueManager.get("i:b"), null)
    await app.close()
  })

  it("dedupes duplicate targets", async () => {
    const { app, queueManager } = createApp()
    await queueManager.mutate("i:a", "", { op: "enqueue", text: "seed", attachments: [] })
    const revA2 = queueManager.get("i:a")!.revision
    const response = await app.inject({
      method: "POST",
      url: "/api/queue/fanout",
      payload: { targets: [{ key: "i:a", expectedRevision: revA2 }, { key: "i:a", expectedRevision: revA2 }], text: "fan" },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().items.length, 1)
    assert.equal(queueManager.get("i:a")!.items.length, 2)
    await app.close()
  })
})