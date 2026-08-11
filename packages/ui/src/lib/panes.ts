/**
 * The pane model behind split windows.
 *
 * A pane is an independent `(instanceId, sessionId)` pointer rendered as its
 * own session surface. Splitting the shell means rendering several panes side
 * by side instead of one active session; detaching means a pane stops rendering
 * in the shell and moves into its own OS window carrying that pointer.
 *
 * The model is deliberately separate from `activeSessionId`/`activeAppTabId`,
 * which stay the single-selection layer for the tab UX. Panes are their own
 * selection layer: this module is the only place that decides which panes exist
 * and which one is active.
 */

export type PaneSplitDirection = "vertical" | "horizontal"

/** Hard ceiling on simultaneous panes; splitting past it is a no-op. */
export const MAX_PANES = 128

export interface Pane {
  id: string
  instanceId: string
  sessionId: string
  /** Collapsed panes render as a header strip instead of a full session. */
  collapsed?: boolean
}

export interface PaneState {
  panes: Pane[]
  direction: PaneSplitDirection
  activePaneId: string | null
  /** Pane ids currently detached into their own OS window. */
  detachedIds: string[]
  /** Native recovery must render even a single exact pane through pane layout. */
  forcePaneLayout?: boolean
}

export function createPaneState(instanceId: string, sessionId: string, id = "pane-1"): PaneState {
  return { panes: [{ id, instanceId, sessionId }], direction: "horizontal", activePaneId: id, detachedIds: [] }
}

export function addPane(state: PaneState, pane: Pane): PaneState {
  if (state.panes.some((existing) => existing.id === pane.id)) return state
  if (state.panes.length >= MAX_PANES) return state
  return { ...state, panes: [...state.panes, pane], activePaneId: pane.id }
}

export function togglePaneCollapsed(state: PaneState, paneId: string): PaneState {
  return {
    ...state,
    panes: state.panes.map((pane) =>
      pane.id === paneId ? { ...pane, collapsed: !pane.collapsed } : pane,
    ),
  }
}

export function closePane(state: PaneState, paneId: string): PaneState {
  const panes = state.panes.filter((pane) => pane.id !== paneId)
  const detachedIds = state.detachedIds.filter((id) => id !== paneId)
  if (panes.length === 0) {
    return { ...state, panes, detachedIds, activePaneId: null }
  }
  const activePaneId =
    state.activePaneId === paneId ? panes[panes.length - 1].id : state.activePaneId
  return { ...state, panes, detachedIds, activePaneId }
}

export function setActivePane(state: PaneState, paneId: string): PaneState {
  if (!state.panes.some((pane) => pane.id === paneId)) return state
  return { ...state, activePaneId: paneId }
}

export function setPaneSession(state: PaneState, paneId: string, instanceId: string, sessionId: string): PaneState {
  return {
    ...state,
    panes: state.panes.map((pane) =>
      pane.id === paneId ? { ...pane, instanceId, sessionId } : pane,
    ),
  }
}

export function setSplitDirection(state: PaneState, direction: PaneSplitDirection): PaneState {
  return { ...state, direction }
}

export function detachPane(state: PaneState, paneId: string): PaneState {
  if (!state.panes.some((pane) => pane.id === paneId)) return state
  if (state.detachedIds.includes(paneId)) return state
  return { ...state, detachedIds: [...state.detachedIds, paneId] }
}

export function reattachPane(state: PaneState, paneId: string): PaneState {
  return { ...state, detachedIds: state.detachedIds.filter((id) => id !== paneId) }
}

/** Panes rendered in the shell (everything not detached into an OS window). */
export function visiblePanes(state: PaneState): Pane[] {
  return state.panes.filter((pane) => !state.detachedIds.includes(pane.id))
}

export function activePane(state: PaneState): Pane | null {
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null
}

export function detachedPanes(state: PaneState): Pane[] {
  return state.panes.filter((pane) => state.detachedIds.includes(pane.id))
}
