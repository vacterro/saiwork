import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getOverflowTabIds } from "./instance-tabs-overflow"

const tabs = [
  { id: "one", width: 100 },
  { id: "two", width: 120 },
  { id: "three", width: 120 },
]

describe("project tab overflow", () => {
  it("keeps all tabs when every tab fits", () => {
    assert.deepEqual(getOverflowTabIds(tabs, 348, "one", 4), [])
  })

  it("moves the first clipped tab and every later tab into the menu", () => {
    assert.deepEqual(getOverflowTabIds(tabs, 219, "one", 4), ["two", "three"])
  })

  it("does not backfill a narrower tab after an earlier tab overflows", () => {
    assert.deepEqual(
      getOverflowTabIds([
        { id: "one", width: 100 },
        { id: "two", width: 140 },
        { id: "three", width: 20 },
      ], 130, "one", 4),
      ["two", "three"],
    )
  })

  it("keeps the active tab visible when it is last", () => {
    assert.deepEqual(getOverflowTabIds(tabs, 224, "three", 4), ["two"])
  })

  it("keeps an oversized active tab as the only visible tab", () => {
    assert.deepEqual(getOverflowTabIds(tabs, 80, "two", 4), ["one", "three"])
  })
})
