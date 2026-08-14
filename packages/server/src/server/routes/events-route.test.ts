import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { EventSource } from "undici"
import Fastify from "fastify"
import { createBackpressuredSender, createSseBroadcaster, registerEventRoutes } from "./events"
import { sanitizeLogValue } from "../../log-sanitize"
import { EventBus } from "../../events/bus"

const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra }) as never
const ser = (type: string) => ({ frame: `data: ${JSON.stringify({ type })}\n\n`, type })

describe("backpressured SSE sender", () => {
  it("disconnects a slow client instead of buffering unboundedly", () => {
    const frames: string[] = []
    let overflows = 0
    const sender = createBackpressuredSender({
      writeFrame: (frame) => {
        frames.push(frame)
        return false // never drains
      },
      onOverflow: () => { overflows += 1 },
    })

    for (let i = 0; i < 10_000; i += 1) {
      sender.send(ser(`type-${i}`), event(`type-${i}`))
    }

    assert.ok(frames.length <= 1, "a never-draining client must receive at most the first frame")
    assert.equal(overflows, 1, "the backlog overflow disconnects exactly once")
    assert.ok(sender.pendingCount <= 64, "the in-memory backlog stays bounded")
  })

  it("queues a bounded FIFO backlog preserving order and identity, and flushes on drain", () => {
    const frames: string[] = []
    const sender = createBackpressuredSender({
      writeFrame: (frame) => {
        frames.push(frame)
        return false
      },
      onOverflow: () => {},
      maxPending: 4,
    })

    sender.send(ser("a"), event("a"))
    sender.send(ser("b"), event("b"))
    sender.send({ frame: "second-a-frame\n\n", type: "a" }, event("a")) // same type, distinct entity
    sender.send(ser("c"), event("c"))
    assert.equal(sender.pendingCount, 3, "same-type events are NOT coalesced; every entity event is kept in order")

    let allow = false
    const draining = createBackpressuredSender({
      writeFrame: (frame) => {
        frames.push(frame)
        return allow
      },
      onOverflow: () => {},
    })
    draining.send(ser("x"), event("x")) // buffered by the writer (write=false), enters backpressure
    draining.send(ser("y"), event("y")) // queued while backpressured
    draining.send(ser("z"), event("z")) // queued while backpressured
    draining.flush() // writer still backpressured: y is attempted and accepted by the writer
    assert.equal(draining.pendingCount, 1, "flush stops while the writer stays backpressured")
    allow = true
    draining.flush()
    assert.equal(draining.pendingCount, 0, "a later drain continues from the backlog")
    assert.deepEqual(frames.slice(-3), ['data: {"type":"x"}\n\n', 'data: {"type":"y"}\n\n', 'data: {"type":"z"}\n\n'], "FIFO order is preserved with no coalescing")
  })

  it("never resends a frame the writer already buffered when backpressure begins", () => {
    const frames: string[] = []
    let allow = true
    const sender = createBackpressuredSender({
      writeFrame: (frame) => {
        frames.push(frame)
        if (frame.startsWith("data: first")) {
          allow = false
          return false // first backpressure: the frame is already buffered by Node
        }
        return allow
      },
      onOverflow: () => {},
    })

    sender.send(ser("first"), event("first")) // buffered by the writer, enters backpressure
    sender.send(ser("second"), event("second")) // queued while backpressured
    sender.send(ser("third"), event("third")) // queued while backpressured
    sender.flush() // drain: must NOT resend "first"; only the queued backlog
    assert.equal(frames.length, 3, "every frame appears exactly once, in order")
    assert.deepEqual(
      frames.map((frame) => JSON.parse(frame.slice("data: ".length)).type),
      ["first", "second", "third"],
    )
  })

  it("stops sending and drops the backlog after close", () => {
    const frames: string[] = []
    const sender = createBackpressuredSender({
      writeFrame: (frame) => {
        frames.push(frame)
        return false
      },
      onOverflow: () => {},
    })
    sender.send(ser("a"), event("a"))
    sender.close()
    sender.flush()
    sender.send(ser("b"), event("b"))
    assert.equal(sender.pendingCount, 0, "no events are buffered after close")
  })
})

