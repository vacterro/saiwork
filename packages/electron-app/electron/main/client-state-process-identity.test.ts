import assert from "node:assert/strict"
import test from "node:test"
import { createCachedLookup } from "./client-state-process-identity"

test("cached lookup serves repeated reads within the TTL without re-invoking the lookup", () => {
  let calls = 0
  const lookup = createCachedLookup((pid: number) => {
    calls += 1
    return pid === 42 ? "identity-42" : undefined
  }, 5000)
  assert.equal(lookup(42), "identity-42")
  assert.equal(lookup(42), "identity-42")
  assert.equal(lookup(42), "identity-42")
  assert.equal(calls, 1)
})

test("cached lookup does not cache undefined results by default", () => {
  let calls = 0
  const lookup = createCachedLookup((pid: number) => {
    calls += 1
    return undefined
  }, 5000)
  assert.equal(lookup(7), undefined)
  assert.equal(lookup(7), undefined)
  assert.equal(calls, 2)
})

test("cached lookup with cacheEmpty caches undefined results within the TTL", () => {
  let calls = 0
  const lookup = createCachedLookup((pid: number) => {
    calls += 1
    return undefined
  }, 5000, { cacheEmpty: true })
  assert.equal(lookup(7), undefined)
  assert.equal(lookup(7), undefined)
  assert.equal(calls, 1)
})

test("cached lookup rejects invalid pids without touching the lookup", () => {
  let calls = 0
  const lookup = createCachedLookup((pid: number) => {
    calls += 1
    return `id-${pid}`
  }, 5000)
  assert.equal(lookup(0), undefined)
  assert.equal(lookup(-1), undefined)
  assert.equal(lookup(1.5), undefined)
  assert.equal(calls, 0)
})

test("cached lookup expires after the TTL and looks up again", async () => {
  let calls = 0
  const lookup = createCachedLookup((pid: number) => {
    calls += 1
    return `id-${pid}`
  }, 50)
  assert.equal(lookup(9), "id-9")
  assert.equal(calls, 1)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(lookup(9), "id-9")
  assert.equal(calls, 2)
})
