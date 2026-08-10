import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { normalizeSaipenFiles, normalizeSaipenHome } from "./saipen-settings.ts"

describe("SAIPEN settings patches", () => {
  it("uses null to clear optional merge-patch fields", () => {
    assert.equal(normalizeSaipenHome("  "), null)
    assert.equal(normalizeSaipenFiles(" , "), null)
  })

  it("trims configured paths and file names", () => {
    assert.equal(normalizeSaipenHome("  V:\\saipen  "), "V:\\saipen")
    assert.deepEqual(normalizeSaipenFiles(" BOOT.md, STYLE.md ,,"), ["BOOT.md", "STYLE.md"])
  })
})
