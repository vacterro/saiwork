import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createBackpressuredSender } from "./events"
import { sanitizeLogValue } from "../../log-sanitize"

const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra }) as never

describe("backpressured SSE sender", () => {
  it("disconnects a slow client instead of buffering unboundedly", () => {
    const frames: unknown[] = []
    let overflows = 0
    const sender = createBackpressuredSender({
      writeFrame: (payload) => {
        frames.push(payload)
        return false // never drains
      },
      onOverflow: () => { overflows += 1 },
    })

    for (let i = 0; i < 10_000; i += 1) {
      sender.send(event(`type-${i}`))
    }

    assert.ok(frames.length <= 1, "a never-draining client must receive at most the first frame")
    assert.equal(overflows, 1, "the backlog overflow disconnects exactly once")
    assert.ok(sender.pendingCount <= 64, "the in-memory backlog stays bounded")
  })

  it("coalesces a bounded backlog by type and flushes on drain", () => {
    const frames: unknown[] = []
    const sender = createBackpressuredSender({
      writeFrame: (payload) => {
        frames.push(payload)
        return false
      },
      onOverflow: () => {},
      maxPending: 4,
    })

    sender.send(event("a"))
    sender.send(event("b"))
    sender.send(event("a")) // newest a replaces the backlogged a
    assert.equal(sender.pendingCount, 2, "same-type events coalesce to the newest")

    let allow = false
    const draining = createBackpressuredSender({
      writeFrame: (payload) => {
        frames.push(payload)
        return allow
      },
      onOverflow: () => {},
    })
    draining.send(event("x"))
    draining.send(event("y"))
    draining.flush() // writer still backpressured: only the first backlogged frame is attempted
    assert.equal(draining.pendingCount, 1, "flush stops while the writer stays backpressured")
    allow = true
    draining.flush()
    assert.equal(draining.pendingCount, 0, "a later drain continues from the backlog")
  })

  it("stops sending and drops the backlog after close", () => {
    const frames: unknown[] = []
    const sender = createBackpressuredSender({
      writeFrame: (payload) => {
        frames.push(payload)
        return false
      },
      onOverflow: () => {},
    })
    sender.send(event("a"))
    sender.close()
    sender.flush()
    sender.send(event("b"))
    assert.equal(sender.pendingCount, 0, "no events are buffered after close")
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
