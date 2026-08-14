import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { FreebuffController } from "../../freebuff/controller"
import { freebuffLiveCatalog } from "../../freebuff/models"
import {
  FREEBUFF_EXECUTION_MODE_LOCAL,
  FREEBUFF_EXECUTION_MODE_WORKTREE,
  FREEBUFF_HARNESS_ID,
} from "../../freebuff/types"
import type { Logger } from "../../logger"

interface RouteDeps {
  freebuff: FreebuffController
  logger: Logger
}

const CreateThreadSchema = z.object({
  projectPath: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  executionMode: z.enum([FREEBUFF_EXECUTION_MODE_LOCAL, FREEBUFF_EXECUTION_MODE_WORKTREE]).optional(),
  title: z.string().min(1).optional(),
})

const PostMessageSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(z.string()).default([]),
})

const EnqueueSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(z.string()).default([]),
})

export function registerFreebuffRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/freebuff/models", async () => ({
    models: freebuffLiveCatalog(await deps.freebuff.liveModelIds()),
  }))

  app.get("/api/freebuff/status", async (_request, reply) => {
    const status = deps.freebuff.status()
    return {
      ...publicFreebuffStatus(status, deps.freebuff.auth()),
      quota: await deps.freebuff.quota(),
    }
  })

  app.post("/api/freebuff/start", async (_request, reply) => {
    const status = await deps.freebuff.ensureRunning()
    if (!status.installFound || !status.engineRunning) {
      return reply.code(503).send({ error: status.error ?? "FreeBuff engine unavailable" })
    }
    return {
      ...publicFreebuffStatus(status, deps.freebuff.auth()),
      quota: await deps.freebuff.quota(),
    }
  })

  app.post("/api/freebuff/stop", async (_request) => {
    await deps.freebuff.stop()
    return { ok: true }
  })

  app.get("/api/freebuff/quota", async () => deps.freebuff.quota())

  app.post("/api/freebuff/release-slot", async (_request, reply) => {
    if (!deps.freebuff.status().ready) {
      return reply.code(503).send({ error: "FreeBuff engine not running" })
    }
    return deps.freebuff.releaseSlotNow()
  })

  app.get("/api/freebuff/threads", async (_request, reply) => {
    if (!deps.freebuff.status().ready) {
      return reply.code(503).send({ error: "FreeBuff engine not running" })
    }
    // The controller mirrors open threads from the engine's event stream
    // (including the replay on subscribe), so this list is authoritative even
    // though the orchestrator exposes no bulk list route.
    return { threads: deps.freebuff.listThreads() }
  })

  app.post<{ Body: unknown }>("/api/freebuff/threads", async (request, reply) => {
    const parsed = CreateThreadSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" })
    const client = deps.freebuff.client()
    if (!client) return reply.code(503).send({ error: "FreeBuff engine not running" })
    const thread = await client.createThread({
      projectPath: parsed.data.projectPath,
      harnessId: FREEBUFF_HARNESS_ID,
      model: parsed.data.model,
      reasoningEffort: parsed.data.reasoningEffort,
      executionMode: parsed.data.executionMode,
      title: parsed.data.title,
    })
    return thread
  })

  app.get<{ Params: { id: string } }>("/api/freebuff/threads/:id", async (request, reply) => {
    const client = deps.freebuff.client()
    if (!client) return reply.code(503).send({ error: "FreeBuff engine not running" })
    try {
      return await client.getThread(request.params.id)
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status: number }).status === 404) {
        return reply.code(404).send({ error: "thread not found" })
      }
      throw error
    }
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/freebuff/threads/:id/message", async (request, reply) => {
    const parsed = PostMessageSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" })
    const client = deps.freebuff.client()
    if (!client) return reply.code(503).send({ error: "FreeBuff engine not running" })
    // FreeBuff allows one hosted tab per network; close the other threads that
    // hold a slot so this thread's turn can be admitted.
    await deps.freebuff.freeSlotFor(request.params.id)
    return await client.postMessage(request.params.id, parsed.data.text, parsed.data.attachments)
  })

  app.post<{ Params: { id: string }; Body: unknown }>("/api/freebuff/threads/:id/enqueue", async (request, reply) => {
    const parsed = EnqueueSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" })
    const client = deps.freebuff.client()
    if (!client) return reply.code(503).send({ error: "FreeBuff engine not running" })
    return await client.enqueue(request.params.id, parsed.data.text, parsed.data.attachments)
  })

  app.post<{ Params: { id: string } }>("/api/freebuff/threads/:id/stop", async (request, reply) => {
    const client = deps.freebuff.client()
    if (!client) return reply.code(503).send({ error: "FreeBuff engine not running" })
    return await client.stopThread(request.params.id)
  })

  app.post<{ Params: { id: string } }>("/api/freebuff/threads/:id/resume", async (request, reply) => {
    const client = deps.freebuff.client()
    if (!client) return reply.code(503).send({ error: "FreeBuff engine not running" })
    return await client.resumeThread(request.params.id)
  })

  app.get("/api/freebuff/events", (request, reply) => {
    const client = deps.freebuff.client()
    if (!client) {
      return reply.code(503).send({ error: "FreeBuff engine not running" })
    }
    const origin = request.headers.origin ?? "*"
    reply.raw.setHeader("Access-Control-Allow-Origin", origin)
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true")
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    let closed = false
    let unsubscribe: (() => void) | null = null
    const close = () => {
      if (closed) return
      closed = true
      unsubscribe?.()
      reply.raw.end?.()
    }

    const onEvent = (event: unknown) => {
      if (closed) return
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const onEnd = (error?: unknown) => {
      if (error && !closed) {
        deps.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "FreeBuff events stream ended with error")
      }
      close()
    }
    void client.subscribeEvents(onEvent, onEnd).then((unsub) => {
      unsubscribe = unsub
      if (closed) unsub()
    })

    request.raw.on("close", close)
    request.raw.on("error", close)
  })
}

function publicFreebuffStatus(
  status: ReturnType<FreebuffController["status"]>,
  currentAuth: ReturnType<FreebuffController["auth"]>,
) {
  const { auth, ...publicStatus } = status
  return {
    ...publicStatus,
    auth: currentAuth?.user ?? auth?.user ?? null,
  }
}
