import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { dispatchSaipenShortcut, type SaipenShortcutDispatchState } from "./saipen-shortcut-dispatch.ts"

function state(overrides: Partial<SaipenShortcutDispatchState> = {}): SaipenShortcutDispatchState {
  return { immediate: false, busy: false, needsInput: false, paused: false, queueEnabled: true, ...overrides }
}

describe("SAIPEN shortcut dispatch", () => {
  it("follows the queue policy when immediate is off", () => {
    assert.equal(dispatchSaipenShortcut(state({ queueEnabled: true })), "queue")
    assert.equal(dispatchSaipenShortcut(state({ queueEnabled: false })), "send-now")
  })

  it("sends immediately on an idle session when immediate is on", () => {
    assert.equal(
      dispatchSaipenShortcut(state({ immediate: true, queueEnabled: true })),
      "send-now",
      "immediate mode bypasses the queue while the session is idle",
    )
  })

  it("never sends while the session works, even in immediate mode", () => {
    assert.equal(
      dispatchSaipenShortcut(state({ immediate: true, busy: true })),
      "queue",
      "a busy session queues the shortcut so it runs as its own turn later",
    )
    assert.equal(
      dispatchSaipenShortcut(state({ immediate: true, needsInput: true })),
      "queue",
      "a session waiting on input must not take another prompt",
    )
    assert.equal(
      dispatchSaipenShortcut(state({ immediate: true, paused: true })),
      "queue",
      "a paused queue still holds the shortcut for its own turn",
    )
  })

  it("two quick presses cannot overlap into one message", () => {
    // First press on an idle session sends now.
    const first = dispatchSaipenShortcut(state({ immediate: true }))
    assert.equal(first, "send-now")
    // While that send is being picked up, the session is busy: a second press
    // queues instead of sending an overlapping prompt.
    const second = dispatchSaipenShortcut(state({ immediate: true, busy: true }))
    assert.equal(second, "queue")
  })
})
