import assert from "node:assert/strict"
import { it } from "node:test"
import { SessionManager } from "./session-manager"

it("expires sessions at both idle and absolute deadlines without timers", () => {
  let now = 1_000
  let nextId = 0
  const sessions = new SessionManager({
    idleTtlMs: 10,
    absoluteTtlMs: 25,
    now: () => now,
    createId: () => `session-${++nextId}`,
  })

  const idle = sessions.createSession("idle")
  now = 1_009
  assert.equal(sessions.getSession(idle.id)?.username, "idle")
  now = 1_019
  assert.equal(sessions.getSession(idle.id), undefined)

  now = 2_000
  const old = sessions.createSession("old")
  now = 2_009
  assert.ok(sessions.getSession(old.id))
  now = 2_018
  assert.ok(sessions.getSession(old.id))
  now = 2_025
  assert.equal(sessions.getSession(old.id), undefined)
  assert.equal(sessions.getSessionCount(), 0)
})

it("prunes least-recently-used sessions deterministically and preserves the newest", () => {
  let now = 100
  let nextId = 0
  const sessions = new SessionManager({
    idleTtlMs: 1_000,
    absoluteTtlMs: 2_000,
    maxSessions: 3,
    now: () => now,
    createId: () => `session-${++nextId}`,
  })

  const first = sessions.createSession("first")
  now += 1
  const second = sessions.createSession("second")
  now += 1
  const third = sessions.createSession("third")
  now += 1
  assert.ok(sessions.getSession(first.id))
  now += 1
  const newest = sessions.createSession("newest")

  assert.equal(sessions.getSession(second.id), undefined)
  assert.ok(sessions.getSession(first.id))
  assert.ok(sessions.getSession(third.id))
  assert.ok(sessions.getSession(newest.id))
  assert.equal(sessions.getSessionCount(), 3)

  now = 200
  const tied = new SessionManager({
    idleTtlMs: 1_000,
    absoluteTtlMs: 2_000,
    maxSessions: 2,
    now: () => now,
    createId: () => `tied-${++nextId}`,
  })
  const tiedFirst = tied.createSession("first")
  const tiedSecond = tied.createSession("second")
  const tiedNewest = tied.createSession("newest")
  assert.equal(tied.getSession(tiedFirst.id), undefined)
  assert.ok(tied.getSession(tiedSecond.id))
  assert.ok(tied.getSession(tiedNewest.id))
})

it("revokes one session or the complete registry", () => {
  const sessions = new SessionManager()
  const first = sessions.createSession("first")
  const second = sessions.createSession("second")

  assert.equal(sessions.revokeSession(first.id), true)
  assert.equal(sessions.revokeSession(first.id), false)
  assert.equal(sessions.getSession(first.id), undefined)
  assert.ok(sessions.getSession(second.id))

  sessions.revokeAllSessions()
  assert.equal(sessions.getSession(second.id), undefined)
  assert.equal(sessions.getSessionCount(), 0)
})

it("rejects invalid bounds and repeated ID collisions", () => {
  assert.throws(() => new SessionManager({ maxSessions: 0 }), /maxSessions/)
  assert.throws(() => new SessionManager({ idleTtlMs: Number.POSITIVE_INFINITY }), /idleTtlMs/)

  const sessions = new SessionManager({ createId: () => "same" })
  sessions.createSession("first")
  assert.throws(() => sessions.createSession("second"), /unique session ID/)
})
