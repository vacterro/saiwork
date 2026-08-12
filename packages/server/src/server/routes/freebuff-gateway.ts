import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"

import type { FreebuffClient } from "../../freebuff/client"
import type { FreebuffController } from "../../freebuff/controller"
import {
  firstUserText,
  FreebuffThreadRegistry,
  isFreebuffSessionLimitError,
  lastUserText,
  runFreebuffTurn,
  type FreebuffOpenAiChatRequest,
} from "../../freebuff/gateway"
import { FREEBUFF_MODELS } from "../../freebuff/models"
import { FREEBUFF_SHIM_API_KEY } from "../shim-keys"
import { openAiSseChunk, sseEncode } from "./sse-shared"

/**
 * OpenAI-compatible gateway in front of the FreeBuff agent engine.
 *
 * OpenCode workspaces get a `freebuff` provider pointed at
 * `${serverBaseUrl}/fb/v1`. Each request is routed to a FreeBuff thread (one
 * per workspace + conversation) and the agent turn's `text` events are
 * streamed back as OpenAI SSE. The workspace folder travels in the
 * `x-saiwork-workspace` header injected by the provider config so threads are
 * created in the right project.
 */

// Per-instance bearer key for the FreeBuff shim (see server/shim-keys.ts).
export { FREEBUFF_SHIM_API_KEY }

interface GatewayDeps {
  freebuff: FreebuffController
  registry?: FreebuffThreadRegistry
}

function parseChatBody(body: unknown): FreebuffOpenAiChatRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (typeof value.model !== "string" || !value.model.trim()) return null
  if (!Array.isArray(value.messages)) return null
  return {
    model: value.model,
    messages: value.messages as FreebuffOpenAiChatRequest["messages"],
    stream: value.stream === true,
  }
}

export function registerFreebuffGatewayRoutes(app: FastifyInstance, deps: GatewayDeps) {
  const registry = deps.registry ?? new FreebuffThreadRegistry()

  app.get("/fb/v1/models", async () => ({
    object: "list",
    data: FREEBUFF_MODELS.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "freebuff",
    })),
  }))

  app.post<{ Body: unknown }>("/fb/v1/chat/completions", async (request, reply) => {
    const auth = request.headers.authorization ?? ""
    if (auth !== `Bearer ${FREEBUFF_SHIM_API_KEY}`) {
      return reply.code(401).send({ error: { message: "unauthorized" } })
    }
    const body = parseChatBody(request.body)
    if (!body) {
      return reply.code(400).send({ error: { message: "invalid body" } })
    }
    const workspace = typeof request.headers["x-saiwork-workspace"] === "string"
      ? request.headers["x-saiwork-workspace"]
      : ""

    const status = await deps.freebuff.ensureRunning()
    const client = deps.freebuff.client()
    if (!client || !status.engineRunning) {
      return reply.code(503).send({ error: { message: status.error ?? "FreeBuff engine unavailable" } })
    }

    const first = firstUserText(body.messages)
    const prompt = lastUserText(body.messages)
    if (!prompt) {
      return reply.code(400).send({ error: { message: "no user message" } })
    }

    let threadId: string
    let skip: boolean
    try {
      const resolved = await registry.getOrCreate(client, workspace, body.model, first || prompt, prompt)
      threadId = resolved.threadId
      skip = resolved.skip
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(502).send({ error: { message } })
    }

    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const emit = (content: string) => reply.raw.write(sseEncode(openAiSseChunk({
      id,
      created,
      model: body.model,
      delta: { content },
    })))

    if (skip) {
      // Same prompt already dispatched; the engine is mid-turn or the client
      // retried. Answer with an empty completion rather than double-posting.
      if (body.stream) {
        reply.hijack()
        reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        reply.raw.write(sseEncode(openAiSseChunk({ id, created, model: body.model, finishReason: "stop" })))
        reply.raw.write("data: [DONE]\n\n")
        reply.raw.end()
        return
      }
      return {
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }
    }

    if (body.stream) {
      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
      })
      const abort = new AbortController()
      reply.raw.on("close", () => abort.abort())
      let text = ""
      try {
        text = await runTurnWithSlotRetry(deps.freebuff, client, threadId, prompt, (chunk) => emit(chunk), {
          signal: abort.signal,
          onStep: (chunk) => emit(chunk),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        raw.write(`data: ${JSON.stringify({ error: { message } })}\n\n`)
      }
      if (!abort.signal.aborted) {
        raw.write(sseEncode(openAiSseChunk({ id, created, model: body.model, finishReason: "stop" })))
        raw.write("data: [DONE]\n\n")
      }
      raw.end()
      void text
      return
    }

    try {
      let text = ""
      await runTurnWithSlotRetry(deps.freebuff, client, threadId, prompt, (chunk) => {
        text += chunk
      }, {
        onStep: (chunk) => {
          text += chunk
        },
      })
      return {
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(502).send({ error: { message } })
    }
  })
}

/**
 * Free the hosted-model slot, run one turn, and close the thread afterwards so
 * the slot is not held by an idle gateway conversation. If the admission still
 * fails because another tab is holding the slot, close the siblings again and
 * retry once before surfacing the error.
 */
async function runTurnWithSlotRetry(
  freebuff: FreebuffController,
  client: FreebuffClient,
  threadId: string,
  prompt: string,
  onText: (text: string) => void,
  options: { signal?: AbortSignal; onStep?: (text: string) => void } = {},
): Promise<string> {
  // This request owns a turn generation; a rapid next request bumps it, which
  // makes this request's post-turn close stand down instead of closing the
  // thread under the new turn.
  const generation = nextTurnGeneration(threadId)
  const runOnce = async () => {
    await freebuff.freeSlotFor(threadId)
    return runFreebuffTurn(client, threadId, prompt, onText, options)
  }
  try {
    return await runOnce()
  } catch (error) {
    if (!isFreebuffSessionLimitError(error)) throw error
    // Another tab holds the slot; close the siblings and wait for the release
    // to propagate to the cloud before retrying the admission.
    await freebuff.freeSlotFor(threadId, { waitMs: 1500 })
    return runOnce()
  } finally {
    // Release the slot after the turn so a different conversation can start
    // without hitting the one-tab limit. Sending another message reopens the
    // thread and preserves its history.
    setTimeout(() => {
      if (currentTurnGeneration(threadId) !== generation) return
      void client.closeThread(threadId).catch(() => undefined)
    }, 750)
  }
}

const turnGenerations = new Map<string, number>()

function currentTurnGeneration(threadId: string): number {
  return turnGenerations.get(threadId) ?? 0
}

/** Mark a new turn for the thread; the pending post-turn close must stand down. */
function nextTurnGeneration(threadId: string): number {
  const next = currentTurnGeneration(threadId) + 1
  turnGenerations.set(threadId, next)
  return next
}
