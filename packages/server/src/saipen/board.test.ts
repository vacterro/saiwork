import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseBoardSections } from "./board"

describe("saipen board parser", () => {
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

  it("derives status from the canonical section, not the checkbox", () => {
    const board = `## TODO\n- [ ] T-001 queued\n\n## DOING\n- [/] T-002 in flight\n\n## BLOCKED\n- [ ] T-003 stuck\n\n## DONE\n- [x] T-004 shipped\n`
    const byId = new Map(parseBoardSections(board).flatMap((section) => section.tickets.map((ticket) => [ticket.id, ticket.status])))
    assert.equal(byId.get("T-001"), "todo")
    assert.equal(byId.get("T-002"), "doing")
    assert.equal(byId.get("T-003"), "blocked")
    assert.equal(byId.get("T-004"), "done")
  })

  it("keeps BLOCKED status even when the checkbox looks unchecked", () => {
    const board = `## BLOCKED\n- [ ] T-003 stuck without progress\n- [/] T-005 half-done but stopped\n`
    const sections = parseBoardSections(board)
    assert.equal(sections[0].tickets[0].status, "blocked")
    assert.equal(sections[0].tickets[1].status, "blocked")
  })

  it("keeps checkbox semantics in non-canonical prose sections", () => {
    const board = `## Decisions\n- [x] T-010 a decided thing\n- [ ] T-011 not decided\n`
    const sections = parseBoardSections(board)
    assert.equal(sections[0].tickets[0].status, "done")
    assert.equal(sections[0].tickets[1].status, "todo")
  })

  it("ignores prose and non-ticket lines inside sections", () => {
    const board = `## TODO\n\nSome prose note.\n\n- [ ] T-001 Real ticket\n\n- [ ] not-a-ticket\n`
    const sections = parseBoardSections(board)
    assert.deepEqual(sections[0].tickets.map((ticket) => ticket.id), ["T-001"])
  })

  it("returns an empty list for null or empty text", () => {
    assert.deepEqual(parseBoardSections(null), [])
    assert.deepEqual(parseBoardSections(""), [])
  })
})
