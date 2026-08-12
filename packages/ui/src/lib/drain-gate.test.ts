import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createDrainGate } from "./drain-gate"

function makeGate(timeoutMs = 60_000) {
  return {
    gate: createDrainGate({
      timeoutMs,
      setTimeoutFn: (fn) => ({ fn, token: Math.random() }),
      clearTimeoutFn: () => {},
    }),
  }
}

describe("drain gate", () => {
  it("blocks while armed and clears on disarm", () => {
    const { gate } = makeGate()
    assert.equal(gate.blocked(), false)
    gate.arm()
    assert.equal(gate.blocked(), true)
    gate.disarm()
    assert.equal(gate.blocked(), false)
  })

  it("re-arms without stacking timers", () => {
    const { gate } = makeGate()
    gate.arm()
    gate.arm()
    gate.arm()
    assert.equal(gate.blocked(), true)
    gate.disarm()
    assert.equal(gate.blocked(), false)
  })

  it("self-disarms after the timeout so a dead session cannot wedge the queue", () => {
    const timeouts: Array<() => void> = []
    const g = createDrainGate({
      timeoutMs: 60_000,
      setTimeoutFn: (fn) => {
        timeouts.push(fn)
        return timeouts.length
      },
      clearTimeoutFn: () => {},
    })
    g.arm()
    assert.equal(g.blocked(), true)
    assert.equal(timeouts.length, 1)
    timeouts[0]!()
    assert.equal(g.blocked(), false)
  })
})
