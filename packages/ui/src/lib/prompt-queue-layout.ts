/**
 * The queue panel's height decision, kept out of the component so it can be
 * proven not to depend on the number of queued items.
 *
 * The defect this removes: the panel grew as prompts piled up and the message
 * list shrank to make room, so Goal Auto reflowed the very content the user was
 * reading. The invariant now: panel height is a function of the
 * collapsed/expanded state only. `pending` is accepted so a caller cannot
 * forget the queue exists and so the tests can pin the invariant by sweeping
 * counts.
 */

export type QueuePanelState = "collapsed" | "expanded"

export const QUEUE_BODY_HEIGHT_PX = 132
export const QUEUE_LIST_HEIGHT_PX = 112
export const QUEUE_HINT_HEIGHT_PX = 20

export interface QueueLayoutInput {
  expanded: boolean
  pending: number
}

export interface QueueLayout {
  state: QueuePanelState
  bodyHeightPx: number
}

export function resolveQueueLayout({ expanded }: QueueLayoutInput): QueueLayout {
  if (!expanded) return { state: "collapsed", bodyHeightPx: 0 }
  return { state: "expanded", bodyHeightPx: QUEUE_BODY_HEIGHT_PX }
}
