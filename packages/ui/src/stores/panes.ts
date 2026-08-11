/**
 * Reactive pane store: the bridge between the pure pane model and the shell.
 *
 * `lib/panes.ts` holds the pure state transitions; this store makes that state
 * observable so the shell can render the panes of the instance it shows and the
 * split/detach actions can mutate them. State is scoped **per instance** --
 * one instance's split must not reflow another instance's window. The active
 * session map stays untouched -- panes are their own selection layer.
 */

import { createSignal } from "solid-js"
import {
  addPane,
  closePane,
  createPaneState,
  detachPane,
  reattachPane,
  setActivePane,
  setPaneSession,
  setSplitDirection,
  togglePaneCollapsed,
  type Pane,
  type PaneSplitDirection,
  type PaneState,
} from "../lib/panes"

type PaneMap = Map<string, PaneState>

const [paneStates, setPaneStates] = createSignal<PaneMap>(new Map())

/** Ids handed out sequentially so a split never collides. */
let nextPaneNumber = 2

function nextPaneId(): string {
  const id = `pane-${nextPaneNumber}`
  nextPaneNumber += 1
  return id
}

function mutate(instanceId: string, update: (state: PaneState) => PaneState): void {
  setPaneStates((prev) => {
    const current = prev.get(instanceId)
    if (!current) return prev
    const next = new Map(prev)
    next.set(instanceId, update(current))
    return next
  })
}

/** Creates the initial single-pane state on first use for an instance. */
function ensureState(instanceId: string, sessionId: string): void {
  setPaneStates((prev) => {
    if (prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.set(instanceId, createPaneState(instanceId, sessionId))
    return next
  })
}

/** The pane layout of one instance; empty until that instance is seeded. */
export function panesForInstance(instanceId: string): PaneState | null {
  return paneStates().get(instanceId) ?? null
}

export function splitPane(instanceId: string, sessionId: string, paneInstanceId = instanceId): string {
  const pane: Pane = { id: nextPaneId(), instanceId: paneInstanceId, sessionId }
  setPaneStates((prev) => {
    const current = prev.get(instanceId) ?? createPaneState(instanceId, sessionId)
    const next = new Map(prev)
    next.set(instanceId, addPane(current, pane))
    return next
  })
  return pane.id
}

export function closePaneAt(instanceId: string, id: string): void {
  mutate(instanceId, (state) => closePane(state, id))
}

export function detachPaneAt(instanceId: string, id: string): void {
  mutate(instanceId, (state) => detachPane(state, id))
}

export function reattachPaneAt(instanceId: string, id: string): void {
  mutate(instanceId, (state) => reattachPane(state, id))
}

/** Rebuilds exact native-window ownership after the main renderer is recreated. */
export function restorePaneAt(instanceId: string, pane: Pane, detached: boolean): void {
  setPaneStates((prev) => {
    const current = prev.get(instanceId)
    const panes = current
      ? current.panes.some((candidate) => candidate.id === pane.id)
        ? current.panes.map((candidate) => candidate.id === pane.id ? pane : candidate)
        : [...current.panes, pane]
      : [pane]
    const detachedIds = new Set(current?.detachedIds ?? [])
    if (detached) detachedIds.add(pane.id)
    else detachedIds.delete(pane.id)
    const nextState: PaneState = {
      panes,
      direction: current?.direction ?? "horizontal",
      activePaneId: current?.activePaneId ?? pane.id,
      detachedIds: Array.from(detachedIds),
      forcePaneLayout: true,
    }
    const next = new Map(prev)
    next.set(instanceId, nextState)
    return next
  })

  const numericId = /^pane-(\d+)$/.exec(pane.id)?.[1]
  if (numericId) nextPaneNumber = Math.max(nextPaneNumber, Number(numericId) + 1)
}

export function activatePane(instanceId: string, id: string): void {
  mutate(instanceId, (state) => setActivePane(state, id))
}

export function repointPane(instanceId: string, id: string, sessionId: string): void {
  mutate(instanceId, (state) => setPaneSession(state, id, instanceId, sessionId))
}

export function togglePaneCollapsedAt(instanceId: string, id: string): void {
  mutate(instanceId, (state) => togglePaneCollapsed(state, id))
}

export function setPaneDirection(instanceId: string, direction: PaneSplitDirection): void {
  mutate(instanceId, (state) => setSplitDirection(state, direction))
}

/** Shell entry: seed the single pane for the session that opens in an instance. */
export function ensurePaneState(instanceId: string, sessionId: string): void {
  ensureState(instanceId, sessionId)
}

/** Test seam. */
export function resetPanesForTests(): void {
  setPaneStates(new Map())
  nextPaneNumber = 2
}