describe("SSE broadcaster", () => {
  it("serializes each event exactly once and fans out the same frame", () => {
    const bus = new EventBus()
    const broadcaster = createSseBroadcaster(bus)
    const clientA: string[] = []
    const clientB: string[] = []
    const unA = broadcaster.subscribe((serialized) => { clientA.push(serialized.frame) })
    const unB = broadcaster.subscribe((serialized) => { clientB.push(serialized.frame) })

    bus.publish({ type: "instance.event", instanceId: "i", event: { type: "x" } } as never)
    bus.publish({ type: "instance.event", instanceId: "i", event: { type: "y" } } as never)

    assert.equal(clientA.length, 2)
    assert.equal(clientB.length, 2)
    assert.equal(clientA[0], clientB[0], "both clients receive the identical pre-serialized frame")
    unA()
    unB()
    broadcaster.stop()
  })

  it("stops fanning out to unsubscribed clients", () => {
    const bus = new EventBus()
    const broadcaster = createSseBroadcaster(bus)
    const received: string[] = []
    const unsub = broadcaster.subscribe((serialized) => { received.push(serialized.frame) })
    unsub()
    bus.publish({ type: "instance.event", instanceId: "i", event: { type: "x" } } as never)
    assert.equal(received.length, 0)
    broadcaster.stop()
  })
})

describe("SSE trace payload sanitization", () => {
  it("never leaks secrets verbatim into sanitized trace args", () => {
    const payload = {
      type: "settings.changed",
      value: { password: "SuperSecret", apiKey: "sk-leak", note: "hello WORLD" },
    }
    const sanitized = sanitizeLogValue(payload)
    const serialized = JSON.stringify(sanitized)
    assert.equal(serialized.includes("SuperSecret"), false)
    assert.equal(serialized.includes("sk-leak"), false)
    assert.equal(serialized.includes("hello WORLD"), true, "non-secret content survives")
    assert.ok(serialized.includes("[REDACTED]"))
  })

  it("bounds a long event payload", () => {
    const payload = { type: "x", content: "y".repeat(100_000) }
    const sanitized = sanitizeLogValue(payload) as { content: string }
    assert.ok(sanitized.content.length < 5_000, "trace logging must not serialize a huge payload")
  })
})

describe("SSE route with a real EventSource", () => {
  const nullLogger = {
    debug: () => {},
    warn: () => {},
    trace: () => {},
    info: () => {},
    error: () => {},
    isLevelEnabled: () => false,
  }

  it("publishes one bus event and the EventSource receives exactly one onmessage with a parseable data payload", async (t) => {
    const bus = new EventBus()
    const app = Fastify({ logger: false })
    registerEventRoutes(app, {
      eventBus: bus,
      registerClient: () => () => {},
      logger: nullLogger as never,
      connectionManager: { register: () => () => {} } as never,
    })
    const port = await new Promise<number>((resolve) => {
      app.listen({ port: 0, host: "127.0.0.1" }, () => resolve((app.server.address() as { port: number }).port))
    })

    const source = new EventSource(`http://127.0.0.1:${port}/api/events?clientId=it-client&connectionId=it-conn`)
    t.after(async () => {
      source.close()
      await app.close()
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("EventSource did not open")), 3_000)
      source.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
    })

    const payload = { type: "instance.event", instanceId: "i", event: { type: "audit" } }
    const messages: string[] = []
    source.onmessage = (message) => messages.push(String(message.data))

    await new Promise((resolve) => setTimeout(resolve, 50)) // let the route's subscription register
    bus.publish(payload as never)

    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 2_000
      const poll = () => {
        if (messages.length >= 1 || Date.now() > deadline) return resolve()
        setTimeout(poll, 25)
      }
      poll()
    })
    assert.equal(messages.length, 1, "exactly one onmessage per published event")
    assert.deepEqual(JSON.parse(messages[0]), payload, "event.data parses back to the original payload")
  })
})
