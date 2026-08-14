import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import fsSync from "node:fs"
import path from "node:path"
import os from "node:os"
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write"

async function tempDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

describe("atomicWriteFile", () => {
  it("replaces the target atomically and leaves no temp files", async (t) => {
    const dir = await tempDir(t)
    const target = path.join(dir, "index.json")
    await fs.writeFile(target, "old")
    await atomicWriteFile(target, JSON.stringify({ version: 2 }))
    assert.equal(await fs.readFile(target, "utf8"), '{"version":2}')
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp"))
    assert.deepEqual(leftovers, [])
  })

  it("creates missing parent directories", async (t) => {
    const dir = await tempDir(t)
    const target = path.join(dir, "nested", "deep", "index.json")
    await atomicWriteFile(target, "fresh")
    assert.equal(await fs.readFile(target, "utf8"), "fresh")
  })

  it("propagates a rename failure and cleans up the temp file", async (t) => {
    const dir = await tempDir(t)
    const target = path.join(dir, "blocked-target")
    await fs.mkdir(target)
    await assert.rejects(atomicWriteFile(target, "payload"), /rename|EISDIR|EPERM|ENOTEMPTY/)
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes(".tmp"))
    assert.deepEqual(leftovers, [], "failed write must not leave a temp file behind")
    assert.equal((await fs.stat(target)).isDirectory(), true, "the blocking target stays untouched")
  })

  it("propagates a write failure without touching any target", async (t) => {
    const dir = await tempDir(t)
    const blockingFile = path.join(dir, "not-a-dir")
    await fs.writeFile(blockingFile, "i am a file")
    const target = path.join(blockingFile, "index.json")
    await assert.rejects(atomicWriteFile(target, "payload"))
    assert.equal(await fs.readFile(blockingFile, "utf8"), "i am a file")
  })
})

describe("atomicWriteFileSync", () => {
  it("replaces the target and leaves no temp files", (t) => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atomic-write-sync-"))
    t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }))
    const target = path.join(dir, "auth.json")
    fsSync.writeFileSync(target, "old")
    atomicWriteFileSync(target, '{"version":1}')
    assert.equal(fsSync.readFileSync(target, "utf8"), '{"version":1}')
    const leftovers = fsSync.readdirSync(dir).filter((name) => name.includes(".tmp"))
    assert.deepEqual(leftovers, [])
  })

  it("applies the requested mode", (t) => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atomic-write-sync-"))
    t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }))
    const target = path.join(dir, "tls.pem")
    atomicWriteFileSync(target, "pem", { mode: 0o600 })
    if (process.platform !== "win32") {
      assert.equal(fsSync.statSync(target).mode & 0o777, 0o600)
    }
  })

  it("propagates a rename failure and cleans up the temp file", (t) => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atomic-write-sync-"))
    t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }))
    const target = path.join(dir, "blocked-target")
    fsSync.mkdirSync(target)
    assert.throws(() => atomicWriteFileSync(target, "payload"))
    const leftovers = fsSync.readdirSync(dir).filter((name) => name.includes(".tmp"))
    assert.deepEqual(leftovers, [], "failed sync write must not leave a temp file behind")
    assert.equal(fsSync.statSync(target).isDirectory(), true, "the blocking target stays untouched")
  })

  it("propagates a write failure without touching any target", (t) => {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atomic-write-sync-"))
    t.after(() => fsSync.rmSync(dir, { recursive: true, force: true }))
    const blockingFile = path.join(dir, "not-a-dir")
    fsSync.writeFileSync(blockingFile, "i am a file")
    const target = path.join(blockingFile, "registry.json")
    assert.throws(() => atomicWriteFileSync(target, "payload"))
    assert.equal(fsSync.readFileSync(blockingFile, "utf8"), "i am a file")
  })
})
