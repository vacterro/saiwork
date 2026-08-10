import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  activatePreset,
  removePreset,
  upsertPreset,
  type WindowPresetCollection,
} from "./window-preset-store.ts"
import type { WindowPreset } from "./window-presets.ts"

const empty: WindowPresetCollection = { presets: [], activeId: null }
function preset(id: string, name: string): WindowPreset {
  return { id, name, width: 1200, height: 800 }
}

describe("window preset store", () => {
  it("saves a preset and makes it active on an empty store", () => {
    const next = upsertPreset(empty, preset("a", "A"))
    assert.equal(next.presets.length, 1)
    assert.equal(next.activeId, "a")
  })

  it("updates an existing preset in place", () => {
    const withA = upsertPreset(empty, preset("a", "A"))
    const updated = upsertPreset(withA, { ...preset("a", "A"), width: 800 })
    assert.equal(updated.presets.length, 1)
    assert.equal(updated.presets[0].width, 800)
    assert.equal(updated.activeId, "a")
  })

  it("switches the active preset and keeps the store intact", () => {
    const withA = upsertPreset(empty, preset("a", "A"))
    const withB = upsertPreset(withA, preset("b", "B"))
    const switched = activatePreset(withB, "b")
    assert.equal(switched.activeId, "b")
    assert.equal(switched.presets.length, 2)
  })

  it("ignores activating an unknown id", () => {
    const withA = upsertPreset(empty, preset("a", "A"))
    const next = activatePreset(withA, "missing")
    assert.equal(next.activeId, "a")
  })

  it("deleting the active preset falls back to the first remaining", () => {
    const withA = upsertPreset(empty, preset("a", "A"))
    const withB = upsertPreset(withA, preset("b", "B"))
    const activeB = activatePreset(withB, "b")
    const after = removePreset(activeB, "b")
    assert.deepEqual(after.presets.map((item) => item.id), ["a"])
    assert.equal(after.activeId, "a")
  })

  it("deleting the last preset leaves the store empty and inactive", () => {
    const withA = upsertPreset(empty, preset("a", "A"))
    const after = removePreset(withA, "a")
    assert.deepEqual(after.presets, [])
    assert.equal(after.activeId, null)
  })
})
