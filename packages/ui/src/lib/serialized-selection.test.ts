import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SerializedSelectionMap } from "./serialized-selection"

describe("SerializedSelectionMap", () => {
  it("exposes the pending selection before the storage write settles", () => {
    const store: Record<string, string | undefined> = { m: "persisted" }
    const selections = new SerializedSelectionMap<string>((key) => store[key])

    selections.set("m", "pending", async (value) => { store.m = value })

    assert.equal(selections.read("m"), "pending", "dispatch must see the new value before storage responds")
  })

  it("applies writes strictly in order and persists the newest value", async () => {
    const store: Record<string, string | undefined> = {}
    const applied: Array<string | undefined> = []
    const selections = new SerializedSelectionMap<string>((key) => store[key])

    selections.set("m", "first", async (value) => { applied.push(value); store.m = value })
    selections.set("m", "second", async (value) => { applied.push(value); store.m = value })
    await selections.flush()

    assert.deepEqual(applied, ["first", "second"], "a slow first write must not land after the second")
    assert.equal(store.m, "second")
    assert.equal(selections.read("m"), "second")
  })

  it("never lets an older write's settle clear a newer pending overlay", async () => {
    const store: Record<string, string | undefined> = {}
    const selections = new SerializedSelectionMap<string>((key) => store[key])
    const applied: Array<string | undefined> = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    selections.set("m", "first", async (value) => {
      await firstGate
      applied.push(value)
      store.m = value
    })
    selections.set("m", "second", async (value) => { applied.push(value); store.m = value })

    // Before the first write settles the overlay still shows the newest value.
    assert.equal(selections.read("m"), "second")
    releaseFirst()
    await selections.flush()

    assert.equal(store.m, "second")
    assert.equal(selections.read("m"), "second")
    assert.deepEqual(applied, ["first", "second"])
  })

  it("surfaces a failed write without breaking the chain or the overlay release", async () => {
    const store: Record<string, string | undefined> = {}
    const errors: unknown[] = []
    const selections = new SerializedSelectionMap<string>((key) => store[key], {
      onError: (error) => errors.push(error),
    })

    selections.set("m", "first", async () => { throw new Error("storage boom") })
    selections.set("m", "second", async (value) => { store.m = value })
    await selections.flush()

    assert.equal(errors.length, 1, "the failed write surfaced exactly one error")
    assert.equal(store.m, "second", "the next write still ran after a prior failure")
    assert.equal(selections.read("m"), "second")
  })

  it("skips writes that repeat the current visible value", async () => {
    const store: Record<string, string | undefined> = { m: "same" }
    let writes = 0
    const selections = new SerializedSelectionMap<string>((key) => store[key])

    selections.set("m", "same", async () => { writes += 1 })
    await selections.flush()

    assert.equal(writes, 0, "an unchanged selection must not enqueue a write")
  })
})
