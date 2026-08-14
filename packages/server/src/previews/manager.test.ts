import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { PreviewManager } from "./manager"

describe("PreviewManager token lifecycle", () => {
  it("evicts the least-recently-accessed record when the cap is reached", () => {
    const manager = new PreviewManager({ maxRecords: 2 })
    const first = manager.create("s1", "https://a.example")
    const second = manager.create("s2", "https://b.example")
    manager.get(first.token) // refresh first's last-access
    const third = manager.create("s3", "https://c.example") // evicts second (LRU)
    assert.equal(manager.size, 2)
    assert.equal(manager.get(second.token), undefined, "the LRU record is evicted at cap")
    assert.ok(manager.get(first.token), "a recently-accessed record survives")
    assert.ok(manager.get(third.token))
  })

  it("prunes idle-expired tokens on access and create", async () => {
    const manager = new PreviewManager({ maxRecords: 8, idleTtlMs: 1_000, absoluteTtlMs: 60_000 })
    const idle = manager.create("s1", "https://a.example")
    await new Promise((resolve) => setTimeout(resolve, 600))
    const active = manager.create("s2", "https://b.example")
    await new Promise((resolve) => setTimeout(resolve, 600)) // idle is now >1s old, active <1s
    assert.equal(manager.size, 2)
    assert.equal(manager.get(idle.token), undefined, "an idle-expired token returns 404-equivalent undefined after TTL")
    assert.equal(manager.size, 1, "prune runs on access")
    assert.ok(manager.get(active.token), "a still-fresh token survives the prune")
    manager.create("s3", "https://c.example")
    assert.equal(manager.size, 2, "prune also runs on create")
  })

  it("evicts tokens past their absolute expiry even when actively used", async () => {
    const manager = new PreviewManager({ maxRecords: 8, idleTtlMs: 60_000, absoluteTtlMs: 1_000 })
    const preview = manager.create("s1", "https://a.example")
    manager.get(preview.token)
    assert.ok(manager.get(preview.token), "valid while absolute TTL holds")
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    assert.equal(manager.get(preview.token), undefined, "absolute expiry wins over last-access refresh")
  })

  it("touches last-access on buildTargetUrl so proxying keeps a token alive", () => {
    const manager = new PreviewManager({ maxRecords: 8, idleTtlMs: 60_000, absoluteTtlMs: 60_000 })
    const preview = manager.create("s1", "https://a.example")
    manager.buildTargetUrl(preview.token, "/sub")
    assert.ok(manager.get(preview.token), "buildTargetUrl updates last access")
  })

  it("clear() drops every token on shutdown", () => {
    const manager = new PreviewManager()
    manager.create("s1", "https://a.example")
    manager.create("s2", "https://b.example")
    assert.equal(manager.size, 2)
    manager.clear()
    assert.equal(manager.size, 0)
  })
})
