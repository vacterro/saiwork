import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { SettingsService } from "./service"
import { YamlDocStore, type YamlDocStoreFs, type SettingsDoc } from "./yaml-doc-store"
import type { ConfigLocation } from "../config/location"
import type { WorkspaceEventPayload } from "../api-types"

const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger } as never

class FakeBus {
  readonly events: WorkspaceEventPayload[] = []
  publish(event: WorkspaceEventPayload): void {
    this.events.push(event)
  }
}

interface FakeFs extends YamlDocStoreFs {
  files: Map<string, string>
}

function fakeFs(overrides: Partial<YamlDocStoreFs> = {}): FakeFs {
  const files = new Map<string, string>()
  let fdCounter = 0
  const base: YamlDocStoreFs = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const value = files.get(p)
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
      return value
    },
    mkdirSync: () => {},
    writeFileSync: (p, data) => { files.set(p, data) },
    openSync: () => ++fdCounter,
    fsyncSync: () => {},
    closeSync: () => {},
    renameSync: (from, to) => {
      const value = files.get(from)
      if (value === undefined) throw new Error("ENOENT rename")
      files.delete(from)
      files.set(to, value)
    },
    rmSync: (p) => { files.delete(p) },
  }
  return { ...base, ...overrides, files } as FakeFs
}

const location: ConfigLocation = {
  baseDir: "C:/saiwork",
  configYamlPath: "C:/saiwork/config.yaml",
  stateYamlPath: "C:/saiwork/state.yaml",
  legacyJsonPath: "C:/saiwork/legacy.json",
  instancesDir: "C:/saiwork/instances",
}

describe("SettingsService fail-closed persistence", () => {
  it("publishes NO changed event when the durable write fails", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/saiwork/config.yaml", "server:\n  logLevel: INFO\n")
    fsOps.files.set("C:/saiwork/state.yaml", "x: 1\n")
    fsOps.renameSync = () => { throw new Error("EACCES") }
    const bus = new FakeBus()
    const service = new SettingsService(location, bus as never, logger)
    // The service builds its own stores; force the config store onto the fake fs.
    ;(service as unknown as { configStore: YamlDocStore }).configStore =
      new YamlDocStore(location.configYamlPath, logger, { fs: fsOps })
    ;(service as unknown as { stateStore: YamlDocStore }).stateStore =
      new YamlDocStore(location.stateYamlPath, logger, { fs: fsOps })

    assert.throws(() => service.mergePatchDoc("config", { ui: { theme: "dark" } }))
    assert.equal(bus.events.length, 0, "no success event may fire on a failed persistence")
  })

  it("publishes one changed event only after a successful durable write", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/saiwork/config.yaml", "server:\n  logLevel: INFO\n")
    fsOps.files.set("C:/saiwork/state.yaml", "x: 1\n")
    const bus = new FakeBus()
    const service = new SettingsService(location, bus as never, logger)
    ;(service as unknown as { configStore: YamlDocStore }).configStore =
      new YamlDocStore(location.configYamlPath, logger, { fs: fsOps })
    ;(service as unknown as { stateStore: YamlDocStore }).stateStore =
      new YamlDocStore(location.stateYamlPath, logger, { fs: fsOps })

    service.mergePatchOwner("config", "ui", { theme: "dark" })
    assert.equal(bus.events.length, 1)
    const event = bus.events[0]
    assert.equal(event.type, "storage.configChanged")
    if (event.type === "storage.configChanged") {
      assert.deepEqual(event.value, { theme: "dark" })
    }
  })

  it("mutation on a corrupt source fails closed without overwriting it", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/saiwork/config.yaml", "server: [unclosed")
    fsOps.files.set("C:/saiwork/state.yaml", "x: 1\n")
    const bus = new FakeBus()
    const service = new SettingsService(location, bus as never, logger)
    ;(service as unknown as { configStore: YamlDocStore }).configStore =
      new YamlDocStore(location.configYamlPath, logger, { fs: fsOps })
    ;(service as unknown as { stateStore: YamlDocStore }).stateStore =
      new YamlDocStore(location.stateYamlPath, logger, { fs: fsOps })

    assert.throws(() => service.mergePatchDoc("config", { ui: { theme: "dark" } }))
    assert.equal(bus.events.length, 0)
    assert.equal(fsOps.files.get("C:/saiwork/config.yaml"), "server: [unclosed")
  })
})
