/**
 * How a SAIPEN shortcut button dispatches.
 *
 * Two quick presses of `aa` then `sss` used to be able to overlap: the second
 * send fired before the session reported "working", so the opencode session
 * processed both prompts in one turn and the UI showed one message carrying
 * both texts. The mode decision here keeps that from happening:
 *
 * - **immediate**: an idle session sends the shortcut right away as its own
 *   turn; a busy session queues it instead, so it waits for idle and still runs
 *   as a separate turn. Never send while busy, so two presses can never merge.
 * - **follow-queue**: the shortcut obeys the ordinary queue policy (queue when
 *   the queue is on, send directly when it is off).
 */

export type SaipenShortcutDispatch = "send-now" | "queue"

export interface SaipenShortcutDispatchState {
  /** `saipenShortcutsImmediate` preference. */
  immediate: boolean
  busy: boolean
  needsInput: boolean
  paused: boolean
  queueEnabled: boolean
}

export function dispatchSaipenShortcut(state: SaipenShortcutDispatchState): SaipenShortcutDispatch {
  if (state.immediate) {
    if (state.busy || state.needsInput || state.paused) return "queue"
    return "send-now"
  }
  return state.queueEnabled ? "queue" : "send-now"
}
