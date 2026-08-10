import assert from "node:assert/strict"
import { createRoot } from "solid-js"
import { beforeEach, describe, it } from "node:test"

import {
  activatePane,
  closePaneAt,
  detachPaneAt,
  ensurePaneState,
  panesForInstance,
  reattachPaneAt,
  repointPane,
  resetPanesForTests,
  splitPane,
} from "./panes.ts"
import { visiblePanes } from "../lib/panes.ts"

describe("pane store", () => {
  beforeEach(() => {
    resetPanesForTests()
  })

  it("seeds one pane for the opening session and activates it", () => {
    createRoot(() => {
      ensurePaneState("inst", "s1")
      assert.equal(panesForInstance("inst")?.panes.length, 1)
      assert.equal(panesForInstance("inst")?.activePaneId, "pane-1")
    })
  })

  it("is empty for an instance that was never seeded", () => {
    createRoot(() => {
      assert.equal(panesForInstance("other"), null)
    })
  })

  it("splitting adds an independent pane without touching the active session", () => {
    createRoot(() => {
      ensurePaneState("inst", "s1")
      const id = splitPane("inst", "s2")
      assert.equal(id, "pane-2")
      assert.equal(panesForInstance("inst")?.panes.length, 2)
      assert.equal(panesForInstance("inst")?.activePaneId, "pane-2")
    })
  })

  it("keeps instances isolated: one instance's split does not touch another", () => {
    createRoot(() => {
      ensurePaneState("inst-a", "s1")
      splitPane("inst-b", "s1")
      assert.equal(panesForInstance("inst-a")?.panes.length, 1, "inst-a was not split")
      assert.equal(panesForInstance("inst-b")?.panes.length, 2, "inst-b was split")
    })
  })

  it("detach and reattach move the pane in and out of the shell", () => {
    createRoot(() => {
      ensurePaneState("inst", "s1")
      const id = splitPane("inst", "s2")
      detachPaneAt("inst", id)
      assert.deepEqual(visiblePanes(panesForInstance("inst")!).map((pane) => pane.id), ["pane-1"])
      reattachPaneAt("inst", id)
      assert.deepEqual(visiblePanes(panesForInstance("inst")!).map((pane) => pane.id), ["pane-1", "pane-2"])
    })
  })

  it("repointing changes only the targeted pane's session", () => {
    createRoot(() => {
      ensurePaneState("inst", "s1")
      const id = splitPane("inst", "s2")
      repointPane("inst", id, "s9")
      assert.deepEqual(panesForInstance("inst")!.panes.map((pane) => pane.sessionId), ["s1", "s9"])
    })
  })

  it("closing a pane falls back to the remaining one", () => {
    createRoot(() => {
      ensurePaneState("inst", "s1")
      const id = splitPane("inst", "s2")
      closePaneAt("inst", id)
      assert.equal(panesForInstance("inst")!.panes.length, 1)
      assert.equal(panesForInstance("inst")!.activePaneId, "pane-1")
    })
  })

  it("activatePane selects an existing pane", () => {
    createRoot(() => {
      ensurePaneState("inst", "s1")
      const id = splitPane("inst", "s2")
      activatePane("inst", "pane-1")
      assert.equal(panesForInstance("inst")!.activePaneId, "pane-1")
      activatePane("inst", id)
      assert.equal(panesForInstance("inst")!.activePaneId, "pane-2")
    })
  })
})
