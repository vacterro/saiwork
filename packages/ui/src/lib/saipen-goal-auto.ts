import type { SaipenStatusResponse } from "../../../server/src/api-types"

export const SAIPEN_CONTINUE_PROMPT = "saipen continue"

export interface GoalCommandResolution {
  isGoal: boolean
  submitText: string
}

/**
 * Resolve a `/goal [objective]` prompt into the saipen command that starts a
 * goal run. A bare `/goal` maps to `saipen goal`; with arguments the objective
 * travels as `saipen goal <objective>`. Anything else passes through unchanged.
 */
export function resolveGoalCommand(text: string): GoalCommandResolution {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/goal")) {
    return { isGoal: false, submitText: trimmed }
  }
  const rest = trimmed.slice("/goal".length).trim()
  return { isGoal: true, submitText: rest ? `saipen goal ${rest}` : "saipen goal" }
}

/** Do not fire another auto-continue this soon after a turn ended. */
export const GOAL_AUTO_TURN_COOLDOWN_MS = 30_000
/** Much longer pause after the user explicitly aborted a turn. */
export const GOAL_AUTO_ABORT_COOLDOWN_MS = 90_000

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
  turnIdleAt.clear()
  abortedAt.clear()
  inFlightChecks.clear()
}

/**
 * Abort/cooldown guards.
 *
 * Without a pause after a turn ends (and a much longer one after an explicit
 * abort), Goal Auto re-fires `saipen continue` the instant the session reports
 * idle -- after an abort this produced a burst of continues back to back. The
 * cooldowns below throttle automatic continues; a timer in the caller resumes
 * the check once the cooldown expires.
 */
const turnIdleAt = new Map<string, number>()
const abortedAt = new Map<string, number>()
const inFlightChecks = new Set<string>()

/** Record that a turn just ended (busy -> idle). Resets the continue cooldown. */
export function noteGoalAutoTurnIdle(instanceId: string, sessionId: string, now = Date.now()): void {
  turnIdleAt.set(continueKey(instanceId, sessionId), now)
}

/** Record an explicit user abort so Goal Auto stands down for a while. */
export function markGoalAutoAborted(instanceId: string, sessionId: string, now = Date.now()): void {
  abortedAt.set(continueKey(instanceId, sessionId), now)
}

/** True while a cooldown after the last turn end or abort is still active. */
export function isGoalAutoCooldownActive(instanceId: string, sessionId: string, now = Date.now()): boolean {
  const key = continueKey(instanceId, sessionId)
  const aborted = abortedAt.get(key)
  if (aborted !== undefined && now - aborted < GOAL_AUTO_ABORT_COOLDOWN_MS) return true
  const idle = turnIdleAt.get(key)
  if (idle !== undefined && now - idle < GOAL_AUTO_TURN_COOLDOWN_MS) return true
  return false
}

/** How long until the cooldown clears (for scheduling the resume check). */
export function goalAutoCooldownRemainingMs(instanceId: string, sessionId: string, now = Date.now()): number {
  const key = continueKey(instanceId, sessionId)
  const aborted = abortedAt.get(key)
  if (aborted !== undefined) {
    const remaining = GOAL_AUTO_ABORT_COOLDOWN_MS - (now - aborted)
    if (remaining > 0) return remaining
  }
  const idle = turnIdleAt.get(key)
  if (idle !== undefined) {
    const remaining = GOAL_AUTO_TURN_COOLDOWN_MS - (now - idle)
    if (remaining > 0) return remaining
  }
  return 0
}

/**
 * Guards against two concurrent status checks enqueueing a continue each: the
 * dispatched mark is only set after the async fetch resolves, so without this a
 * second effect pass during the fetch slips past `hasDispatchedContinue` and
 * double-enqueues. Returns false when a check is already in flight.
 */
export function beginGoalAutoCheck(instanceId: string, sessionId: string): boolean {
  const key = continueKey(instanceId, sessionId)
  if (inFlightChecks.has(key)) return false
  inFlightChecks.add(key)
  return true
}

export function endGoalAutoCheck(instanceId: string, sessionId: string): void {
  inFlightChecks.delete(continueKey(instanceId, sessionId))
}
