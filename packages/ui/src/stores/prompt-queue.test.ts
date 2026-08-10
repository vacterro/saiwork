import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import {
  dequeuePrompt,
  enqueuePrompt,
  enqueuePromptFanOut,
  getQueue,
  isQueuePaused,
  resetQueues,
  restoreDequeuedPrompt,
  type EnqueueResult,
  type QueuedPrompt,
} from "./prompt-queue.ts"

/** Unwraps a queue result, failing the test if the prompt was refused. */
function expectQueued(result: EnqueueResult): QueuedPrompt {
  assert.equal(result.ok, true, `expected the prompt to queue, got ${JSON.stringify(result)}`)
  if (!result.ok) throw new Error("unreachable")
  return result.item
}

beforeEach(resetQueues)

describe("prompt queue fan-out", () => {
  it("appends atomically to each unique target without disturbing existing order", () => {
    enqueuePrompt("one", "session-a", "first")
    const created = enqueuePromptFanOut(
      [
        { instanceId: "one", sessionId: "session-a" },
        { instanceId: "two", sessionId: "session-b" },
        { instanceId: "one", sessionId: "session-a" },
      ],
      " shared prompt ",
    )

    assert.equal(created.ok && created.items.length, 2)
    assert.deepEqual(getQueue("one", "session-a").map((item) => item.text), ["first", "shared prompt"])
    assert.deepEqual(getQueue("two", "session-b").map((item) => item.text), ["shared prompt"])
  })

  it("does nothing for empty prompts or target lists", () => {
    assert.equal(enqueuePromptFanOut([], "prompt").ok, false)
    assert.equal(enqueuePromptFanOut([{ instanceId: "one", sessionId: "session" }], "  ").ok, false)
    assert.equal(getQueue("one", "session").length, 0)
  })

  it("restores a failed head once at the original front with the same identity", () => {
    const first = expectQueued(enqueuePrompt("one", "session", "A"))
    const second = expectQueued(enqueuePrompt("one", "session", "B"))

    const failed = dequeuePrompt("one", "session")
    assert.equal(failed?.id, first.id)

    restoreDequeuedPrompt("one", "session", failed!)
    restoreDequeuedPrompt("one", "session", failed!)
    assert.deepEqual(getQueue("one", "session").map((item) => item.id), [first.id, second.id])
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["A", "B"])

    assert.equal(dequeuePrompt("one", "session")?.id, first.id)
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["B"])
  })

  it("pauses after restoring a failed head so idle effects cannot retry it in a loop", () => {
    const first = expectQueued(enqueuePrompt("one", "session", "A"))
    const second = expectQueued(enqueuePrompt("one", "session", "B"))

    const failed = dequeuePrompt("one", "session")
    restoreDequeuedPrompt("one", "session", failed!, { pause: true })

    assert.equal(isQueuePaused("one", "session"), true)
    assert.equal(dequeuePrompt("one", "session"), null)
    assert.deepEqual(getQueue("one", "session").map((item) => item.text), ["A", "B"])
  })
})
