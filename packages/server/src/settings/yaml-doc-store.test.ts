import assert from "node:assert/strict"
import { describe, it } from "node:test"
import os from "node:os"
import path from "node:path"

import { SettingsStorageError, YamlDocStore, type YamlDocStoreFs, type SettingsDoc } from "./yaml-doc-store"

const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger } as never

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
    writeFileSync: (p, data) => {
      files.set(p, data)
    },
    openSync: () => ++fdCounter,
    fsyncSync: () => {},
    closeSync: () => {},
    renameSync: (from, to) => {
      const value = files.get(from)
      if (value === undefined) throw Object.assign(new Error(`ENOENT rename: ${from}`), { code: "ENOENT" })
      files.delete(from)
      files.set(to, value)
    },
    rmSync: (p) => {
      files.delete(p)
    },
  }
  return { ...base, ...overrides, files } as FakeFs
}

function makeStore(filePath: string, fsOps: FakeFs, nowSeq: number[] = [0]) {
  const now = () => {
    if (nowSeq.length === 0) return Date.now()
    return nowSeq.shift()!
  }
  return new YamlDocStore(filePath, logger, { fs: fsOps, now })
}

const sampleDoc: SettingsDoc = { server: { logLevel: "INFO" }, ui: { theme: "golden" } }

describe("YamlDocStore fail-closed persistence", () => {
  it("missing file is the only legitimate empty state", () => {
    const fsOps = fakeFs()
    const store = makeStore("C:/settings/config.yml", fsOps)
    assert.deepEqual(store.get(), {})
  })

  it("a valid plain-object file loads", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "server:\n  logLevel: INFO\n")
    const store = makeStore("C:/settings/config.yml", fsOps)
    assert.deepEqual(store.get().server, { logLevel: "INFO" })
  })

  it("malformed YAML becomes a persistent load failure, never empty settings", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "server: [unclosed")
    const store = makeStore("C:/settings/config.yml", fsOps)
    assert.throws(() => store.get(), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "load_failure")
    // Persistent: a second read still fails closed.
    assert.throws(() => store.get(), (e: unknown) => e instanceof SettingsStorageError)
  })

  it("a scalar/array YAML file is corruption, not empty settings", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "42\n")
    const store = makeStore("C:/settings/config.yml", fsOps)
    assert.throws(() => store.get(), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "load_failure")
  })

  it("unreadable existing file then PATCH fails closed and never overwrites the source", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "server:\n  logLevel: INFO\n")
    fsOps.readFileSync = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }) }
    const store = makeStore("C:/settings/config.yml", fsOps)
    assert.throws(() => store.get(), (e: unknown) => e instanceof SettingsStorageError)
    assert.throws(() => store.replace(sampleDoc), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "load_failure")
    assert.deepEqual(fsOps.files.get("C:/settings/config.yml"), "server:\n  logLevel: INFO\n")
  })

  it("mkdir failure throws write_failure, preserves cache and disk, publishes nothing", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "a: 1\n")
    fsOps.mkdirSync = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }) }
    const store = makeStore("C:/settings/config.yml", fsOps)
    store.get()
    assert.throws(() => store.replace(sampleDoc), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "write_failure")
    assert.deepEqual(store.get(), { a: 1 }, "cache must stay on the previous committed state")
    assert.equal(fsOps.files.get("C:/settings/config.yml"), "a: 1\n", "disk file untouched")
    assert.deepEqual([...fsOps.files.keys()].filter((k) => k.includes(".tmp-")), [])
  })

  it("write failure throws write_failure, cache unchanged, no tmp residue", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "a: 1\n")
    fsOps.writeFileSync = () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }) }
    const store = makeStore("C:/settings/config.yml", fsOps)
    store.get()
    assert.throws(() => store.replace(sampleDoc), (e: unknown) => e instanceof SettingsStorageError)
    assert.deepEqual(store.get(), { a: 1 })
    assert.equal(fsOps.files.get("C:/settings/config.yml"), "a: 1\n")
    assert.deepEqual([...fsOps.files.keys()].filter((k) => k.includes(".tmp-")), [])
  })

  it("rename failure throws write_failure, preserves original and cleans the temp", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "a: 1\n")
    fsOps.renameSync = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }) }
    const store = makeStore("C:/settings/config.yml", fsOps)
    store.get()
    assert.throws(() => store.replace(sampleDoc), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "write_failure")
    assert.deepEqual(store.get(), { a: 1 })
    assert.equal(fsOps.files.get("C:/settings/config.yml"), "a: 1\n")
    assert.deepEqual([...fsOps.files.keys()].filter((k) => k.includes(".tmp-")), [], "temp must be removed")
  })

  it("fsync failure is a write failure (not a silent success)", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "a: 1\n")
    fsOps.fsyncSync = () => { throw new Error("EIO") }
    const store = makeStore("C:/settings/config.yml", fsOps)
    store.get()
    assert.throws(() => store.replace(sampleDoc), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "write_failure")
    assert.deepEqual(store.get(), { a: 1 })
    assert.equal(fsOps.files.get("C:/settings/config.yml"), "a: 1\n")
  })

  it("successful write is durable: temp renamed into place, cache committed, no residue", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "a: 1\n")
    const store = makeStore("C:/settings/config.yml", fsOps)
    store.get()
    const result = store.replace(sampleDoc)
    assert.deepEqual(result, sampleDoc)
    assert.deepEqual(store.get(), sampleDoc)
    const onDisk = fsOps.files.get("C:/settings/config.yml")!
    assert.ok(onDisk.includes("theme: golden"), "serialized doc written")
    assert.deepEqual([...fsOps.files.keys()].filter((k) => k.includes(".tmp-")), [])
  })

  it("a transient write failure followed by a retry succeeds", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "a: 1\n")
    let failOnce = true
    fsOps.renameSync = (from, to) => {
      if (failOnce) { failOnce = false; throw new Error("EACCES") }
      const value = fsOps.files.get(from)
      if (value === undefined) throw new Error("ENOENT rename")
      fsOps.files.delete(from)
      fsOps.files.set(to, value)
    }
    const nowSeq = [1, 2]
    const store = makeStore("C:/settings/config.yml", fsOps, nowSeq)
    store.get()
    assert.throws(() => store.replace(sampleDoc), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "write_failure")
    assert.deepEqual(store.get(), { a: 1 })
    const ok = store.replace({ b: 2 })
    assert.deepEqual(ok, { b: 2 })
    assert.deepEqual(store.get(), { b: 2 })
  })

  it("mergePatch after a load failure refuses to mutate the corrupt source", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "server: [unclosed")
    const store = makeStore("C:/settings/config.yml", fsOps)
    assert.throws(() => store.mergePatch({ ui: { theme: "x" } }), (e: unknown) =>
      e instanceof SettingsStorageError && e.code === "load_failure")
    assert.equal(fsOps.files.get("C:/settings/config.yml"), "server: [unclosed")
  })

  it("getOwner keeps lenient empty behavior for a missing owner", () => {
    const fsOps = fakeFs()
    fsOps.files.set("C:/settings/config.yml", "server:\n  logLevel: INFO\n")
    const store = makeStore("C:/settings/config.yml", fsOps)
    assert.deepEqual(store.getOwner("missing"), {})
  })
})
