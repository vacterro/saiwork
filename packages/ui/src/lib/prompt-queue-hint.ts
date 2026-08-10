/**
 * Which hint the queue panel shows under the list, if any.
 *
 * The panel has two text slots: the empty-state paragraph that replaces the
 * list, and this hint below it. They used to be able to print the same
 * sentence -- `promptQueue.empty` in both -- so an empty queue told the user
 * "Alt+Enter adds the prompt instead of sending it" twice, one line apart.
 *
 * The rule now: the hint only speaks when it has something the empty-state does
 * not. `null` means render nothing, which is also the correct answer for a
 * queue that is simply empty and idle.
 */

export interface QueueHintState {
  paused: boolean
  sessionBusy: boolean
  pending: number
  queueEnabled: boolean
}

export type QueueHintKey =
  | "promptQueue.pausedHint"
  | "promptQueue.busyHint"
  | "promptQueue.mode.direct"

export function resolveQueueHint(state: QueueHintState): QueueHintKey | null {
  // Paused outranks everything: it is the one state where nothing will move.
  if (state.paused) return "promptQueue.pausedHint"

  // Only worth saying while entries are actually waiting on the session.
  if (state.sessionBusy && state.pending > 0) return "promptQueue.busyHint"

  // Queue off is a mode the user cannot see anywhere else in this panel body.
  if (!state.queueEnabled) return "promptQueue.mode.direct"

  // Empty and idle: the empty-state paragraph already said it.
  return null
}
