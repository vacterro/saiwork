import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { SaipenStatusResponse } from "../../../server/src/api-types.ts"
import {
  SAIPEN_CONTINUE_PROMPT,
  clearDispatchedContinue,
  hasDispatchedContinue,
  markContinueDispatched,
  resetDispatchedContinues,
  shouldCheckSaipenGoalAuto,
  shouldEnqueueSaipenContinue,
} from "./saipen-goal-auto.ts"

function status(project: SaipenStatusResponse["project"]): SaipenStatusResponse {
  return {
    enabled: true,
    home: null,
    protocolDir: null,
    instructions: [],
    missing: [],
    error: null,
    project,
    subs: [],
    effective: null,
    restartRequired: false,
  }
}

describe("SAIPEN Goal Mode Auto", () => {
  it("checks only the active idle session with queue mode running", () => {
    const ready = { active: true, enabled: true, busy: false, needsInput: false, paused: false }
    assert.equal(shouldCheckSaipenGoalAuto(ready), true)
    assert.equal(shouldCheckSaipenGoalAuto({ ...ready, active: false }), false)
    assert.equal(shouldCheckSaipenGoalAuto({ ...ready, busy: true }), false)
    assert.equal(shouldCheckSaipenGoalAuto({ ...ready, paused: true }), false)
  })

  it("continues while a TODO ticket remains", () => {
    assert.equal(
      shouldEnqueueSaipenContinue(
        status({ phase: "DONE", nextAction: "PHASE SCOUT T-001", todoCount: 1, doingCount: 0, blockedCount: 0 }),
        [],
      ),
      true,
    )
    assert.equal(
      shouldEnqueueSaipenContinue(
        status({ phase: "BUILD", nextAction: "PHASE BUILD T-001", todoCount: 1, doingCount: 1, blockedCount: 0 }),
        [],
      ),
      true,
      "a TODO ticket keeps it going even with in-flight work",
    )
  })

  it("halts the moment no TODO remains, even with in-flight work", () => {
    assert.equal(
      shouldEnqueueSaipenContinue(
        status({ phase: "BUILD", nextAction: "PHASE BUILD T-001", todoCount: 0, doingCount: 1, blockedCount: 0 }),
        [],
      ),
      false,
      "a DOING ticket alone must not keep Goal Auto running",
    )
  })

  it("halts for empty, waiting, blocked, disabled, or already queued work", () => {
    const empty = status({ phase: "DONE", nextAction: "PHASE HUNT", todoCount: 0, doingCount: 0, blockedCount: 0 })
    const waiting = status({ phase: "DONE", nextAction: "WAIT: user brake -- review", todoCount: 1, doingCount: 0, blockedCount: 0 })
    const blocked = status({ phase: "BLOCKED", nextAction: "PHASE DONE", todoCount: 1, doingCount: 0, blockedCount: 1 })

    assert.equal(shouldEnqueueSaipenContinue(empty, []), false)
    assert.equal(shouldEnqueueSaipenContinue(waiting, []), false)
    assert.equal(shouldEnqueueSaipenContinue(blocked, []), false)
    assert.equal(shouldEnqueueSaipenContinue({ ...empty, enabled: false }, []), false)
    assert.equal(shouldEnqueueSaipenContinue(status({ ...empty.project!, todoCount: 1 }), [SAIPEN_CONTINUE_PROMPT]), false)
  })
})

describe("SAIPEN Goal Mode Auto dispatch marker", () => {
  it("holds one continue per idle stretch even after the queue drains", () => {
    resetDispatchedContinues()
    const work = status({ phase: "DONE", nextAction: "PHASE SCOUT T-001", todoCount: 1, doingCount: 0, blockedCount: 0 })

    // Idle: nothing dispatched yet, the queue is empty, so a continue is due.
    assert.equal(hasDispatchedContinue("inst", "s1"), false)
    assert.equal(shouldEnqueueSaipenContinue(work, []), true)
    markContinueDispatched("inst", "s1")

    // Drain empties the queue, which is exactly what used to re-arm the guard.
    assert.equal(shouldEnqueueSaipenContinue(work, []), true, "queue guard alone still says yes")
    assert.equal(hasDispatchedContinue("inst", "s1"), true, "the marker is what holds the line")
  })

  it("re-arms once the session goes busy", () => {
    resetDispatchedContinues()
    markContinueDispatched("inst", "s1")
    clearDispatchedContinue("inst", "s1")
    assert.equal(hasDispatchedContinue("inst", "s1"), false)
  })

  it("keeps sessions and instances independent", () => {
    resetDispatchedContinues()
    markContinueDispatched("inst", "s1")

    assert.equal(hasDispatchedContinue("inst", "s2"), false)
    assert.equal(hasDispatchedContinue("other", "s1"), false)

    clearDispatchedContinue("inst", "s2")
    assert.equal(hasDispatchedContinue("inst", "s1"), true)
  })
})
