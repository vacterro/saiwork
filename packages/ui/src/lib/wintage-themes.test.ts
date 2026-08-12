import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { wintageThemes } from "./wintage-themes"

describe("Wintage theme registry", () => {
  it("exposes every canonical Wintage theme exactly once", () => {
    assert.equal(wintageThemes.length, 16)
    assert.equal(new Set(wintageThemes.map((theme) => theme.slug)).size, 16)
    assert.deepEqual(wintageThemes.slice(0, 3).map((theme) => theme.slug), ["golden", "claudecode", "antigravity"])
    assert.equal(wintageThemes.at(-1)?.slug, "custom")
  })

  it("keeps Golden Default dark and Vintage Classic light", () => {
    assert.equal(wintageThemes.find((theme) => theme.slug === "goldendefault")?.isDark, true)
    assert.equal(wintageThemes.find((theme) => theme.slug === "vintageclassic")?.isDark, false)
  })
})
