/**
 * Keeps a workspace's delete stop retrying until the server confirms it.
 *
 * Closing a workspace used to drop the local entry first and fire the DELETE as
 * a one-shot, so a transport failure left the process running on the server
 * with nothing in the UI pointing at it -- an orphan the user could never see
 * or close again. This controller keeps that from happening: the DELETE is
 * retried with bounded exponential backoff until one attempt lands, and the
 * caller keeps the workspace visible for as long as `begin` is outstanding.
 * `cancel` (the server reported the stop some other way, or the pane is gone)
 * stops the loop without claiming success.
 *
 * `wait` is injectable so tests can step the backoff deterministically.
 */

export const WORKSPACE_DELETE_INITIAL_RETRY_MS = 500
export const WORKSPACE_DELETE_MAX_RETRY_MS = 5000
export const WORKSPACE_DELETE_MAX_ATTEMPTS = 5

export interface WorkspaceDeleteRetryDeps {
  deleteWorkspace: (id: string) => Promise<void>
  /** The DELETE landed: the workspace is gone for good. */
  onDeleted: (id: string) => void
  /** Every attempt failed within the budget; the caller decides how to surface it. */
  onGiveUp: (id: string, error: Error) => void
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
  wait?: (delayMs: number) => Promise<void>
}

export interface WorkspaceDeleteRetry {
  /** Start (or resume) the delete loop for an id. Single-flight per id. */
  begin(id: string): void
  /** Stop the loop for an id without treating it as deleted. */
  cancel(id: string): void
}

export function createWorkspaceDeleteRetry(deps: WorkspaceDeleteRetryDeps): WorkspaceDeleteRetry {
  const maxAttempts = deps.maxAttempts ?? WORKSPACE_DELETE_MAX_ATTEMPTS
  const initialDelayMs = deps.initialDelayMs ?? WORKSPACE_DELETE_INITIAL_RETRY_MS
  const maxDelayMs = deps.maxDelayMs ?? WORKSPACE_DELETE_MAX_RETRY_MS
  const wait = deps.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  const active = new Set<string>()
  const cancelled = new Set<string>()

  async function attempt(id: string, attemptNumber: number): Promise<void> {
    try {
      await deps.deleteWorkspace(id)
      active.delete(id)
      cancelled.delete(id)
      deps.onDeleted(id)
      return
    } catch (error) {
      if (cancelled.has(id)) {
        active.delete(id)
        return
      }
      if (attemptNumber + 1 >= maxAttempts) {
        active.delete(id)
        deps.onGiveUp(id, error instanceof Error ? error : new Error(String(error)))
        return
      }
      const delayMs = Math.min(initialDelayMs * 2 ** attemptNumber, maxDelayMs)
      await wait(delayMs)
      if (cancelled.has(id)) {
        active.delete(id)
        return
      }
      await attempt(id, attemptNumber + 1)
    }
  }

  return {
    begin(id: string) {
      if (active.has(id)) return
      active.add(id)
      cancelled.delete(id)
      void attempt(id, 0)
    },
    cancel(id: string) {
      cancelled.add(id)
    },
  }
}
