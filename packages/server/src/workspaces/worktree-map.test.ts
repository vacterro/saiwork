import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  readWorktreeMap,
  writeWorktreeMap,
  deleteWorktreeMap,
  validateWorktreeMap,
  WorktreeMapCorruptionError,
} from "./worktree-map"
import type { WorktreeMap } from "../api-types"

async function tempRepo(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "worktree-map-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

const validMap = (): WorktreeMap => ({
  version: 1,
  defaultWorktreeSlug: "root",
  parentSessionWorktreeSlug: { "sess-1": "feature/x" },
})

describe("worktree map fail-closed", () => {
  it("returns the default for a missing map", async (t) => {
    const repo = await tempRepo(t)
    const map = await readWorktreeMap(repo)
    assert.deepEqual(map.parentSessionWorktreeSlug, {})
  })

  it("throws on malformed JSON and preserves the bytes", async (t) => {
    const repo = await tempRepo(t)
    await fs.mkdir(path.join(repo, ".saiwork"), { recursive: true })
    await fs.writeFile(path.join(repo, ".saiwork", "worktreeMap.json"), "{ not json")
    await assert.rejects(readWorktreeMap(repo), WorktreeMapCorruptionError)
    assert.equal(await fs.readFile(path.join(repo, ".saiwork", "worktreeMap.json"), "utf-8"), "{ not json")
  })

  it("rejects wrong structure/version and invalid entries", async (t) => {
    assert.equal(validateWorktreeMap({}), false)
    assert.equal(validateWorktreeMap({ version: 2, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: {} }), false)
    assert.equal(validateWorktreeMap(["a"]), false)
    assert.equal(validateWorktreeMap({ version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: { "sess-1": 123 } }), false)
    assert.equal(validateWorktreeMap({ version: 1, defaultWorktreeSlug: "", parentSessionWorktreeSlug: {} }), false)
    assert.equal(validateWorktreeMap(validMap()), true)
  })

  it("rejects an existing structurally invalid map on read", async (t) => {
    const repo = await tempRepo(t)
    await fs.mkdir(path.join(repo, ".saiwork"), { recursive: true })
    await fs.writeFile(path.join(repo, ".saiwork", "worktreeMap.json"), JSON.stringify({ version: 9 }))
    await assert.rejects(readWorktreeMap(repo), WorktreeMapCorruptionError)
  })

  it("refuses to overwrite a corrupt map and keeps the original bytes", async (t) => {
    const repo = await tempRepo(t)
    await fs.mkdir(path.join(repo, ".saiwork"), { recursive: true })
    const mapPath = path.join(repo, ".saiwork", "worktreeMap.json")
    await fs.writeFile(mapPath, "{ corrupt")
    await assert.rejects(writeWorktreeMap(repo, validMap()), WorktreeMapCorruptionError)
    assert.equal(await fs.readFile(mapPath, "utf-8"), "{ corrupt", "the corrupt source must survive a failed mutation")
  })

  it("round-trips a valid map and survives restart", async (t) => {
    const repo = await tempRepo(t)
    await writeWorktreeMap(repo, validMap())
    const read = await readWorktreeMap(repo)
    assert.deepEqual(read.parentSessionWorktreeSlug, { "sess-1": "feature/x" })
  })

  it("serializes concurrent writes so the last writer wins a coherent map", async (t) => {
    const repo = await tempRepo(t)
    await Promise.all([
      writeWorktreeMap(repo, { version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: { a: "x" } }),
      writeWorktreeMap(repo, { version: 1, defaultWorktreeSlug: "root", parentSessionWorktreeSlug: { b: "y" } }),
    ])
    const map = await readWorktreeMap(repo)
    const keys = Object.keys(map.parentSessionWorktreeSlug)
    assert.deepEqual(keys, ["a", "b"].filter((key) => keys.includes(key)))
    assert.equal(keys.length, 1, "concurrent writers must not interleave into a torn map")
  })

  it("deletes a map and reads default afterwards", async (t) => {
    const repo = await tempRepo(t)
    await writeWorktreeMap(repo, validMap())
    await deleteWorktreeMap(repo)
    const map = await readWorktreeMap(repo)
    assert.deepEqual(map.parentSessionWorktreeSlug, {})
  })
})
