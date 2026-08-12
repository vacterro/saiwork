/**
 * Drain gate for the prompt queue.
 *
 * The queue waits for the session to report `busy` after a send before it
 * drains the next entry; without that, two quick drains could push two prompts
 * into one turn. But the gate is only disarmed by an observed busy transition,
 * so a session that was stopped mid-send (the opencode server died before
 * reporting "working") wedges the drain forever: sends look like they happen
 * but nothing leaves the queue. The gate disarms itself after a bounded
 * timeout so a dead session cannot block the queue permanently.
 */

export interface DrainGate {
  arm(): void
  disarm(): void
  blocked(): boolean
}

export function createDrainGate(options: {
  timeoutMs: number
  now?: () => number
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}): DrainGate {
  const setTimer = options.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let armed = false
  let timer: unknown = null

  return {
    arm() {
      armed = true
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        armed = false
        timer = null
      }, options.timeoutMs)
    },
    disarm() {
      armed = false
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    },
    blocked() {
      return armed
    },
  }
}
