/**
 * Bounded retry for one Goal Auto status check.
 *
 * Goal Auto enqueues `saipen continue` when an eligible idle session has board
 * work. The status fetch that decides this can fail transiently; without a
 * retry the idle stretch would sit silently unserved until some unrelated
 * state change re-ran the effect -- Goal Auto "died" while the session stayed
 * perfectly eligible.
 *
 * This controller schedules at most `maxRetries` retries behind a `delayMs`
 * timer, and only while `shouldRetry` still reports the session eligible with
 * nothing already dispatched. Any state change that closes the eligibility
 * window calls `cancel()`, which drops the pending timer and resets the budget
 * for the next window, so an inactive or unmounted session can never fire a
 * stale check.
 *
 * `setTimeoutFn`/`clearTimeoutFn` are injectable so tests can drive the timer
 * without waiting on real time.
 */

export const GOAL_AUTO_RETRY_DELAY_MS = 5000
export const GOAL_AUTO_RETRY_MAX = 1

export interface GoalAutoRetryDeps {
  /** True only while the session is still eligible and no continue is dispatched. */
  shouldRetry: () => boolean
  /** Re-runs the full status check (fetch + eligibility + enqueue guards). */
  runCheck: () => void
  delayMs: number
  maxRetries: number
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export interface GoalAutoRetry {
  /** A status fetch failed: schedule a retry when eligible and within budget. */
  retry(): void
  /** Drop any pending retry and reset the budget (eligibility window closed). */
  cancel(): void
}

export function createGoalAutoRetry(deps: GoalAutoRetryDeps): GoalAutoRetry {
  const schedule = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clear = deps.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let retriesUsed = 0

  return {
    retry() {
      if (timer !== null) return
      if (retriesUsed >= deps.maxRetries) return
      if (!deps.shouldRetry()) return
      retriesUsed += 1
      timer = schedule(() => {
        timer = null
        deps.runCheck()
      }, deps.delayMs)
    },
    cancel() {
      if (timer !== null) {
        clear(timer)
        timer = null
      }
      retriesUsed = 0
    },
  }
}
