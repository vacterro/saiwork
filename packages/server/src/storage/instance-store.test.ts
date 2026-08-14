import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { InstanceStore, InstanceStoreConflictError, InstanceStoreCorruptionError } from "./instance-store"

async function tempStore(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "instance-store-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return new InstanceStore(dir)
}

const empty = () => ({ messageHistory: [] as string[], agentModelSelections: {} })

describe("InstanceStore identity", () => {
  it("never collapses slash vs underscore workspace paths", async (t) => {
    const store = await tempStore(t)
    await store.write("/a/b", { messageHistory: ["from-a-b"], agentModelSelections: {} }, 0)
    await store.write("/a_b", { messageHistory: [], agentModelSelections: { ag: { providerId: "p", modelId: "other" } } }, 0)
    const slash = await store.read("/a/b")
    const underscore = await store.read("/a_b")
    assert.deepEqual(slash.data.messageHistory, ["from-a-b"])
    assert.equal(underscore.data.messageHistory.length, 0)
    assert.equal(underscore.data.agentModelSelections.ag.modelId, "other")
  })

  it("keeps case-distinct POSIX paths distinct", async (t) => {
    const store = await tempStore(t)
    await store.write("/Project/Config", { messageHistory: ["upper"], agentModelSelections: {} }, 0)
    await store.write("/project/config", { messageHistory: ["lower"], agentModelSelections: {} }, 0)
    assert.deepEqual((await store.read("/Project/Config")).data.messageHistory, ["upper"])
    assert.deepEqual((await store.read("/project/config")).data.messageHistory, ["lower"])
  })

  it("keeps Unicode paths distinct", async (t) => {
    const store = await tempStore(t)
    await store.write("/привет/мир", { messageHistory: ["русский"], agentModelSelections: {} }, 0)
    await store.write("/hello/world", { messageHistory: ["english"], agentModelSelections: {} }, 0)
    assert.deepEqual((await store.read("/привет/мир")).data.messageHistory, ["русский"])
    assert.deepEqual((await store.read("/hello/world")).data.messageHistory, ["english"])
  })

  it("handles very long identities with a fixed-size key", async (t) => {
    const store = await tempStore(t)
    const longId = `/workspaces/${"x".repeat(2000)}/very/deep/path`
    await store.write(longId, { messageHistory: ["long"], agentModelSelections: {} }, 0)
    assert.deepEqual((await store.read(longId)).data.messageHistory, ["long"])
    const files = await fs.readdir((store as unknown as { instancesDir: string }).instancesDir)
    assert.equal(files.length, 1, "a long id must map to a single fixed-size file")
  })
})

describe("InstanceStore revision CAS", () => {
  it("rejects a stale write and preserves the newer state", async (t) => {
    const store = await tempStore(t)
    await store.write("ws", { messageHistory: ["v1"], agentModelSelections: {} }, 0)
    const v1 = await store.read("ws")
    await store.write("ws", { messageHistory: ["v2"], agentModelSelections: {} }, v1.revision)
    const v2 = await store.read("ws")
    await assert.rejects(
      store.write("ws", { messageHistory: ["stale"], agentModelSelections: {} }, v1.revision),
      (error: unknown) => {
        assert.ok(error instanceof InstanceStoreConflictError)
        assert.equal(error.currentRevision, v2.revision)
        return true
      },
    )
    assert.deepEqual((await store.read("ws")).data.messageHistory, ["v2"], "the stale writer must not overwrite")
  })

  it("rejects delete with a stale revision and a stale put after delete", async (t) => {
    const store = await tempStore(t)
    await store.write("ws", { messageHistory: ["v1"], agentModelSelections: {} }, 0)
    const rev = (await store.read("ws")).revision
    await assert.rejects(store.delete("ws", rev - 1), InstanceStoreConflictError)
    await store.delete("ws", rev)
    assert.deepEqual((await store.read("ws")).data.messageHistory, [], "delete leaves the default state")

    await assert.rejects(
      store.write("ws", { messageHistory: ["resurrected"], agentModelSelections: {} }, rev),
      InstanceStoreConflictError,
    )
    assert.deepEqual((await store.read("ws")).data.messageHistory, [], "a stale writer must not resurrect a deleted generation")
  })

  it("serializes concurrent read-modify-write per key", async (t) => {
    const store = await tempStore(t)
    const results = await Promise.allSettled([
      store.write("ws", { messageHistory: ["a"], agentModelSelections: {} }, 0),
      store.write("ws", { messageHistory: ["b"], agentModelSelections: {} }, 0),
    ])
    const ok = results.filter((result) => result.status === "fulfilled")
    assert.equal(ok.length, 1, "exactly one concurrent writer wins revision 1")
    assert.equal((await store.read("ws")).data.messageHistory.length, 1)
    assert.equal((await store.read("ws")).revision, 1)
  })

  it("round-trips revisions across restart", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "instance-store-"))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const store1 = new InstanceStore(dir)
    await store1.write("ws", { messageHistory: ["v1"], agentModelSelections: {} }, 0)
    const rev1 = (await store1.read("ws")).revision
    const store2 = new InstanceStore(dir)
    const afterRestart = await store2.read("ws")
    assert.equal(afterRestart.revision, rev1, "revision survives restart")
    await store2.write("ws", { messageHistory: ["v2"], agentModelSelections: {} }, afterRestart.revision)
    assert.deepEqual((await store2.read("ws")).data.messageHistory, ["v2"])
  })
})

describe("InstanceStore corruption fail-closed", () => {
  it("throws on malformed JSON and wrong-shaped data instead of returning default", async (t) => {
    const store = await tempStore(t)
    const filePath = path.join(
      (store as unknown as { instancesDir: string }).instancesDir,
      `${await import("crypto").then((c) => c.createHash("sha256").update("ws").digest("hex"))}.json`,
    )
    await fs.writeFile(filePath, "{ this is not json")
    await assert.rejects(store.read("ws"), InstanceStoreCorruptionError)

    await fs.writeFile(filePath, JSON.stringify({ revision: 1, data: { messageHistory: "nope", agentModelSelections: {} } }))
    await assert.rejects(store.read("ws"), InstanceStoreCorruptionError)

    await fs.writeFile(filePath, JSON.stringify({ revision: "1", data: { messageHistory: [], agentModelSelections: {} } }))
    await assert.rejects(store.read("ws"), InstanceStoreCorruptionError)
  })

  it("treats only a missing file as the default", async (t) => {
    const store = await tempStore(t)
    const missing = await store.read("does-not-exist")
    assert.equal(missing.revision, 0)
    assert.deepEqual(missing.data, empty())
  })
})
