import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"

import type { Attachment } from "../types/attachment.ts"

/**
 * localStorage stand-in that can be told to reject writes, the way a full quota
 * does. The store reads `localStorage` off globalThis at call time, so it has
 * to be installed before the module is imported.
 */
class FakeStorage {
  private data = new Map<string, string>()
  failWrites = false
  writes = 0

  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes += 1
    if (this.failWrites) {
      const error = new Error("QuotaExceededError")
      error.name = "QuotaExceededError"
      throw error
    }
    this.data.set(key, value)
  }

  removeItem(key: string): void {
    this.data.delete(key)
  }

  raw(key: string): string | null {
    return this.data.get(key) ?? null
  }
}

const storage = new FakeStorage()
;(globalThis as Record<string, unknown>).localStorage = storage

const {
  MAX_QUEUED_ATTACHMENT_BYTES,
  enqueuePrompt,
  enqueuePromptFanOut,
  getQueue,
  removeQueuedPrompt,
  resetQueues,
} = await import("./prompt-queue.ts")

function attachmentOfSize(bytes: number): Attachment {
  return {
    id: "a1",
    display: "big.png",
    filename: "big.png",
    mediaType: "image/png",
    source: { type: "text", value: "x".repeat(bytes) },
  } as unknown as Attachment
}

describe("prompt queue persistence", () => {
  beforeEach(() => {
    storage.failWrites = false
    storage.writes = 0
    resetQueues()
  })

  afterEach(() => {
    storage.failWrites = false
  })

  it("reports a refused write instead of claiming the prompt was queued", () => {
    storage.failWrites = true

    const result = enqueuePrompt("inst", "s1", "hello")

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.reason, "quota")
  })

  it("rolls the queue back so memory and storage cannot disagree", () => {
    assert.equal(enqueuePrompt("inst", "s1", "first").ok, true)
    assert.equal(getQueue("inst", "s1").length, 1)

    storage.failWrites = true
    const rejected = enqueuePrompt("inst", "s1", "second")

    assert.equal(rejected.ok, false)
    assert.equal(getQueue("inst", "s1").length, 1, "the refused prompt is not left in memory")
    assert.equal(getQueue("inst", "s1")[0]?.text, "first")

    // What a restart would read back still holds exactly the first prompt.
    const stored = JSON.parse(storage.raw("saiwork.prompt-queue.v1") ?? "{}")
    assert.equal(stored["inst:s1"].items.length, 1)
    assert.equal(stored["inst:s1"].items[0].text, "first")
  })

  it("refuses an oversized attachment before touching any queue", () => {
    const attachment = attachmentOfSize(MAX_QUEUED_ATTACHMENT_BYTES + 1)

    const result = enqueuePrompt("inst", "s1", "with image", [attachment])

    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.reason, "too-large")
    assert.equal(getQueue("inst", "s1").length, 0)
    assert.equal(storage.writes, 0, "an oversized paste must not attempt the write at all")
  })

  it("accepts an attachment inside the bound", () => {
    const attachment = attachmentOfSize(1024)
    const result = enqueuePrompt("inst", "s1", "small image", [attachment])

    assert.equal(result.ok, true)
    assert.equal(getQueue("inst", "s1").length, 1)
  })

  it("treats an empty prompt as a refusal, not a silent no-op", () => {
    const result = enqueuePrompt("inst", "s1", "   ")
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.reason, "empty")
  })

  it("keeps a fan-out all-or-nothing", () => {
    storage.failWrites = true

    const result = enqueuePromptFanOut(
      [
        { instanceId: "inst", sessionId: "s1" },
        { instanceId: "inst", sessionId: "s2" },
      ],
      "broadcast",
    )

    assert.equal(result.ok, false)
    assert.equal(getQueue("inst", "s1").length, 0)
    assert.equal(getQueue("inst", "s2").length, 0, "no partial fan-out")
  })

  it("still lets the queue shrink when storage is broken", () => {
    const queued = enqueuePrompt("inst", "s1", "doomed")
    assert.equal(queued.ok, true)

    storage.failWrites = true
    removeQueuedPrompt("inst", "s1", queued.ok ? queued.item.id : "")

    assert.equal(
      getQueue("inst", "s1").length,
      0,
      "a removal is not rolled back; a queue that cannot be emptied is worse than a stale stored copy",
    )
  })
})
