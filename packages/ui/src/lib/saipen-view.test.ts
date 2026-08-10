import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseBoardSections, parseLogLines, parseStateFrontmatter } from "./saipen-view.ts"

const STATE = `---
phase: BUILD
task: T-048
next_action: "PHASE BUILD T-048"
blocker: none
transition_from: SCOUT
saipen_version: 7
execution_intent: normal
updated: 2026-08-08T22:51:00.0000000Z
---`

describe("SAIPEN view parsing", () => {
  it("extracts the state fields a developer cares about", () => {
    const fields = parseStateFrontmatter(STATE)
    assert.equal(fields.phase, "BUILD")
    assert.equal(fields.task, "T-048")
    assert.equal(fields.nextAction, "PHASE BUILD T-048")
    assert.equal(fields.blocker, "none")
    assert.equal(fields.executionIntent, "normal")
    assert.equal(fields.updated, "2026-08-08T22:51:00.0000000Z")
  })

  it("returns nulls for missing or unparsable state", () => {
    assert.deepEqual(parseStateFrontmatter(null), {
      phase: null, task: null, nextAction: null, blocker: null, executionIntent: null, updated: null,
    })
    assert.equal(parseStateFrontmatter("not frontmatter").phase, null)
  })

  it("splits the board into sections with ticket status", () => {
    const board = `## DOING\n\n- [/] T-048 Something in progress | verify: x\n\n## TODO\n\n- [ ] T-049 Something pending\n\n## DONE\n\n- [x] T-047 Something done\n\n## BLOCKED\n`
    const sections = parseBoardSections(board)
    assert.equal(sections.length, 4)
    assert.equal(sections[0].title, "DOING")
    assert.deepEqual(sections[0].tickets, [{ id: "T-048", status: "doing", text: "Something in progress | verify: x" }])
    assert.equal(sections[1].tickets[0].status, "todo")
    assert.equal(sections[2].tickets[0].status, "done")
    assert.deepEqual(sections[3].tickets, [])
  })

  it("ignores prose and non-ticket lines inside sections", () => {
    const board = `## TODO\n\nSome prose note.\n\n- [ ] T-001 Real ticket\n\n- [ ] not-a-ticket\n`
    const sections = parseBoardSections(board)
    assert.deepEqual(sections[0].tickets.map((ticket) => ticket.id), ["T-001"])
  })

  it("keeps non-empty log lines", () => {
    const lines = parseLogLines("- 08.08.26 22:00 [E-300] line one\n\n- 08.08.26 22:01 [E-301] line two\n")
    assert.equal(lines.length, 2)
  })
})
