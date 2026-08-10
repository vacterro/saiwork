import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolvePresetBounds, type Rect, type WindowPreset } from "./window-presets.ts"

const workArea: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

function preset(overrides: Partial<WindowPreset> = {}): WindowPreset {
  return { id: "p1", name: "test", width: 1200, height: 800, ...overrides }
}

describe("window preset snap", () => {
  it("keeps an explicit preset size and position", () => {
    const bounds = resolvePresetBounds(preset({ width: 1200, height: 800, x: 100, y: 200 }), workArea)
    assert.deepEqual(bounds, { x: 100, y: 200, width: 1200, height: 800 })
  })

  it("centers a preset that carries no position", () => {
    const bounds = resolvePresetBounds(preset({ width: 1200, height: 800 }), workArea)
    assert.deepEqual(bounds, { x: 360, y: 140, width: 1200, height: 800 })
  })

  it("clamps an oversized preset to the display", () => {
    const bounds = resolvePresetBounds(preset({ width: 4000, height: 4000, x: 0, y: 0 }), workArea)
    assert.deepEqual(bounds, { x: 0, y: 0, width: 1920, height: 1080 })
  })

  it("clamps a position so the window stays inside the work area", () => {
    const bounds = resolvePresetBounds(preset({ width: 1200, height: 800, x: 5000, y: -100 }), workArea)
    assert.equal(bounds.x, 1920 - 1200, "the right edge must not leave the display")
    assert.equal(bounds.y, 0, "the top edge must not leave the display")
  })

  it("centers on a secondary display work area", () => {
    const secondary: Rect = { x: 1920, y: 0, width: 1920, height: 1080 }
    const bounds = resolvePresetBounds(preset({ width: 1200, height: 800 }), secondary)
    assert.deepEqual(bounds, { x: 1920 + 360, y: 140, width: 1200, height: 800 })
  })

  it("never lets a preset collapse below the minimum size", () => {
    const bounds = resolvePresetBounds(preset({ width: 10, height: 10, x: 0, y: 0 }), workArea)
    assert.equal(bounds.width, 320)
    assert.equal(bounds.height, 240)
  })
})
