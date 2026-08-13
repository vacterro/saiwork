import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { rankWorkingFirst } from "./app-tabs"

type Tab = { id: string }
const tab = (id: string): Tab => ({ id })

function info(working: boolean, lastStoppedAt: number | null) {
  return { working, lastStoppedAt }
}

function infoBy(entries: Array<[string, { working: boolean; lastStoppedAt: number | null } | null]>) {
  const map = new Map(entries)
  return (t: Tab) => map.get(t.id) ?? null
}

function becameBy(entries: Array<[string, number]>) {
  const map = new Map(entries)
  return (t: Tab) => map.get(t.id) ?? 0
}

describe("rankWorkingFirst (tab bar working-first ordering)", () => {
  it("moves working tabs to the left of idle tabs", () => {
    const tabs = [tab("a"), tab("b"), tab("c")]
    const result = rankWorkingFirst(
      tabs,
      infoBy([
        ["a", info(true, 0)],
        ["b", info(false, 500)],
        ["c", info(false, 100)],
      ]),
      becameBy([]),
      (t) => t.id,
    )
    assert.deepEqual(result.map((t) => t.id), ["a", "b", "c"])
  })

  it("orders working tabs by most recently started working first", () => {
    const tabs = [tab("a"), tab("b"), tab("c")]
    const result = rankWorkingFirst(
      tabs,
      infoBy([
        ["a", info(true, 0)],
        ["b", info(true, 0)],
        ["c", info(true, 0)],
      ]),
      becameBy([
        ["a", 100],
        ["b", 300],
        ["c", 200],
      ]),
      (t) => t.id,
    )
    assert.deepEqual(result.map((t) => t.id), ["b", "c", "a"])
  })

  it("orders idle tabs by most recently stopped working first", () => {
    const tabs = [tab("a"), tab("b"), tab("c")]
    const result = rankWorkingFirst(
      tabs,
      infoBy([
        ["a", info(false, 700)],
        ["b", info(false, 900)],
        ["c", info(false, 200)],
      ]),
      becameBy([]),
      (t) => t.id,
    )
    assert.deepEqual(result.map((t) => t.id), ["b", "a", "c"])
  })

  it("keeps original order as a stable tiebreak", () => {
    const tabs = [tab("a"), tab("b"), tab("c")]
    const result = rankWorkingFirst(tabs, () => null, () => 0, (t) => t.id)
    assert.deepEqual(result.map((t) => t.id), ["a", "b", "c"])
  })

  it("places a just-stopped working tab near the front of the idle group", () => {
    const tabs = [tab("oldIdle"), tab("justStopped"), tab("working")]
    const result = rankWorkingFirst(
      tabs,
      infoBy([
        ["oldIdle", info(false, 1_000)],
        ["justStopped", info(false, 9_000)],
        ["working", info(true, 0)],
      ]),
      becameBy([["working", 12_000]]),
      (t) => t.id,
    )
    assert.deepEqual(result.map((t) => t.id), ["working", "justStopped", "oldIdle"])
  })
})
