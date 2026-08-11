import assert from "node:assert/strict"
import { createRoot } from "solid-js"
import { beforeEach, describe, it } from "node:test"
import { visiblePanes } from "../lib/panes"
import { closePaneAt, ensurePaneState, panesForInstance, resetPanesForTests, splitPane } from "./panes"
import {
  detachPaneToWindow,
  recoverPaneFromWindow,
  reattachSessionPane,
  resolveRecoveredPane,
  type SessionPaneWindowPayload,
} from "./session-pane-windows"

describe("session pane window wiring", () => {
  beforeEach(resetPanesForTests)

  it("marks exact pane detached only after child load succeeds", async () => {
    await createRoot(async () => {
      ensurePaneState("host", "s1")
      const paneId = splitPane("host", "s2", "session-instance")
      const pane = panesForInstance("host")!.panes.find((candidate) => candidate.id === paneId)!
      let resolveOpen!: (result: { ok: boolean }) => void
      let received: SessionPaneWindowPayload | undefined
      const open = new Promise<{ ok: boolean }>((resolve) => { resolveOpen = resolve })
      const pending = detachPaneToWindow("host", pane, {
        openSessionPane: (payload) => { received = payload; return open },
      })
      assert.deepEqual(panesForInstance("host")!.detachedIds, [])
      resolveOpen({ ok: true })
      assert.equal(await pending, true)
      assert.deepEqual(received, {
        ownerInstanceId: "host",
        paneId,
        instanceId: "session-instance",
        sessionId: "s2",
      })
      assert.deepEqual(panesForInstance("host")!.detachedIds, [paneId])
    })
  })

  it("load failure and rejected invocation leave pane attached", async () => {
    await createRoot(async () => {
      ensurePaneState("host", "s1")
      const paneId = splitPane("host", "s2")
      const pane = panesForInstance("host")!.panes.find((candidate) => candidate.id === paneId)!
      assert.equal(await detachPaneToWindow("host", pane, { openSessionPane: async () => ({ ok: false }) }), false)
      assert.equal(await detachPaneToWindow("host", pane, { openSessionPane: async () => { throw new Error("IPC failed") } }), false)
      assert.deepEqual(panesForInstance("host")!.detachedIds, [])
    })
  })

  it("close recovery racing the load response prevents a late detach", async () => {
    await createRoot(async () => {
      ensurePaneState("race-host", "s1")
      const paneId = splitPane("race-host", "s2")
      const pane = panesForInstance("race-host")!.panes.find((candidate) => candidate.id === paneId)!
      assert.equal(await detachPaneToWindow("race-host", pane, {
        openSessionPane: async (payload) => {
          recoverPaneFromWindow({ ...payload, state: "recover" })
          return { ok: true }
        },
      }), false)
      assert.deepEqual(panesForInstance("race-host")!.detachedIds, [])
    })
  })

  it("pane removal during child load rolls the loaded child back", async () => {
    await createRoot(async () => {
      ensurePaneState("rollback-host", "s1")
      const paneId = splitPane("rollback-host", "s2")
      const pane = panesForInstance("rollback-host")!.panes.find((candidate) => candidate.id === paneId)!
      let rolledBack: SessionPaneWindowPayload | undefined
      assert.equal(await detachPaneToWindow("rollback-host", pane, {
        openSessionPane: async () => {
          closePaneAt("rollback-host", paneId)
          return { ok: true }
        },
        reattachSessionPane: async (payload) => { rolledBack = payload; return { ok: true } },
      }), false)
      assert.equal(rolledBack?.paneId, paneId)
    })
  })

  it("close recovery targets pane id rather than another pane with same session", async () => {
    await createRoot(async () => {
      ensurePaneState("host", "same-session")
      const paneId = splitPane("host", "same-session", "session-instance")
      const pane = panesForInstance("host")!.panes.find((candidate) => candidate.id === paneId)!
      await detachPaneToWindow("host", pane, { openSessionPane: async () => ({ ok: true }) })
      assert.deepEqual(visiblePanes(panesForInstance("host")!).map((candidate) => candidate.id), ["pane-1"])
      assert.equal(recoverPaneFromWindow({
        ownerInstanceId: "host",
        paneId,
        instanceId: "session-instance",
        sessionId: "same-session",
        state: "recover",
      }), true)
      assert.deepEqual(visiblePanes(panesForInstance("host")!).map((candidate) => candidate.id), ["pane-1", paneId])
    })
  })

  it("stale recovery identity cannot reattach reused pane id", async () => {
    await createRoot(async () => {
      ensurePaneState("host", "s1")
      const paneId = splitPane("host", "new-session")
      assert.equal(recoverPaneFromWindow({
        ownerInstanceId: "host",
        paneId,
        instanceId: "host",
        sessionId: "old-session",
        state: "recover",
      }), false)
    })
  })

  it("rebuilds exact pane state in a recreated owner renderer", () => {
    createRoot(() => {
      assert.equal(recoverPaneFromWindow({
        ownerInstanceId: "restored-host",
        paneId: "pane-7",
        instanceId: "session-instance",
        sessionId: "session-7",
        state: "detached",
      }), true)
      const state = panesForInstance("restored-host")!
      assert.equal(state.panes[0]?.id, "pane-7")
      assert.deepEqual(state.detachedIds, ["pane-7"])
      assert.equal(state.forcePaneLayout, true)

      assert.equal(recoverPaneFromWindow({
        ownerInstanceId: "restored-host",
        paneId: "pane-7",
        instanceId: "session-instance",
        sessionId: "session-7",
        state: "recover",
      }), true)
      assert.deepEqual(state.detachedIds, ["pane-7"])
      assert.deepEqual(panesForInstance("restored-host")!.detachedIds, [])
    })
  })

  it("child reattach sends complete original pane identity", async () => {
    const payload: SessionPaneWindowPayload = {
      ownerInstanceId: "host",
      paneId: "pane-9",
      instanceId: "session-instance",
      sessionId: "session-9",
    }
    let received: SessionPaneWindowPayload | undefined
    assert.equal(await reattachSessionPane(payload, {
      reattachSessionPane: async (value) => { received = value; return { ok: true } },
    }), true)
    assert.deepEqual(received, payload)
  })

  it("clears recovered ownership only after an explicit successful resolution", async () => {
    const notice = {
      ownerInstanceId: "resolved-host",
      paneId: "pane-4",
      instanceId: "session-instance",
      sessionId: "session-4",
      state: "recover" as const,
    }
    recoverPaneFromWindow(notice)
    assert.equal(await resolveRecoveredPane(notice.ownerInstanceId, notice.paneId, {
      sessionPaneOwnerAck: async () => ({ ok: false }),
    }), false)
    let acknowledged: SessionPaneWindowPayload | undefined
    assert.equal(await resolveRecoveredPane(notice.ownerInstanceId, notice.paneId, {
      sessionPaneOwnerAck: async (payload) => { acknowledged = payload; return { ok: true } },
    }), true)
    assert.equal(acknowledged?.paneId, notice.paneId)
  })
})
