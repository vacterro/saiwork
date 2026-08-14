import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { addInstance, removeInstance } from "./instances.ts"
import { getInstanceConfig, updateInstanceConfig } from "./instance-config.tsx"
import { messageStoreBus } from "./message-v2/bus.ts"

function instance(id: string) {
  return { id, folder: "/work", port: 0, pid: 0, proxyPath: "", status: "ready" as const, client: null }
}

async function seedInstanceConfig(instanceId: string): Promise<void> {
  await updateInstanceConfig(instanceId, (draft) => {
    draft.agentModelSelections.ag = { providerId: "provider-x", modelId: "model-x" }
  })
}

describe("instance deletion state reclamation", () => {
  it("evicts instance-config and message-history caches only on authoritative deletion", async () => {
    const id = "authoritative-deletion"
    addInstance(instance(id))
    await seedInstanceConfig(id)
    messageStoreBus.getOrCreate(id)
    assert.equal(getInstanceConfig(id).agentModelSelections.ag?.modelId, "model-x")
    assert.ok(messageStoreBus.getInstance(id), "message store exists before deletion")

    removeInstance(id)

    assert.equal(getInstanceConfig(id).agentModelSelections.ag, undefined, "instance data must be evicted")
    assert.equal(messageStoreBus.getInstance(id), undefined, "message history cache must be evicted")
  })

  it("retains instance-config and message-history caches across transient removal", async () => {
    const id = "transient-removal"
    addInstance(instance(id))
    await seedInstanceConfig(id)
    messageStoreBus.getOrCreate(id)

    removeInstance(id, { authoritative: false })

    assert.equal(getInstanceConfig(id).agentModelSelections.ag?.modelId, "model-x", "instance data must survive a disconnect")
    assert.ok(messageStoreBus.getInstance(id), "message history cache must survive a disconnect")
  })
})
