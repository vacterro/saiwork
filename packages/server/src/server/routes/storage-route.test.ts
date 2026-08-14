import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { registerStorageRoutes } from "./storage"
import { InstanceStore } from "../../storage/instance-store"
import { EventBus } from "../../events/bus"
import type { WorkspaceManager } from "../../workspaces/manager"

describe("instance storage routes", () => {
  it("returns data+revision, commits CAS writes, and returns 409 on a stale put", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-route-"))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const instanceStore = new InstanceStore(dir)
    const eventBus = new EventBus()
    const changed: Array<{ instanceId: string; revision?: number }> = []
    eventBus.on("instance.dataChanged", (event) => {
      changed.push({ instanceId: (event as { instanceId: string }).instanceId, revision: (event as { revision?: number }).revision })
    })
    const workspaceManager = { get: () => ({ path: "/work" }) } as unknown as WorkspaceManager
    const app = Fastify({ logger: false })
    registerStorageRoutes(app, { instanceStore, eventBus, workspaceManager })
    const workspaceId = "ws-1"

    const initial = await app.inject({ method: "GET", url: `/api/storage/instances/${workspaceId}` })
    assert.equal(initial.statusCode, 200)
    const initialBody = initial.json()
    assert.equal(initialBody.revision, 0)

    const put = await app.inject({
      method: "PUT",
      url: `/api/storage/instances/${workspaceId}`,
      payload: { data: { messageHistory: ["hello"], agentModelSelections: {} }, expectedRevision: 0 },
    })
    assert.equal(put.statusCode, 200)
    assert.equal(put.json().revision, 1)

    const stale = await app.inject({
      method: "PUT",
      url: `/api/storage/instances/${workspaceId}`,
      payload: { data: { messageHistory: ["stale"], agentModelSelections: {} }, expectedRevision: 0 },
    })
    assert.equal(stale.statusCode, 409)
    assert.equal(stale.json().currentRevision, 1)

    const after = await app.inject({ method: "GET", url: `/api/storage/instances/${workspaceId}` })
    assert.deepEqual(after.json().data.messageHistory, ["hello"], "the stale writer must not overwrite")
    assert.ok(changed.some((entry) => entry.instanceId === workspaceId && entry.revision === 1), "a success event was published only after commit")
    await app.close()
  })

  it("returns 409 for a stale delete and a stale put after delete", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-route-"))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const app = Fastify({ logger: false })
    registerStorageRoutes(app, {
      instanceStore: new InstanceStore(dir),
      eventBus: new EventBus(),
      workspaceManager: { get: () => ({ path: "/work" }) } as unknown as WorkspaceManager,
    })
    const workspaceId = "ws-2"

    const put = await app.inject({
      method: "PUT",
      url: `/api/storage/instances/${workspaceId}`,
      payload: { data: { messageHistory: ["v1"], agentModelSelections: {} }, expectedRevision: 0 },
    })
    assert.equal(put.json().revision, 1)

    const staleDelete = await app.inject({ method: "DELETE", url: `/api/storage/instances/${workspaceId}`, payload: { expectedRevision: 0 } })
    assert.equal(staleDelete.statusCode, 409)

    const okDelete = await app.inject({ method: "DELETE", url: `/api/storage/instances/${workspaceId}`, payload: { expectedRevision: 1 } })
    assert.equal(okDelete.statusCode, 204)

    const resurrect = await app.inject({
      method: "PUT",
      url: `/api/storage/instances/${workspaceId}`,
      payload: { data: { messageHistory: ["zombie"], agentModelSelections: {} }, expectedRevision: 1 },
    })
    assert.equal(resurrect.statusCode, 409, "a deleted generation must not be resurrected by a stale writer")
    await app.close()
  })

  it("rejects unknown instance ids with 404 and never mints persistence for a deleted workspace", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-route-"))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const storeDir = path.join(dir, "instances")
    const instanceStore = new InstanceStore(storeDir)
    const registered = new Set<string>(["ws-live"])
    const workspaceManager = {
      get: (id: string) => (registered.has(id) ? { path: path.join(dir, "workspaces", id) } : undefined),
    } as unknown as WorkspaceManager
    const app = Fastify({ logger: false })
    registerStorageRoutes(app, { instanceStore, eventBus: new EventBus(), workspaceManager })
    const storedFiles = async () => fs.readdir(storeDir)

    assert.equal((await app.inject({ method: "GET", url: "/api/storage/instances/ghost" })).statusCode, 404, "unknown id GET fails")
    assert.equal(
      (await app.inject({ method: "PUT", url: "/api/storage/instances/ghost", payload: { data: { messageHistory: [], agentModelSelections: {} }, expectedRevision: 0 } })).statusCode,
      404,
      "unknown id PUT fails",
    )
    assert.equal((await app.inject({ method: "DELETE", url: "/api/storage/instances/ghost", payload: { expectedRevision: 0 } })).statusCode, 404, "unknown id DELETE fails")
    assert.deepEqual(await storedFiles(), [], "an unknown id mints no persistence")

    const put = await app.inject({
      method: "PUT",
      url: "/api/storage/instances/ws-live",
      payload: { data: { messageHistory: ["v1"], agentModelSelections: {} }, expectedRevision: 0 },
    })
    assert.equal(put.statusCode, 200)
    assert.equal(put.json().revision, 1)
    assert.equal((await storedFiles()).length, 1)

    // Authoritative deletion while the workspace is registered removes state.
    const okDelete = await app.inject({ method: "DELETE", url: "/api/storage/instances/ws-live", payload: { expectedRevision: 1 } })
    assert.equal(okDelete.statusCode, 204)
    assert.deepEqual(await storedFiles(), [], "authoritative delete leaves no persisted instance state")

    // The workspace is now gone; a late client with the old id must fail and
    // must not be able to recreate a fresh persistence namespace.
    registered.delete("ws-live")
    assert.equal((await app.inject({ method: "GET", url: "/api/storage/instances/ws-live" })).statusCode, 404, "late GET of a deleted workspace fails")
    const latePut = await app.inject({
      method: "PUT",
      url: "/api/storage/instances/ws-live",
      payload: { data: { messageHistory: ["zombie"], agentModelSelections: {} }, expectedRevision: 1 },
    })
    assert.equal(latePut.statusCode, 404, "late PUT of a deleted workspace is rejected")
    const lateDelete = await app.inject({ method: "DELETE", url: "/api/storage/instances/ws-live", payload: { expectedRevision: 1 } })
    assert.equal(lateDelete.statusCode, 404, "late DELETE of a deleted workspace is rejected")
    assert.deepEqual(await storedFiles(), [], "no new instance JSON may appear after workspace deletion")

    registered.add("ws-live2")
    const put2 = await app.inject({
      method: "PUT",
      url: "/api/storage/instances/ws-live2",
      payload: { data: { messageHistory: ["ok"], agentModelSelections: {} }, expectedRevision: 0 },
    })
    assert.equal(put2.statusCode, 200, "a live registered workspace still persists normally")
    assert.equal(put2.json().revision, 1)
    await app.close()
  })
})
