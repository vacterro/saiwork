import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"

import { ANTIGRAVITY_SHIM_API_KEY } from "../../google/adapter"
import { antigravitySession, type AntigravitySession } from "../../google/antigravity-session"
import { antigravityCatalog } from "../../google/models"
import { openAiSseChunk, sseEncode } from "./sse-shared"
import {
  normalizeAntigravityModel,
  translateCloudCodeFrame,
  translateOpenAiRequest,
  ToolCallRegistry,
  type OpenAiChatRequest,
  type OpenAiChunk,
  type OpenAiToolCall,
} from "../../google/shim"

/**
 * Local OpenAI-compatible shim in front of the Antigravity subscription.
 *
 * OpenCode workspaces are configured with an `@ai-sdk/openai-compatible`
 * provider pointed at `${serverBaseUrl}/v1`. These routes accept that traffic
 * and translate it to Google's internal code-assistant backend
 * (cloudcode-pa.googleapis.com), using the server-side OAuth session. The
 * shim requires the shared token OpenCode was configured with; it is a local
 * gate against stray browser/localhost traffic, not a real secret.
 */

interface ShimDeps {
  session?: AntigravitySession
  registry?: ToolCallRegistry
}

function openAiToolCalls(toolCalls: OpenAiChunk["toolCalls"]): OpenAiToolCall[] {
  return (toolCalls ?? []).map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }))
}

function parseChatBody(body: unknown): OpenAiChatRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (typeof value.model !== "string" || !value.model.trim()) return null
  if (!Array.isArray(value.messages)) return null
  return {
    model: value.model,
    messages: value.messages as OpenAiChatRequest["messages"],
    stream: value.stream === true,
    ...(Array.isArray(value.tools) ? { tools: value.tools as OpenAiChatRequest["tools"] } : {}),
    ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
    ...(typeof value.max_tokens === "number" ? { max_tokens: value.max_tokens } : {}),
    ...(typeof value.top_p === "number" ? { top_p: value.top_p } : {}),
  }
}

export function registerGoogleShimRoutes(app: FastifyInstance, deps: ShimDeps = {}) {
  const session = deps.session ?? antigravitySession
  const registry = deps.registry ?? new ToolCallRegistry()

  app.get("/v1/models", async () => {
    const data = antigravityCatalog().map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "google-antigravity",
    }))
    return { object: "list", data }
  })

  app.post<{ Body: unknown }>("/v1/chat/completions", async (request, reply) => {
    const auth = request.headers.authorization ?? ""
    if (auth !== `Bearer ${ANTIGRAVITY_SHIM_API_KEY}`) {
      return reply.code(401).send({ error: { message: "unauthorized" } })
    }
    const body = parseChatBody(request.body)
    if (!body) {
      return reply.code(400).send({ error: { message: "invalid body" } })
    }

    const model = normalizeAntigravityModel(body.model)
    const args = translateOpenAiRequest(body, registry)
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

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

      let sawToolCalls = false
      let promptTokens = 0
      let completionTokens = 0
      let totalTokens = 0
      try {
        for await (const frame of session.streamGenerate(model, { ...args, signal: abort.signal })) {
          for (const chunk of translateCloudCodeFrame(frame, registry)) {
            if (chunk.toolCalls?.length) sawToolCalls = true
            if (chunk.usage) {
              promptTokens = chunk.usage.promptTokens
              completionTokens = chunk.usage.completionTokens
              totalTokens = chunk.usage.totalTokens
            }
            raw.write(sseEncode(openAiSseChunk({
              id,
              created,
              model,
              delta: { content: chunk.content, toolCalls: chunk.toolCalls },
              finishReason: chunk.finishReason,
            })))
          }
        }
        raw.write(sseEncode(openAiSseChunk({
          id,
          created,
          model,
          finishReason: sawToolCalls ? "tool_calls" : "stop",
        })))
        raw.write("data: [DONE]\n\n")
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        raw.write(`data: ${JSON.stringify({ error: { message }, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens })}\n\n`)
      } finally {
        raw.end()
      }
      return
    }

    let text = ""
    const toolCalls: OpenAiToolCall[] = []
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    try {
      for await (const frame of session.streamGenerate(model, args)) {
        for (const chunk of translateCloudCodeFrame(frame, registry)) {
          if (chunk.content) text += chunk.content
          if (chunk.toolCalls) toolCalls.push(...openAiToolCalls(chunk.toolCalls))
          if (chunk.usage) {
            promptTokens = chunk.usage.promptTokens
            completionTokens = chunk.usage.completionTokens
            totalTokens = chunk.usage.totalTokens
          }
        }
      }
      return {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text || null,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(502).send({ error: { message } })
    }
  })
}
