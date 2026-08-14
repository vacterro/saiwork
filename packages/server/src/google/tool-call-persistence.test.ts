import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { createFileToolCallRegistryPersister } from "./tool-call-persistence"

describe("tool call registry persistence", () => {
  it("loads an empty registry when the file is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saiwork-tcp-"))
    try {
      const persister = createFileToolCallRegistryPersister(join(directory, "missing.json"))
      assert.deepEqual(await persister.load(), [])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("round-trips entries through save and load", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saiwork-tcp-"))
    try {
      const filePath = join(directory, "registry.json")
      const persister = createFileToolCallRegistryPersister(filePath)
      await persister.save([
        { id: "call_1", name: "bash", thoughtSignature: "sig", sessionId: "s1", createdAt: 1234 },
        { id: "call_2", name: "read_file", createdAt: 5678 },
      ])
      const loaded = await persister.load()
      assert.equal(loaded.length, 2)
      assert.deepEqual(loaded[0], { id: "call_1", name: "bash", thoughtSignature: "sig", sessionId: "s1", createdAt: 1234 })
      assert.deepEqual(loaded[1], { id: "call_2", name: "read_file", createdAt: 5678 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails safe on malformed content instead of crashing the shim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saiwork-tcp-"))
    try {
      const filePath = join(directory, "registry.json")
      writeFileSync(filePath, "{{{ not json", "utf8")
      const persister = createFileToolCallRegistryPersister(filePath)
      assert.deepEqual(await persister.load(), [])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("fails safe on structurally invalid content and drops malformed rows", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saiwork-tcp-"))
    try {
      const filePath = join(directory, "registry.json")
      writeFileSync(filePath, JSON.stringify([{ id: "ok", name: "bash" }, { nope: true }, 42, "x"]), "utf8")
      const persister = createFileToolCallRegistryPersister(filePath)
      const loaded = await persister.load()
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0].id, "ok")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("serializes concurrent saves so the latest snapshot wins", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saiwork-toolcall-"))
    try {
      const filePath = join(directory, "registry.json")
      const persister = createFileToolCallRegistryPersister(filePath)
      await Promise.all([
        persister.save([{ id: "old", name: "one", createdAt: 1 }]),
        persister.save([{ id: "new", name: "two", createdAt: 2 }]),
      ])
      assert.deepEqual((await persister.load()).map((entry) => entry.id), ["new"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("removes its temporary file when rename fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saiwork-toolcall-fail-"))
    try {
      const filePath = join(directory, "registry.json")
      mkdirSync(filePath)
      const persister = createFileToolCallRegistryPersister(filePath)
      await assert.rejects(persister.save([{ id: "x", name: "bash", createdAt: 1 }]))
      assert.deepEqual(readdirSync(directory), ["registry.json"])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
