/**
 * Bounds a promise that talks to the OpenCode server.
 *
 * Every request in this app is a call to a local process that can be mid-reply,
 * wedged, or gone. An unbounded `await` on one of those is how a click turns
 * into a frozen row with no way back: the UI marks the row busy, waits forever,
 * and never gets to show an error because the promise never settles.
 *
 * The timer is always cleared, including on the success path -- a stray timer
 * that fires later would reject a promise nobody is listening to any more.
 */

export class DeadlineExceededError extends Error {
  readonly label: string

  constructor(label: string, ms: number) {
    super(`${label} did not respond within ${ms}ms`)
    this.name = "DeadlineExceededError"
    this.label = label
  }
}

export interface DeadlineOptions {
  /** Named in the error, so the message can say what actually stalled. */
  label: string
  ms: number
  setTimeoutFn?: (handler: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export async function withDeadline<T>(operation: Promise<T>, options: DeadlineOptions): Promise<T> {
  const setTimeoutFn = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never))

  let handle: unknown
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        handle = setTimeoutFn(() => reject(new DeadlineExceededError(options.label, options.ms)), options.ms)
      }),
    ])
  } finally {
    if (handle !== undefined) clearTimeoutFn(handle)
  }
}

export function isDeadlineExceeded(error: unknown): error is DeadlineExceededError {
  return error instanceof DeadlineExceededError
}
