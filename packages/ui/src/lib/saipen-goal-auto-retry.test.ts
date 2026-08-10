import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createGoalAutoRetry, GOAL_AUTO_RETRY_DELAY_MS, GOAL_AUTO_RETRY_MAX } from "./saipen-goal-auto-retry.ts"

interface FakeTimer {
  fn: () => void
  ms: number
  cleared: boolean
}

function fakeClock() {
  const timers: FakeTimer[] = []
  return {
    timers,
    setTimeoutFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms, cleared: false })
      return timers.length - 1
    },
    clearTimeoutFn: (handle: unknown) => {
      const timer = timers[handle as number]
      if (timer) timer.cleared = true
    },
    fireAll() {
      for (const timer of timers) {
        if (!timer.cleared) {
          timer.cleared = true
          timer.fn()
        }
      }
    },
    pending: () => timers.filter((timer) => !timer.cleared),
  }
}

/**
 * The retry is the only thing that can keep Goal Auto alive through a
 * transient status failure, so it has to stay small: one schedule per failure,
 * a hard budget, a hard deadline, and nothing left behind when the eligibility
 * window closes.
 */
describe("SAIPEN Goal Auto status retry", () => {
  it("retries a transient status failure once", () => {
    const clock = fakeClock()
    let checks = 0
    const retry = createGoalAutoRetry({
      shouldRetry: () => true,
      runCheck: () => {
        checks += 1
      },
      delayMs: GOAL_AUTO_RETRY_DELAY_MS,
      maxRetries: GOAL_AUTO_RETRY_MAX,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    retry.retry()
    assert.equal(checks, 0, "the retry waits for the delay before re-running the check")
    assert.equal(clock.pending().length, 1)
    assert.equal(clock.pending()[0].ms, GOAL_AUTO_RETRY_DELAY_MS)

    clock.fireAll()
    assert.equal(checks, 1, "the failed check re-ran exactly once")
  })

  it("never schedules beyond the bounded budget", () => {
    const clock = fakeClock()
    let checks = 0
    const retry = createGoalAutoRetry({
      shouldRetry: () => true,
      runCheck: () => {
        checks += 1
      },
      delayMs: 10,
      maxRetries: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    retry.retry()
    retry.retry()
    assert.equal(clock.pending().length, 1, "a pending retry is not duplicated")

    clock.fireAll()
    assert.equal(checks, 1)

    retry.retry()
    assert.equal(clock.pending().length, 0, "the one-retry budget is exhausted")
    clock.fireAll()
    assert.equal(checks, 1)
  })

  it("cancels when the session leaves the eligibility window", () => {
    const clock = fakeClock()
    let checks = 0
    const retry = createGoalAutoRetry({
      shouldRetry: () => true,
      runCheck: () => {
        checks += 1
      },
      delayMs: 10,
      maxRetries: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    retry.retry()
    retry.cancel()
    clock.fireAll()
    assert.equal(checks, 0, "a cancelled retry never runs its check")
    assert.equal(clock.pending().length, 0)
  })

  it("does not schedule a retry when the session is no longer eligible", () => {
    const clock = fakeClock()
    let checks = 0
    let eligible = false
    const retry = createGoalAutoRetry({
      shouldRetry: () => eligible,
      runCheck: () => {
        checks += 1
      },
      delayMs: 10,
      maxRetries: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    retry.retry()
    assert.equal(clock.pending().length, 0, "an ineligible session gets no retry at all")
    clock.fireAll()
    assert.equal(checks, 0)
  })

  it("does not schedule a retry once a continue has been dispatched", () => {
    const clock = fakeClock()
    let checks = 0
    let dispatched = false
    const retry = createGoalAutoRetry({
      shouldRetry: () => !dispatched,
      runCheck: () => {
        checks += 1
      },
      delayMs: 10,
      maxRetries: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    retry.retry()
    assert.equal(clock.pending().length, 1)

    dispatched = true
    retry.retry()
    assert.equal(clock.pending().length, 1, "a dispatched continue must not stack another retry")
    clock.fireAll()
    assert.equal(checks, 1)
  })

  it("gives a fresh budget to the next eligibility window", () => {
    const clock = fakeClock()
    let checks = 0
    const retry = createGoalAutoRetry({
      shouldRetry: () => true,
      runCheck: () => {
        checks += 1
      },
      delayMs: 10,
      maxRetries: 1,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    })

    retry.retry()
    clock.fireAll()
    assert.equal(checks, 1)

    retry.cancel()
    retry.retry()
    clock.fireAll()
    assert.equal(checks, 2, "a fresh idle stretch after cancel gets its own single retry")
  })
})
