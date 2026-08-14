import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deleteThreadEvents, pruneThreadEvents, putThreadEvents } from "./thread-event-cache"

describe("FreeBuff thread event cache", () => {
  it("bounds events in each thread and evicts the least recently written thread", () => {
    let cache = new Map<string, number[]>()
    cache = putThreadEvents(cache, "a", [1, 2, 3], { eventsPerThread: 2, threadLimit: 2 })
    cache = putThreadEvents(cache, "b", [4], { eventsPerThread: 2, threadLimit: 2 })
    cache = putThreadEvents(cache, "a", [2, 3], { eventsPerThread: 2, threadLimit: 2 })
    cache = putThreadEvents(cache, "c", [5], { eventsPerThread: 2, threadLimit: 2 })
    assert.deepEqual([...cache.keys()], ["a", "c"])
    assert.deepEqual(cache.get("a"), [2, 3])
  })

  it("prunes closed/stale buckets and omits empty buckets", () => {
    let cache = new Map<string, number[]>([["open", [1]], ["closed", [2]]])
    cache = pruneThreadEvents(cache, new Set(["open"]))
    assert.deepEqual([...cache.keys()], ["open"])
    cache = putThreadEvents(cache, "empty", [])
    assert.equal(cache.has("empty"), false)
    cache = deleteThreadEvents(cache, "open")
    assert.equal(cache.size, 0)
  })

  it("keeps the newest events inside a per-thread weight budget", () => {
    const cache = putThreadEvents(new Map<string, string[]>(), "weighted", ["old", "middle", "new"], {
      maxWeightPerThread: 9,
      weight: (value) => value.length,
    })
    assert.deepEqual(cache.get("weighted"), ["middle", "new"])
  })
})
