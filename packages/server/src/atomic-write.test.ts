import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { atomicWriteFile } from "./atomic-write"

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
