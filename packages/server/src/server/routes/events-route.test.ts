import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createBackpressuredSender, createSseBroadcaster } from "./events"
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

  it("coalesces a bounded backlog by type and flushes on drain", () => {
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
    sender.send({ frame: "newest-a-frame\n\n", type: "a" }, event("a")) // newest a replaces the backlogged a
    assert.equal(sender.pendingCount, 2, "same-type events coalesce to the newest")

    let allow = false
    const draining = createBackpressuredSender({
      writeFrame: (frame) => {
        frames.push(frame)
        return allow
      },
      onOverflow: () => {},
    })
    draining.send(ser("x"), event("x"))
    draining.send(ser("y"), event("y"))
    draining.flush() // writer still backpressured: only the first backlogged frame is attempted
    assert.equal(draining.pendingCount, 1, "flush stops while the writer stays backpressured")
    allow = true
    draining.flush()
    assert.equal(draining.pendingCount, 0, "a later drain continues from the backlog")
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
