import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SaipenSubLifecycle, SaipenSubPackageStatus } from "../../../server/src/api-types.ts"
import { getSaipenSubLifecycleKey, getSaipenSubPackageKey, getSaipenSubPackageCounts, isSaipenSubReady } from "./saipen-sub-status.ts"

describe("SAIPEN sub status presentation", () => {
  it("maps every lifecycle verdict to a translation key", () => {
    const lifecycles: SaipenSubLifecycle[] = ["active", "blocked", "done", "missing", "malformed"]
    assert.deepEqual(lifecycles.map(getSaipenSubLifecycleKey), [
      "saipen.subs.lifecycle.active",
      "saipen.subs.lifecycle.blocked",
      "saipen.subs.lifecycle.done",
      "saipen.subs.lifecycle.missing",
      "saipen.subs.lifecycle.malformed",
    ])
  })

  it("maps every package verdict to a translation key", () => {
    const statuses: SaipenSubPackageStatus[] = [
      "none",
      "ready",
      "draft",
      "blocked",
      "reviewed",
      "stale",
      "missing",
      "malformed",
    ]
    assert.deepEqual(statuses.map(getSaipenSubPackageKey), [
      "saipen.subs.package.none",
      "saipen.subs.package.ready",
      "saipen.subs.package.draft",
      "saipen.subs.package.blocked",
      "saipen.subs.package.reviewed",
      "saipen.subs.package.stale",
      "saipen.subs.package.missing",
      "saipen.subs.package.malformed",
    ])
  })

  it("omits zero package counts from detail text", () => {
    assert.deepEqual(
      getSaipenSubPackageCounts({ ready: 2, draft: 0, blocked: 1, reviewed: 0, stale: 0 }),
      [["ready", 2], ["blocked", 1]],
    )
  })

  it("offers every package state except ready for preparation", () => {
    const statuses: Array<SaipenSubPackageStatus | undefined> = [
      undefined,
      "none",
      "draft",
      "blocked",
      "reviewed",
      "stale",
      "missing",
      "malformed",
    ]
    assert.equal(isSaipenSubReady("ready"), true)
    assert.deepEqual(statuses.map(isSaipenSubReady), statuses.map(() => false))
  })
})
