import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { closeSessionSequence, type CloseSessionDeps } from "./session-close.ts"

function deps(overrides: Partial<CloseSessionDeps> = {}): CloseSessionDeps & { calls: string[] } {
  const calls: string[] = []
  const base: CloseSessionDeps = {
    isBusy: () => false,
    abort: async () => {
      calls.push("abort")
    },
    refresh: async () => {
      calls.push("refresh")
    },
    clearSelection: () => {
      calls.push("clear")
    },
    // A timer that fires only when the test asks it to.
    setTimeoutFn: () => undefined,
    clearTimeoutFn: () => {},
  }
  return Object.assign(base, overrides, { calls })
}

describe("closeSessionSequence", () => {
  it("aborts a working session before refreshing", async () => {
    const d = deps({ isBusy: () => true })
    const result = await closeSessionSequence(d)

    assert.deepEqual(d.calls, ["abort", "refresh", "clear"], "work stops before anything else")
    assert.equal(result.aborted, true)
    assert.equal(result.cleared, true)
  })

  it("does not abort an idle session", async () => {
    const d = deps()
    const result = await closeSessionSequence(d)

    assert.deepEqual(d.calls, ["refresh", "clear"])
    assert.equal(result.aborted, false)
  })

  it("still closes when the abort fails", async () => {
    const errors: string[] = []
    const d = deps({
      isBusy: () => true,
      abort: async () => {
        throw new Error("abort rejected")
      },
      onError: (stage) => errors.push(stage),
    })

    const result = await closeSessionSequence(d)

    assert.deepEqual(errors, ["abort"])
    assert.equal(result.aborted, false)
    assert.equal(result.refreshed, true, "a failed abort must not block the close")
  })

  it("gives up on a refresh that never resolves, and keeps the selection", async () => {
    const errors: string[] = []
    let fire: (() => void) | undefined
    const d = deps({
      refresh: () => new Promise(() => {}),
      setTimeoutFn: (handler) => {
        fire = handler
        return 1
      },
      onError: (stage) => errors.push(stage),
    })

    const pending = closeSessionSequence(d)
    // The deadline is the only thing that can end this.
    assert.ok(fire, "a deadline was armed")
    fire!()
    const result = await pending

    assert.equal(result.timedOut, true)
    assert.equal(result.refreshed, false)
    assert.equal(result.cleared, false, "closing into a void is worse than not closing")
    assert.deepEqual(errors, ["refresh"])
    assert.deepEqual(d.calls, [], "no clear was issued")
  })

  it("keeps the selection when the refresh is rejected", async () => {
    const errors: string[] = []
    const d = deps({
      refresh: async () => {
        throw new Error("network down")
      },
      onError: (stage) => errors.push(stage),
    })

    const result = await closeSessionSequence(d)

    assert.equal(result.refreshed, false)
    assert.equal(result.timedOut, false, "a rejection is not a timeout")
    assert.equal(result.cleared, false)
    assert.deepEqual(errors, ["refresh"])
  })

  it("clears the deadline once the refresh lands", async () => {
    let cleared = 0
    const d = deps({
      setTimeoutFn: () => 42,
      clearTimeoutFn: (handle) => {
        assert.equal(handle, 42)
        cleared += 1
      },
    })

    await closeSessionSequence(d)
    assert.equal(cleared, 1, "a timer left running would fire into a closed session")
  })
})
