import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  activePane,
  addPane,
  closePane,
  createPaneState,
  detachPane,
  detachedPanes,
  MAX_PANES,
  reattachPane,
  setActivePane,
  setPaneSession,
  togglePaneCollapsed,
  visiblePanes,
} from "./panes.ts"

function pane(id: string, instanceId = "inst", sessionId = `session-${id}`) {
  return { id, instanceId, sessionId }
}

describe("pane model", () => {
  it("starts with one active pane for the given session", () => {
    const state = createPaneState("inst", "s1")
    assert.equal(state.panes.length, 1)
    assert.equal(activePane(state)?.sessionId, "s1")
    assert.equal(activePane(state)?.instanceId, "inst")
  })

  it("splitting adds a second independent pane and activates it", () => {
    const state = createPaneState("inst", "s1")
    const split = addPane(state, pane("pane-2", "inst", "s2"))
    assert.equal(split.panes.length, 2)
    assert.equal(activePane(split)?.id, "pane-2", "the new pane becomes active")
    assert.equal(visiblePanes(split).length, 2)
  })

  it("does not duplicate a pane id", () => {
    const state = createPaneState("inst", "s1")
    const twice = addPane(state, pane("pane-1", "inst", "other"))
    assert.equal(twice.panes.length, 1, "a split onto an existing id is a no-op")
  })

  it("closing the active pane falls back to the last remaining", () => {
    const state = addPane(createPaneState("inst", "s1"), pane("pane-2", "inst", "s2"))
    const closed = closePane(state, "pane-2")
    assert.equal(closed.panes.length, 1)
    assert.equal(closed.activePaneId, "pane-1")
  })

  it("closing the last pane empties the layout", () => {
    const closed = closePane(createPaneState("inst", "s1"), "pane-1")
    assert.deepEqual(closed.panes, [])
    assert.equal(closed.activePaneId, null)
  })

  it("detaching moves the pane out of the shell and back on re-attach", () => {
    const state = addPane(createPaneState("inst", "s1"), pane("pane-2", "inst", "s2"))
    const detached = detachPane(state, "pane-2")
    assert.deepEqual(visiblePanes(detached).map((item) => item.id), ["pane-1"])
    assert.deepEqual(detachedPanes(detached).map((item) => item.id), ["pane-2"])
    const back = reattachPane(detached, "pane-2")
    assert.deepEqual(visiblePanes(back).map((item) => item.id), ["pane-1", "pane-2"])
  })

  it("detaching the active pane keeps it active in its own window", () => {
    const state = addPane(createPaneState("inst", "s1"), pane("pane-2", "inst", "s2"))
    const detached = detachPane(state, "pane-2")
    assert.equal(detached.activePaneId, "pane-2")
    assert.deepEqual(activePane(detached)?.sessionId, "s2")
  })

  it("re-pointing a pane changes only that pane's session", () => {
    const state = addPane(createPaneState("inst", "s1"), pane("pane-2", "inst", "s2"))
    const repointed = setPaneSession(state, "pane-2", "other", "s9")
    assert.deepEqual(repointed.panes.map((item) => item.sessionId), ["s1", "s9"])
    assert.equal(repointed.panes[0].instanceId, "inst", "the untouched pane keeps its pointer")
  })

  it("ignores selecting a pane that does not exist", () => {
    const state = setActivePane(createPaneState("inst", "s1"), "missing")
    assert.equal(state.activePaneId, "pane-1")
  })

  it("closing a detached pane clears it from the detach list too", () => {
    const state = detachPane(addPane(createPaneState("inst", "s1"), pane("pane-2", "inst", "s2")), "pane-2")
    const closed = closePane(state, "pane-2")
    assert.deepEqual(closed.detachedIds, [])
    assert.equal(closed.panes.length, 1)
  })

  it("collapses and expands a pane without touching its session", () => {
    const state = addPane(createPaneState("inst", "s1"), pane("pane-2", "inst", "s2"))
    const collapsed = togglePaneCollapsed(state, "pane-2")
    assert.equal(collapsed.panes[1].collapsed, true)
    assert.equal(collapsed.panes[1].sessionId, "s2", "collapse keeps the session pointer")
    const expanded = togglePaneCollapsed(collapsed, "pane-2")
    assert.equal(expanded.panes[1].collapsed, false)
  })

  it("allows panes of different instances side by side", () => {
    const state = createPaneState("inst-a", "s1")
    const split = addPane(state, pane("pane-2", "inst-b", "s9"))
    assert.equal(split.panes.length, 2)
    assert.equal(split.panes[1].instanceId, "inst-b", "a pane may point at another project")
  })

  it("caps the number of panes at the hard limit", () => {
    let state = createPaneState("inst", "s1")
    for (let i = 2; i <= MAX_PANES; i++) {
      state = addPane(state, pane(`pane-${i}`, "inst", `s${i}`))
    }
    assert.equal(state.panes.length, MAX_PANES)
    state = addPane(state, pane("pane-over", "inst", "s-over"))
    assert.equal(state.panes.length, MAX_PANES, "splitting past the cap is a no-op")
  })
})
