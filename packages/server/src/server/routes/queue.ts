import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { QueueFanOutEntry } from "../../queue/manager"
import { QueueManager } from "../../queue/manager"
import type { QueuedPrompt, QueueMutation, QueueStorageErrorResponse } from "../../api-types"

interface RouteDeps {
  queueManager: QueueManager
}

const MutateBodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("enqueue"), key: z.string().min(1), expectedRevision: z.string(), text: z.string(), attachments: z.array(z.unknown()).optional() }),
  z.object({ op: z.literal("import-legacy"), key: z.string().min(1), expectedRevision: z.string(), item: z.unknown() }),
  z.object({ op: z.literal("restore"), key: z.string().min(1), expectedRevision: z.string(), item: z.unknown(), pause: z.boolean().optional() }),
  z.object({ op: z.literal("dequeue"), key: z.string().min(1), expectedRevision: z.string() }),
  z.object({ op: z.literal("move"), key: z.string().min(1), expectedRevision: z.string(), id: z.string().min(1), delta: z.number().int() }),
  z.object({ op: z.literal("remove"), key: z.string().min(1), expectedRevision: z.string(), id: z.string().min(1) }),
  z.object({ op: z.literal("update"), key: z.string().min(1), expectedRevision: z.string(), id: z.string().min(1), text: z.string(), attachments: z.array(z.unknown()).optional() }),
  z.object({ op: z.literal("clear"), key: z.string().min(1), expectedRevision: z.string() }),
  z.object({ op: z.literal("set-paused"), key: z.string().min(1), expectedRevision: z.string(), paused: z.boolean() }),
])

const ListQuerySchema = z.object({ key: z.string().min(1).optional() })

const FanOutBodySchema = z.object({
  targets: z.array(z.object({ key: z.string().min(1), expectedRevision: z.string() })).min(1).max(64),
  text: z.string(),
  attachments: z.array(z.unknown()).optional(),
})

export function registerQueueRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/queue", async (request, reply) => {
    const query = ListQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.code(400).send({ error: "invalid query" })
    const storageFailure = deps.queueManager.getStorageFailure()
    if (storageFailure) {
      const response: QueueStorageErrorResponse = { ok: false, code: "storage", error: storageFailure }
      return reply.code(503).send(response)
    }
    if (query.data.key) {
      if (!QueueManager.isValidKey(query.data.key)) {
        return reply.code(400).send({ error: "invalid key" })
      }
      const state = deps.queueManager.get(query.data.key)
      return { queues: state ? { [query.data.key]: state } : {} }
    }
    return { queues: deps.queueManager.getAll() }
  })

  app.post("/api/queue/mutate", async (request, reply) => {
    const body = MutateBodySchema.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: "invalid body" })

    const { key, expectedRevision } = body.data
    if (!QueueManager.isValidKey(key)) return reply.code(400).send({ error: "invalid key" })

    let queueMutation: QueueMutation
    switch (body.data.op) {
      case "enqueue": queueMutation = { op: "enqueue", text: body.data.text, attachments: body.data.attachments }; break
      case "import-legacy": queueMutation = { op: "import-legacy", item: body.data.item }; break
      case "restore": queueMutation = { op: "restore", item: body.data.item, pause: body.data.pause }; break
      case "dequeue": queueMutation = { op: "dequeue" }; break
      case "move": queueMutation = { op: "move", id: body.data.id, delta: body.data.delta }; break
      case "remove": queueMutation = { op: "remove", id: body.data.id }; break
      case "update": queueMutation = { op: "update", id: body.data.id, text: body.data.text, attachments: body.data.attachments }; break
      case "clear": queueMutation = { op: "clear" }; break
      case "set-paused": queueMutation = { op: "set-paused", paused: body.data.paused }; break
    }
    const result = await deps.queueManager.mutate(key, expectedRevision, queueMutation)
    if (result.ok) return result
    if (result.code === "conflict") {
      return reply.code(409).send(result)
    }
    if (result.code === "storage") return reply.code(503).send(result)
    return result
  })

  app.post("/api/queue/fanout", async (request, reply) => {
    const body = FanOutBodySchema.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: "invalid body" })

    // Atomic fan-out: one server transaction over all unique targets. A single
    // conflict/storage failure commits NONE of them, so a failed fan-out can
    // never leave prompts queued behind a generic error.
    const seen = new Set<string>()
    const entries: QueueFanOutEntry[] = []
    for (const target of body.data.targets) {
      if (!QueueManager.isValidKey(target.key)) return reply.code(400).send({ error: "invalid key" })
      if (seen.has(target.key)) continue
      seen.add(target.key)
      entries.push({
        key: target.key,
        expectedRevision: target.expectedRevision,
        mutation: { op: "enqueue", text: body.data.text, attachments: body.data.attachments } as QueueMutation,
      })
    }

    const result = await deps.queueManager.mutateMany(entries)
    if (result.ok) {
      const items: QueuedPrompt[] = result.states
        .map((state) => state.state.items[state.state.items.length - 1])
        .filter((item): item is QueuedPrompt => Boolean(item))
      return { ok: true, items }
    }
    if (result.code === "conflict") return reply.code(409).send(result)
    if (result.code === "storage") return reply.code(503).send(result)
    return result
  })
}
