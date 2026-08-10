import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveQueueHint, type QueueHintState } from "./prompt-queue-hint.ts"

function state(overrides: Partial<QueueHintState> = {}): QueueHintState {
  return { paused: false, sessionBusy: false, pending: 0, queueEnabled: true, ...overrides }
}

/**
 * The empty-state paragraph always prints `promptQueue.empty`. These cases pin
 * the rule that the hint never prints it too, in any state.
 */
describe("prompt queue hint", () => {
  it("says nothing when the queue is empty and idle", () => {
    assert.equal(resolveQueueHint(state()), null)
  })

  it("never repeats the empty-state string", () => {
    const combinations: QueueHintState[] = []
    for (const paused of [true, false]) {
      for (const sessionBusy of [true, false]) {
        for (const pending of [0, 1, 5]) {
          for (const queueEnabled of [true, false]) {
            combinations.push({ paused, sessionBusy, pending, queueEnabled })
          }
        }
      }
    }

    for (const combination of combinations) {
      const hint = resolveQueueHint(combination)
      assert.notEqual(hint, "promptQueue.empty", `duplicated the empty hint for ${JSON.stringify(combination)}`)
    }
  })

  it("reports paused above everything else", () => {
    assert.equal(resolveQueueHint(state({ paused: true })), "promptQueue.pausedHint")
    assert.equal(
      resolveQueueHint(state({ paused: true, sessionBusy: true, pending: 3 })),
      "promptQueue.pausedHint",
      "a paused queue is not waiting on the session",
    )
  })

  it("explains the wait only while entries are actually queued", () => {
    assert.equal(resolveQueueHint(state({ sessionBusy: true, pending: 2 })), "promptQueue.busyHint")
    assert.equal(resolveQueueHint(state({ sessionBusy: true, pending: 0 })), null, "nothing is waiting")
  })

  it("names direct mode, which nothing else in the panel body shows", () => {
    assert.equal(resolveQueueHint(state({ queueEnabled: false })), "promptQueue.mode.direct")
    assert.equal(
      resolveQueueHint(state({ queueEnabled: false, sessionBusy: true, pending: 4 })),
      "promptQueue.busyHint",
      "queued entries still explain themselves first",
    )
  })
})
