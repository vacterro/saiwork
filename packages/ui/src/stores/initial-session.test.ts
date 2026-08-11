import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  ensureInitialSession,
  shouldCreateInitialSession,
  trackSessionRestoreBarrier,
  waitForSessionRestoreBarrier,
} from "./initial-session.ts"

describe("initial session creation", () => {
  it("requires a settled ready instance with an empty root list", () => {
    const ready = {
      restoreActive: false,
      ready: true,
      fetching: false,
      creating: false,
      parentCount: 0,
    }
    assert.equal(shouldCreateInitialSession(ready), true)
    assert.equal(shouldCreateInitialSession({ ...ready, restoreActive: true }), false)
    assert.equal(shouldCreateInitialSession({ ...ready, ready: false }), false)
    assert.equal(shouldCreateInitialSession({ ...ready, fetching: true }), false)
    assert.equal(shouldCreateInitialSession({ ...ready, creating: true }), false)
    assert.equal(shouldCreateInitialSession({ ...ready, listError: "failed" }), false)
    assert.equal(shouldCreateInitialSession({ ...ready, parentCount: 1 }), false)
  })

  it("serializes creation and moves the draft before activation", async () => {
    const calls: string[] = []
    const dependencies = {
      waitForHydration: async () => { calls.push("hydrate") },
      waitForRestore: async () => { calls.push("restore") },
      canCreate: () => true,
      create: async () => { calls.push("create"); return { id: "session-1" } },
      moveDraft: (sessionId: string) => { calls.push(`move:${sessionId}`) },
      shouldActivate: () => true,
      activate: (sessionId: string) => { calls.push(`activate:${sessionId}`) },
    }

    const first = ensureInitialSession("instance-serial", dependencies)
    const second = ensureInitialSession("instance-serial", dependencies)
    assert.equal(first, second)
    await first
    assert.deepEqual(calls, ["hydrate", "restore", "create", "move:session-1", "activate:session-1"])
  })

  it("rechecks emptiness after hydration and restore settle", async () => {
    let canCreate = true
    let created = false
    await ensureInitialSession("instance-recheck", {
      waitForHydration: async () => { canCreate = false },
      waitForRestore: async () => {},
      canCreate: () => canCreate,
      create: async () => { created = true; return { id: "unexpected" } },
      moveDraft: () => {},
      shouldActivate: () => true,
      activate: () => {},
    })
    assert.equal(created, false)
  })

  it("waits for tracked preserved-session restore work", async () => {
    let release!: () => void
    const operation = new Promise<void>((resolve) => { release = resolve })
    trackSessionRestoreBarrier("instance-barrier", operation)
    let settled = false
    const wait = waitForSessionRestoreBarrier("instance-barrier").then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    release()
    await wait
    assert.equal(settled, true)
  })
})
