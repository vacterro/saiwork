import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SideCarConfigError, SideCarManager } from "./manager"
import { EventBus } from "../events/bus"

const nullLogger = {
  debug: () => {},
  warn: () => {},
  trace: () => {},
  info: () => {},
  error: () => {},
  child: () => nullLogger,
  isLevelEnabled: () => false,
}

const VALID = {
  id: "demo",
  kind: "port",
  name: "Demo",
  port: 8080,
  insecure: false,
  prefixMode: "strip",
  createdAt: "2026-08-14T10:00:00.000Z",
  updatedAt: "2026-08-14T10:00:00.000Z",
}

function makeSettings(sidecars: unknown) {
  let config: Record<string, unknown> = sidecars === undefined ? {} : { sidecars }
  let failNext = false
  return {
    getOwner: (_kind: string, owner: string) => (owner === "server" ? config : {}),
    mergePatchOwner: (_kind: string, _owner: string, patch: Record<string, unknown>) => {
      if (failNext) throw new Error("simulated disk write failure")
      config = { ...config, ...patch }
      return config
    },
    setFailNext: (value: boolean) => {
      failNext = value
    },
    getConfig: () => config,
  }
}

function makeManager(sidecars: unknown, bus = new EventBus()) {
  const settings = makeSettings(sidecars)
  const manager = new SideCarManager({ settings: settings as never, eventBus: bus, logger: nullLogger as never })
  return { manager, settings, bus }
}

describe("SideCarManager transactional mutations", () => {
  it("create with a persistence failure leaves memory and disk at pre-operation state", async () => {
    const { manager, settings } = makeManager([])
    settings.setFailNext(true)
    await assert.rejects(() => manager.create({ kind: "port", name: "Demo", port: 8080, insecure: false, prefixMode: "strip" }))
    assert.deepEqual(await manager.list(), [], "memory does not contain the record after a failed persist")
    assert.equal((settings.getConfig().sidecars as unknown[]).length, 0, "disk does not contain the record either")

    settings.setFailNext(false)
    const created = await manager.create({ kind: "port", name: "Demo", port: 8080, insecure: false, prefixMode: "strip" })
    assert.equal(created.id, "demo")
    assert.equal((await manager.list()).length, 1, "a successful retry commits exactly once")
    assert.equal((settings.getConfig().sidecars as unknown[]).length, 1)
  })

  it("update with a persistence failure leaves the live record unchanged", async () => {
    const { manager, settings } = makeManager([VALID])
    settings.setFailNext(true)
    await assert.rejects(() => manager.update("demo", { port: 9000 }))
    const after = await manager.get("demo")
    assert.equal(after?.port, 8080, "memory keeps the pre-operation value after a failed persist")
    assert.equal((settings.getConfig().sidecars as Record<string, unknown>[])[0].port, 8080, "disk is unchanged too")

    settings.setFailNext(false)
    const updated = await manager.update("demo", { port: 9000 })
    assert.equal(updated.port, 9000)
    assert.equal((settings.getConfig().sidecars as Record<string, unknown>[])[0].port, 9000)
  })

  it("delete with a persistence failure keeps the record and publishes nothing", async () => {
    const bus = new EventBus()
    let removed = 0
    bus.on("sidecar.removed", () => { removed += 1 })
    const { manager, settings } = makeManager([VALID], bus)
    settings.setFailNext(true)
    await assert.rejects(() => manager.delete("demo"))
    assert.equal(removed, 0, "sidecar.removed is not published on a failed persist")
    assert.ok(await manager.get("demo"), "the record survives a failed delete")

    settings.setFailNext(false)
    assert.equal(await manager.delete("demo"), true)
    assert.equal(removed, 1, "sidecar.removed publishes only after a durable commit")
    assert.equal(await manager.get("demo"), undefined)
  })
})

describe("SideCarManager fail-closed config validation", () => {
  const malformedFixtures: Array<[string, unknown]> = [
    ["an empty object record", [{}]],
    ["duplicate ids", [{ ...VALID }, { ...VALID, name: "Other" }]],
    ["port 0", [{ ...VALID, port: 0 }]],
    ["port 65536", [{ ...VALID, port: 65536 }]],
    ["a non-integer port", [{ ...VALID, port: 1.5 }]],
    ["an invalid prefixMode", [{ ...VALID, prefixMode: "sideways" }]],
    ["an invalid kind", [{ ...VALID, kind: "weird" }]],
    ["a malformed timestamp", [{ ...VALID, createdAt: "not-a-date" }]],
    ["a non-array sidecars value", "nope"],
  ]

  for (const [label, sidecars] of malformedFixtures) {
    it(`fails closed on ${label} and never rewrites the source config`, async () => {
      const { manager, settings } = makeManager(sidecars)
      await assert.rejects(() => manager.list(), SideCarConfigError, "list is blocked")
      const before = JSON.stringify(settings.getConfig())
      await assert.rejects(
        () => manager.create({ kind: "port", name: "New", port: 8001, insecure: false, prefixMode: "strip" }),
        SideCarConfigError,
        "create is blocked",
      )
      await assert.rejects(() => manager.update("x", { port: 1 }), SideCarConfigError, "update is blocked")
      await assert.rejects(() => manager.delete("x"), SideCarConfigError, "delete is blocked")
      assert.equal(JSON.stringify(settings.getConfig()), before, "the original corrupt bytes are never rewritten")
    })
  }

  it("an absent sidecars field means no sidecars and stays operational", async () => {
    const { manager } = makeManager(undefined)
    assert.deepEqual(await manager.list(), [])
    const created = await manager.create({ kind: "port", name: "Fresh", port: 8002, insecure: false, prefixMode: "strip" })
    assert.equal(created.id, "fresh")
  })
})
