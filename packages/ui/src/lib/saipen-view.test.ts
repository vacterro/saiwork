import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"

import {
  externalChangeAction,
  isSaipenDraftDirty,
  keepSaipenDraft,
  parseLogLines,
  parseStateFrontmatter,
  reconcileSaipenSave,
  reloadSaipenEditor,
} from "./saipen-view.ts"

const STATE = `---
phase: BUILD
task: T-048
next_action: "PHASE BUILD T-048"
blocker: none
transition_from: SCOUT
saipen_version: 7
execution_intent: normal
updated: 2026-08-08T22:51:00.0000000Z
agent: opencode
role_revision: ded-4ae736e4
saipen_home: "V:\\\\___VAC\\\\__K\\\\__CODE\\\\_AI_STUFF_AGENTIC\\\\_SAIPEN"
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
    assert.equal(fields.agent, "opencode")
    assert.equal(fields.roleRevision, "ded-4ae736e4")
    assert.equal(fields.saipenHome, 'V:\\\\___VAC\\\\__K\\\\__CODE\\\\_AI_STUFF_AGENTIC\\\\_SAIPEN')
  })

  it("returns nulls for missing or unparsable state", () => {
    assert.deepEqual(parseStateFrontmatter(null), {
      phase: null, task: null, nextAction: null, blocker: null, executionIntent: null, updated: null,
      agent: null, roleRevision: null, saipenHome: null,
    })
    assert.equal(parseStateFrontmatter("not frontmatter").phase, null)
  })

  it("reads only the frontmatter block, never body prose", () => {
    const state = `---\nphase: DONE\nnext_action: "PHASE HUNT"\n---\n\nphase: BUILD\n`
    const fields = parseStateFrontmatter(state)
    assert.equal(fields.phase, "DONE")
    assert.equal(fields.nextAction, "PHASE HUNT")
  })

  it("keeps the first scalar on a duplicate definition", () => {
    const state = `---\nphase: DONE\nphase: BUILD\nnext_action: "PHASE HUNT"\n---\n`
    const fields = parseStateFrontmatter(state)
    assert.equal(fields.phase, "DONE")
  })

  it("keeps non-empty log lines", () => {
    const lines = parseLogLines("- 08.08.26 22:00 [E-300] line one\n\n- 08.08.26 22:01 [E-301] line two\n")
    assert.equal(lines.length, 2)
  })

  it("defines dirty as draft content differing from loaded content", () => {
    const editing = { path: "STATE.md", content: "loaded", revision: "r1" }
    assert.equal(isSaipenDraftDirty(editing, "loaded"), false)
    assert.equal(isSaipenDraftDirty(editing, "draft"), true)
    assert.equal(isSaipenDraftDirty(null, "draft"), false)
  })

  it("refreshes loaded editor content automatically when the clean file changed", () => {
    assert.equal(externalChangeAction(null, false, ["STATE.md"]), "refresh")
    assert.equal(externalChangeAction("STATE.md", false, ["STATE.md"]), "refresh-editor")
  })

  it("preserves the draft and marks a conflict when the dirty file changed", () => {
    assert.equal(externalChangeAction("STATE.md", true, ["STATE.md"]), "conflict")
  })

  it("keeps an open draft when an unrelated file changed", () => {
    assert.equal(externalChangeAction("STATE.md", true, ["BOARD.md", "kitchen/plan-a.md"]), "refresh")
  })

  it("Reload replaces loaded content, draft, and revision", () => {
    const state = {
      editing: { path: "STATE.md", content: "old", revision: "r1" },
      draft: "local draft",
      conflict: "changed externally",
    }
    assert.deepEqual(reloadSaipenEditor(state, "fresh", "r2"), {
      editing: { path: "STATE.md", content: "fresh", revision: "r2" },
      draft: "fresh",
      conflict: null,
    })
  })

  it("Keep Draft clears the notice without changing draft, content, or revision", () => {
    const state = {
      editing: { path: "STATE.md", content: "old", revision: "r1" },
      draft: "local draft",
      conflict: "changed externally",
    }
    assert.deepEqual(keepSaipenDraft(state), { ...state, conflict: null })
  })

  it("preserves keystrokes entered while an earlier draft save was pending", () => {
    const state = reconcileSaipenSave({
      editing: { path: "STATE.md", content: "old", revision: "rev-old" },
      draft: "submitted plus newer typing",
      conflict: null,
    }, "submitted", "rev-saved")
    assert.deepEqual(state, {
      editing: { path: "STATE.md", content: "submitted", revision: "rev-saved" },
      draft: "submitted plus newer typing",
      conflict: null,
    })
    assert.equal(reconcileSaipenSave({
      editing: { path: "STATE.md", content: "old", revision: "rev-old" },
      draft: "submitted",
      conflict: null,
    }, "submitted", "rev-saved"), null)
  })
})

describe("SAIPEN plan panel wiring", () => {
  it("renders the agent's live plan from the livePlan prop in the Plan tab", () => {
    const panel = readFileSync(new URL("../components/saipen-view-panel.tsx", import.meta.url), "utf8")
    assert.match(panel, /livePlan/)
    assert.match(panel, /TodoListView state=\{props\.livePlan\?\.\(\) \?\? undefined\}/)
    assert.match(panel, /saipenView\.noLivePlan/)
  })

  it("the SaipenBar wires the live plan through and the shell passes latestTodoState", () => {
    const bar = readFileSync(new URL("../components/saipen-bar.tsx", import.meta.url), "utf8")
    const shell = readFileSync(new URL("../components/instance/instance-shell2.tsx", import.meta.url), "utf8")
    assert.match(bar, /plan\?: \(\) => ToolState \| null/)
    assert.match(bar, /livePlan=\{props\.plan\}/)
    assert.match(shell, /plan=\{latestTodoState\}/)
  })
})
