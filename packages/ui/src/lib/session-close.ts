/**
 * Closing a session, without leaving the shell blank or the agent running.
 *
 * The old flow cleared the active session first and then awaited an unbounded
 * `fetchSessions`. Two failures came out of that: a slow or dead refresh left
 * the UI with nothing selected and no way to tell whether it was working, and a
 * session that was mid-reply kept running with nobody watching it.
 *
 * The order here is deliberate:
 *   1. stop the work, if any -- an agent nobody can see is the worse orphan
 *   2. refresh under a deadline
 *   3. only then drop the selection
 *
 * Every dependency is injected so the sequence can be tested without a DOM, a
 * server, or a real clock.
 */

export interface CloseSessionDeps {
  isBusy: () => boolean
  abort: () => Promise<void>
  refresh: () => Promise<unknown>
  clearSelection: () => void
  /** Milliseconds before a refresh is treated as failed. */
  timeoutMs?: number
  setTimeoutFn?: (handler: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
  onError?: (stage: "abort" | "refresh", error: unknown) => void
}

export interface CloseSessionResult {
  aborted: boolean
  refreshed: boolean
  /** True when the selection was dropped. False leaves the user where they were. */
  cleared: boolean
  timedOut: boolean
}

export const DEFAULT_CLOSE_REFRESH_TIMEOUT_MS = 10_000

export async function closeSessionSequence(deps: CloseSessionDeps): Promise<CloseSessionResult> {
  const result: CloseSessionResult = { aborted: false, refreshed: false, cleared: false, timedOut: false }

  // 1. Stop the work first. A failed abort is reported but does not stop the
  //    close: the user asked to be rid of this session either way.
  if (deps.isBusy()) {
    try {
      await deps.abort()
      result.aborted = true
    } catch (error) {
      deps.onError?.("abort", error)
    }
  }

  // 2. Refresh under a deadline, so a server that never answers cannot hold the
  //    close open forever.
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CLOSE_REFRESH_TIMEOUT_MS
  const setTimeoutFn = deps.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never))

  let handle: unknown
  try {
    await Promise.race([
      deps.refresh(),
      new Promise((_, reject) => {
        handle = setTimeoutFn(() => reject(new Error("session close refresh timed out")), timeoutMs)
      }),
    ])
    result.refreshed = true
  } catch (error) {
    result.timedOut = error instanceof Error && error.message === "session close refresh timed out"
    deps.onError?.("refresh", error)
  } finally {
    if (handle !== undefined) clearTimeoutFn(handle)
  }

  // 3. Drop the selection last, and only when the refresh actually landed.
  //    Clearing after a failed refresh is what produced the "closed into a void"
  //    state: no session selected and no list to pick a new one from.
  if (result.refreshed) {
    deps.clearSelection()
    result.cleared = true
  }

  return result
}
