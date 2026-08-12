import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { findSaipenCommand, normalizeShortcutMessage } from "./saipen-commands"

describe("saipen shortcut normalization", () => {
  it("expands bare declared shortcuts to canonical verbs", () => {
    assert.equal(normalizeShortcutMessage("cc"), "saipen continue")
    assert.equal(normalizeShortcutMessage("ee"), "saipen prepare saitranslate")
    assert.equal(normalizeShortcutMessage("aa"), "saipen markhunt")
    assert.equal(normalizeShortcutMessage("qq"), "saipen prepare saiwiki")
  })

  it("normalizes whitespace and Cyrillic twins", () => {
    assert.equal(normalizeShortcutMessage("  cc  "), "saipen continue")
    assert.equal(normalizeShortcutMessage("СС"), "saipen continue")
    assert.equal(normalizeShortcutMessage("ее"), "saipen prepare saitranslate")
  })

  it("leaves prose and non-shortcut messages untouched", () => {
    assert.equal(normalizeShortcutMessage("ccee"), null)
    assert.equal(normalizeShortcutMessage("cc please"), null)
    assert.equal(normalizeShortcutMessage("saipen continue"), null)
    assert.equal(normalizeShortcutMessage("fix the build"), null)
    assert.equal(normalizeShortcutMessage(""), null)
  })

  it("finds commands by shortcut or cyrillic twin", () => {
    assert.equal(findSaipenCommand("cc")?.verb, "saipen continue")
    assert.equal(findSaipenCommand("сс")?.verb, "saipen continue")
    assert.equal(findSaipenCommand("zz"), undefined)
  })
})
