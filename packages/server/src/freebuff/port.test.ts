import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { findFreePort } from "./port"

describe("findFreePort", () => {
  it("returns an in-range port from the injectable binder", async () => {
    const port = await findFreePort({ bind: async () => 19_123 })
    assert.equal(port, 19_123)
  })

  it("retries until the binder yields an in-range port", async () => {
    const ports = [1, 0, 65_536, 20_000]
    const port = await findFreePort({ bind: async () => ports.shift() ?? -1 })
    assert.equal(port, 20_000)
  })

  it("falls back to any port when the preferred range is exhausted", async () => {
    let calls = 0
    const port = await findFreePort({
      bind: async () => {
        calls++
        return calls <= 5 ? 1 : 30_000
      },
    })
    assert.equal(port, 30_000)
  })

  it("throws when no port can be bound at all", async () => {
    await assert.rejects(findFreePort({ bind: async () => null }), /Unable to reserve/)
  })
})
