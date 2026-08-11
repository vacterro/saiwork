import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseStateScalars, readStateScalar } from "./state"

const CURRENT_STATE = `---
phase: DONE
task: none
next_action: "PHASE HUNT"
blocker: "none"
saipen_version: 7
schema_version: 3
last_event: 516
saipen_home: "V:\\\\___VAC\\\\__K\\\\__CODE\\\\_AI_STUFF_AGENTIC\\\\_SAIPEN"
agent: opencode
requires:
  - filesystem
  - git
mode: no-publish
updated: "2026-08-10T23:07:13Z"
---

Body prose must never be parsed as a scalar.
phase: BUILD
next_action: "PHASE BUILD T-086"
`

describe("parseStateScalars", () => {
  it("parses the current canonical fixture", () => {
    const parsed = parseStateScalars(CURRENT_STATE)
    assert.equal(parsed.values.get("phase"), "DONE")
    assert.equal(parsed.values.get("next_action"), "PHASE HUNT")
    assert.equal(parsed.values.get("blocker"), "none")
    assert.equal(parsed.values.get("task"), "none")
    assert.equal(parsed.values.get("agent"), "opencode")
    assert.equal(parsed.values.get("saipen_version"), "7")
    assert.equal(parsed.values.get("updated"), "2026-08-10T23:07:13Z")
    assert.equal(parsed.issues.length, 0)
  })

  it("keeps saipen_home exactly as authored (escapes intact)", () => {
    const parsed = parseStateScalars(CURRENT_STATE)
    assert.equal(parsed.values.get("saipen_home"), 'V:\\\\___VAC\\\\__K\\\\__CODE\\\\_AI_STUFF_AGENTIC\\\\_SAIPEN')
  })

  it("never reads scalars from the body, only the frontmatter block", () => {
    const parsed = parseStateScalars(CURRENT_STATE)
    assert.equal(parsed.values.get("phase"), "DONE")
  })

  it("reports duplicate scalar definitions as an issue and keeps the first", () => {
    const parsed = parseStateScalars("---\nphase: SCOUT\nphase: DONE\n---\n")
    assert.equal(parsed.values.get("phase"), "SCOUT")
    assert.deepEqual(parsed.issues, ["Duplicate scalar phase"])
  })

  it("returns empty maps for missing or non-frontmatter input", () => {
    for (const input of [null, undefined, "", "phase: DONE\n", "plain text"]) {
      const parsed = parseStateScalars(input)
      assert.equal(parsed.values.size, 0)
      assert.deepEqual(parsed.issues, [])
    }
  })

  it("readStateScalar strips quotes and returns null for empty or absent values", () => {
    assert.equal(readStateScalar('---\nphase: "DONE"\n---\n', "phase"), "DONE")
    assert.equal(readStateScalar("---\nblocker:\n---\n", "blocker"), null)
    assert.equal(readStateScalar("---\nphase: DONE\n---\n", "missing_field"), null)
  })
})
