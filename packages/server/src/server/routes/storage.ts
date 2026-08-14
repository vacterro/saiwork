import { FastifyInstance } from "fastify"
import { z } from "zod"
import { InstanceStore, InstanceStoreConflictError, InstanceStoreCorruptionError } from "../../storage/instance-store"
import { EventBus } from "../../events/bus"
import { ModelPreferenceSchema } from "../../config/schema"
import type { InstanceData } from "../../api-types"
import { WorkspaceManager } from "../../workspaces/manager"

interface RouteDeps {
  instanceStore: InstanceStore
  eventBus: EventBus
  workspaceManager: WorkspaceManager
}

const InstanceDataSchema = z.object({
  messageHistory: z.array(z.string()),
  agentModelSelections: z.record(z.string(), ModelPreferenceSchema),
})

const PutBodySchema = z.object({
  data: InstanceDataSchema,
  expectedRevision: z.number().int().nonnegative(),
})

const DeleteBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
})

const EMPTY_INSTANCE_DATA: InstanceData = {
  messageHistory: [],
  agentModelSelections: {},
}

export function registerStorageRoutes(app: FastifyInstance, deps: RouteDeps) {
  // Runtime instance storage is keyed by a REGISTERED workspace's path only.
  // Falling back to the raw instance id would let a late client of a deleted
  // instance mint a brand-new hashed persistence namespace (revision 0) that
  // no registered workspace owns, contradicting permanent deletion. Unknown
  // ids resolve to null and every route returns 404.
  const resolveStorageKey = (instanceId: string): string | null => {
    return deps.workspaceManager.get(instanceId)?.path ?? null
  }

  const sendConflict = (reply: { code: (code: number) => { send: (body: unknown) => void } }, error: InstanceStoreConflictError) => {
    reply.code(409).send({
      error: error.message,
      currentRevision: error.currentRevision,
      expectedRevision: error.expectedRevision,
    })
  }

  app.get<{ Params: { id: string } }>("/api/storage/instances/:id", async (request, reply) => {
    try {
      const storageId = resolveStorageKey(request.params.id)
      if (storageId === null) {
        reply.code(404)
        return { error: "Instance is not a registered workspace" }
      }
      const stored = await deps.instanceStore.read(storageId)
      return { data: stored.data, revision: stored.revision }
    } catch (error) {
      if (error instanceof InstanceStoreCorruptionError) {
        reply.code(500)
        return { error: error.message }
      }
      reply.code(500)
      return { error: error instanceof Error ? error.message : "Failed to read instance data" }
    }
  })

  app.put<{ Params: { id: string } }>("/api/storage/instances/:id", async (request, reply) => {
    try {
      const body = PutBodySchema.parse(request.body ?? {})
      const storageId = resolveStorageKey(request.params.id)
      if (storageId === null) {
        reply.code(404)
        return { error: "Instance is not a registered workspace" }
      }
      const stored = await deps.instanceStore.write(storageId, body.data, body.expectedRevision)
      deps.eventBus.publish({
        type: "instance.dataChanged",
        instanceId: request.params.id,
        data: stored.data,
        revision: stored.revision,
      })
      return { data: stored.data, revision: stored.revision }
    } catch (error) {
      if (error instanceof InstanceStoreConflictError) {
        return sendConflict(reply, error)
      }
      if (error instanceof InstanceStoreCorruptionError) {
        reply.code(500)
        return { error: error.message }
      }
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to save instance data" }
    }
  })

  app.delete<{ Params: { id: string } }>("/api/storage/instances/:id", async (request, reply) => {
    try {
      const body = DeleteBodySchema.parse(request.body ?? {})
      const storageId = resolveStorageKey(request.params.id)
      if (storageId === null) {
        reply.code(404)
        return { error: "Instance is not a registered workspace" }
      }
      await deps.instanceStore.delete(storageId, body.expectedRevision)
      deps.eventBus.publish({
        type: "instance.dataChanged",
        instanceId: request.params.id,
        data: EMPTY_INSTANCE_DATA,
        revision: 0,
      })
      reply.code(204)
      return undefined
    } catch (error) {
      if (error instanceof InstanceStoreConflictError) {
        return sendConflict(reply, error)
      }
      if (error instanceof InstanceStoreCorruptionError) {
        reply.code(500)
        return { error: error.message }
      }
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to delete instance data" }
    }
  })
}
