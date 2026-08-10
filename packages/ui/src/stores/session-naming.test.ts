import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getNextProjectSessionTitle, getSessionProjectName } from "./session-naming.ts"

describe("project session naming", () => {
  it("uses configured project name, then folder basename", () => {
    assert.equal(getSessionProjectName("  SAIWORK  ", "V:\\code\\fallback"), "SAIWORK")
    assert.equal(getSessionProjectName(undefined, "V:\\code\\CodeNomad"), "CodeNomad")
    assert.equal(getSessionProjectName(undefined, "/"), "Session")
  })

  it("adds a monotonic suffix for duplicate parent titles", () => {
    assert.equal(getNextProjectSessionTitle("SAIWORK", []), "SAIWORK")
    assert.equal(getNextProjectSessionTitle("SAIWORK", ["SAIWORK"]), "SAIWORK 2")
    assert.equal(getNextProjectSessionTitle("SAIWORK", ["SAIWORK", "SAIWORK 2", "Unrelated"]), "SAIWORK 3")
    assert.equal(getNextProjectSessionTitle("SAIWORK", ["saiwork 4"]), "SAIWORK 5")
  })

  it("treats regex characters in project names literally", () => {
    assert.equal(getNextProjectSessionTitle("Project [dev]", ["Project [dev]"]), "Project [dev] 2")
  })
})
