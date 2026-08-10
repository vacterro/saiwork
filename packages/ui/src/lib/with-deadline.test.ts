import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { DeadlineExceededError, isDeadlineExceeded, withDeadline } from "./with-deadline.ts"

describe("withDeadline", () => {
  it("passes a value through and clears the timer", async () => {
    let cleared = 0
    const value = await withDeadline(Promise.resolve("ok"), {
      label: "session.delete",
      ms: 1000,
      setTimeoutFn: () => 7,
      clearTimeoutFn: (handle) => {
        assert.equal(handle, 7)
        cleared += 1
      },
    })

    assert.equal(value, "ok")
    assert.equal(cleared, 1, "a timer left armed would reject a promise nobody is waiting on")
  })

  it("rejects a promise that never settles, which is the frozen-row case", async () => {
    let fire: (() => void) | undefined

    const pending = withDeadline(new Promise<never>(() => {}), {
      label: "session.delete",
      ms: 5000,
      setTimeoutFn: (handler) => {
        fire = handler
        return 1
      },
      clearTimeoutFn: () => {},
    })

    assert.ok(fire, "a deadline was armed")
    fire!()

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(isDeadlineExceeded(error))
      assert.equal((error as DeadlineExceededError).label, "session.delete")
      assert.match((error as Error).message, /did not respond within 5000ms/)
      return true
    })
  })

  it("keeps the original error when the operation itself fails", async () => {
    const failure = new Error("server said no")

    await assert.rejects(
      withDeadline(Promise.reject(failure), {
        label: "session.delete",
        ms: 1000,
        setTimeoutFn: () => 1,
        clearTimeoutFn: () => {},
      }),
      (error: unknown) => {
        assert.equal(error, failure, "a real failure must not be reported as a timeout")
        assert.equal(isDeadlineExceeded(error), false)
        return true
      },
    )
  })

  it("clears the timer when the operation rejects", async () => {
    let cleared = 0

    await assert.rejects(
      withDeadline(Promise.reject(new Error("nope")), {
        label: "x",
        ms: 1000,
        setTimeoutFn: () => 3,
        clearTimeoutFn: () => {
          cleared += 1
        },
      }),
    )

    assert.equal(cleared, 1)
  })
})
