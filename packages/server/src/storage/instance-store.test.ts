import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { InstanceStore } from "./instance-store"

async function tempStore(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "instance-store-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return new InstanceStore(dir)
}

describe("InstanceStore identity", () => {
  it("never collapses slash vs underscore workspace paths", async (t) => {
    const store = await tempStore(t)
    await store.write("/a/b", { messageHistory: ["from-a-b"], agentModelSelections: { ag: { providerId: "p", modelId: "m" } } })
    await store.write("/a_b", { messageHistory: [], agentModelSelections: { ag: { providerId: "p", modelId: "other" } } })
    const slash = await store.read("/a/b")
    const underscore = await store.read("/a_b")
    assert.deepEqual(slash.messageHistory, ["from-a-b"])
    assert.equal(underscore.messageHistory.length, 0)
    assert.equal(underscore.agentModelSelections.ag.modelId, "other")
  })

  it("keeps case-distinct POSIX paths distinct", async (t) => {
    const store = await tempStore(t)
    await store.write("/Project/Config", { messageHistory: ["upper"], agentModelSelections: {} })
    await store.write("/project/config", { messageHistory: ["lower"], agentModelSelections: {} })
    assert.deepEqual((await store.read("/Project/Config")).messageHistory, ["upper"])
    assert.deepEqual((await store.read("/project/config")).messageHistory, ["lower"])
  })

  it("keeps Unicode paths distinct", async (t) => {
    const store = await tempStore(t)
    await store.write("/привет/мир", { messageHistory: ["русский"], agentModelSelections: {} })
    await store.write("/hello/world", { messageHistory: ["english"], agentModelSelections: {} })
    assert.deepEqual((await store.read("/привет/мир")).messageHistory, ["русский"])
    assert.deepEqual((await store.read("/hello/world")).messageHistory, ["english"])
  })

  it("handles very long identities with a fixed-size key", async (t) => {
    const store = await tempStore(t)
    const longId = `/workspaces/${"x".repeat(2000)}/very/deep/path`
    await store.write(longId, { messageHistory: ["long"], agentModelSelections: {} })
    assert.deepEqual((await store.read(longId)).messageHistory, ["long"])
    const files = await fs.readdir((store as unknown as { instancesDir: string }).instancesDir)
    assert.equal(files.length, 1, "a long id must map to a single fixed-size file")
  })

  it("maps different workspace ids to different storage objects", async (t) => {
    const store = await tempStore(t)
    await store.write("ws-1", { messageHistory: ["one"], agentModelSelections: {} })
    await store.write("ws-2", { messageHistory: ["two"], agentModelSelections: {} })
    assert.deepEqual((await store.read("ws-1")).messageHistory, ["one"])
    assert.deepEqual((await store.read("ws-2")).messageHistory, ["two"])
  })

  it("round-trips the same identity idempotently", async (t) => {
    const store = await tempStore(t)
    await store.write("same-id", { messageHistory: ["v1"], agentModelSelections: {} })
    await store.write("same-id", { messageHistory: ["v2"], agentModelSelections: {} })
    assert.deepEqual((await store.read("same-id")).messageHistory, ["v2"])
  })
})
