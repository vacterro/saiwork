import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import Fastify from "fastify"

import type { QueueState } from "../../api-types"
import { EventBus } from "../../events/bus"
import { QueueManager } from "../../queue/manager"
import { registerQueueRoutes } from "./queue"

const managers: QueueManager[] = []

afterEach(() => {
  for (const manager of managers) manager.flush()
  managers.length = 0
})

function createApp() {
  const eventBus = new EventBus()
  const queueManager = new QueueManager({ statePath: null, eventBus, logger: { debug() {}, warn() {}, error() {} } as never })
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
    const body = stale.json() as { error: string; currentRevision: string }
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
})
