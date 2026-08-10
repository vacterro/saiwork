import type { SaipenStatusResponse } from "../../../server/src/api-types"

export const SAIPEN_CONTINUE_PROMPT = "saipen continue"

export function shouldCheckSaipenGoalAuto(state: {
  active: boolean
  enabled: boolean
  busy: boolean
  needsInput: boolean
  paused: boolean
}): boolean {
  return state.active && state.enabled && !state.busy && !state.needsInput && !state.paused
}

export function shouldEnqueueSaipenContinue(status: SaipenStatusResponse, queuedPrompts: string[]): boolean {
  const project = status.project
  if (!status.enabled || !project) return false
  if (project.phase === "BLOCKED" || project.nextAction?.startsWith("WAIT:")) return false
  // Stop the moment there is no TODO ticket left. A remaining DOING ticket must
  // not keep auto-continuing: the user asked for a stop when the TODOs are
  // gone, and an interactive session handles the rest.
  if (project.todoCount === 0) return false
  return !queuedPrompts.some((prompt) => prompt.trim().toLowerCase() === SAIPEN_CONTINUE_PROMPT)
}

/**
 * One continue per idle stretch, tracked outside the queue.
 *
 * The queue alone cannot answer "did we already send one". The moment the drain
 * takes the continue out of the queue and sends it, the queue is empty again
 * and every queue-derived guard re-arms -- so a second evaluation before the
 * session reports `working` enqueues another continue, and a third after that.
 * Observed live: three `saipen continue` in one idle stretch.
 *
 * This registry is module state keyed by session rather than component state on
 * purpose: several SessionView instances can be mounted for the same session
 * (cached panes), and a per-component flag would be one guard per copy, which
 * is no guard at all.
 *
 * The mark is cleared when the session goes busy -- that is the agent picking
 * the continue up, which is exactly when the next one becomes legitimate.
 */
const dispatchedContinues = new Set<string>()

function continueKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

export function hasDispatchedContinue(instanceId: string, sessionId: string): boolean {
  return dispatchedContinues.has(continueKey(instanceId, sessionId))
}

export function markContinueDispatched(instanceId: string, sessionId: string): void {
  dispatchedContinues.add(continueKey(instanceId, sessionId))
}

/** Called when the session starts working, or when it is closed or unmounted. */
export function clearDispatchedContinue(instanceId: string, sessionId: string): void {
  dispatchedContinues.delete(continueKey(instanceId, sessionId))
}

/** Test seam. */
export function resetDispatchedContinues(): void {
  dispatchedContinues.clear()
}
