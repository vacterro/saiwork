import { FastifyInstance } from "fastify"
import { z } from "zod"
import { QueueManager, type QueueMutation } from "../../queue/manager"

interface RouteDeps {
  queueManager: QueueManager
}

const MutateBodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("enqueue"), key: z.string().min(1), expectedRevision: z.string(), text: z.string(), attachments: z.array(z.unknown()).optional() }),
  z.object({ op: z.literal("dequeue"), key: z.string().min(1), expectedRevision: z.string() }),
  z.object({
    op: z.literal("restore"),
    key: z.string().min(1),
    expectedRevision: z.string(),
    item: z.object({ id: z.string().min(1), text: z.string(), attachments: z.array(z.unknown()).optional(), createdAt: z.number().optional() }),
    pause: z.boolean().optional(),
  }),
  z.object({ op: z.literal("move"), key: z.string().min(1), expectedRevision: z.string(), id: z.string().min(1), delta: z.number().int() }),
  z.object({ op: z.literal("remove"), key: z.string().min(1), expectedRevision: z.string(), id: z.string().min(1) }),
  z.object({ op: z.literal("update"), key: z.string().min(1), expectedRevision: z.string(), id: z.string().min(1), text: z.string(), attachments: z.array(z.unknown()).optional() }),
  z.object({ op: z.literal("clear"), key: z.string().min(1), expectedRevision: z.string() }),
  z.object({ op: z.literal("set-paused"), key: z.string().min(1), expectedRevision: z.string(), paused: z.boolean() }),
])

const ListQuerySchema = z.object({ key: z.string().min(1).optional() })

export function registerQueueRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/queue", async (request, reply) => {
    const query = ListQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.code(400).send({ error: "invalid query" })
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

    const { key, expectedRevision, ...mutation } = body.data
    if (!QueueManager.isValidKey(key)) return reply.code(400).send({ error: "invalid key" })

    const result = await deps.queueManager.mutate(key, expectedRevision, mutation as QueueMutation)
    if (result.ok) {
      const payload: { ok: true; state: import("../../api-types").QueueState; dequeued?: import("../../api-types").QueuedPrompt } = {
        ok: true,
        state: result.state,
        ...(result.dequeued ? { dequeued: result.dequeued } : {}),
      }
      return payload
    }
    if (result.code === "conflict") {
      return reply.code(409).send({ error: "queue changed; refresh and retry", currentRevision: result.currentRevision })
    }
    return { ok: false, code: result.code }
  })
}
