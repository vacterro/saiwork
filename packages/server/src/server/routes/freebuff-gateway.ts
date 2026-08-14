import { randomUUID } from "node:crypto"

import type { FastifyInstance } from "fastify"

import type { FreebuffClient } from "../../freebuff/client"
import type { FreebuffController } from "../../freebuff/controller"
import {
  FreebuffThreadRegistry,
  isFreebuffSessionLimitError,
  lastUserText,
  runFreebuffTurn,
  type FreebuffDispatchAction,
  type FreebuffOpenAiChatRequest,
  type FreebuffOpenAiMessage,
} from "../../freebuff/gateway"
import { freebuffLiveCatalog, freebuffLiveModelIds } from "../../freebuff/models"
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
  /** Live model ids from the FreeBuff backend; absent => static catalog only. */
  liveModelIds?: () => Promise<Iterable<string>>
}

const MAX_FREEBUFF_MESSAGES = 512
const MAX_FREEBUFF_TOTAL_TEXT_BYTES = 512 * 1024
const VALID_ROLES = new Set(["system", "user", "assistant"])

function parseChatBody(body: unknown): FreebuffOpenAiChatRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (typeof value.model !== "string" || !value.model.trim()) return null
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > MAX_FREEBUFF_MESSAGES) return null
  const messages: FreebuffOpenAiMessage[] = []
  let totalBytes = 0
  for (const raw of value.messages) {
    if (!raw || typeof raw !== "object") return null
    const message = raw as Record<string, unknown>
    if (typeof message.role !== "string" || !VALID_ROLES.has(message.role)) return null
    const content = message.content
    if (content === undefined || content === null) {
      messages.push({ role: message.role, content: null })
      continue
    }
    if (typeof content === "string") {
      totalBytes += Buffer.byteLength(content, "utf8")
      if (totalBytes > MAX_FREEBUFF_TOTAL_TEXT_BYTES) return null
      messages.push({ role: message.role, content })
      continue
    }
    if (!Array.isArray(content)) return null
    const parts: Array<{ type: string; text?: string }> = []
    for (const part of content) {
      if (!part || typeof part !== "object") return null
      const candidate = part as Record<string, unknown>
      if (typeof candidate.type !== "string") return null
      // FreeBuff's gateway currently dispatches text only. Reject images
      // instead of silently dropping their URL and aliasing distinct requests.
      if (candidate.type !== "text" || typeof candidate.text !== "string") return null
      parts.push({ type: candidate.type, ...(typeof candidate.text === "string" ? { text: candidate.text } : {}) })
    }
    for (const part of parts) {
      if (part.text) totalBytes += Buffer.byteLength(part.text, "utf8")
    }
    messages.push({ role: message.role, content: parts })
    if (totalBytes > MAX_FREEBUFF_TOTAL_TEXT_BYTES) return null
  }
  return {
    model: value.model,
    messages,
    stream: value.stream === true,
  }
}

export function registerFreebuffGatewayRoutes(app: FastifyInstance, deps: GatewayDeps) {
  const registry = deps.registry ?? new FreebuffThreadRegistry()

  app.get("/fb/v1/models", async () => {
    const liveIds = await (deps.liveModelIds?.() ?? Promise.resolve([]))
    return {
      object: "list",
      data: freebuffLiveCatalog(liveIds).map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "freebuff",
      })),
    }
  })

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

    const prompt = lastUserText(body.messages)
    if (!prompt) {
      return reply.code(400).send({ error: { message: "no user message" } })
    }
    if (!freebuffLiveModelIds(await (deps.liveModelIds?.() ?? Promise.resolve([]))).has(body.model)) {
      return reply.code(400).send({ error: { message: `unsupported model: ${body.model}` } })
    }

    // Real conversation identity from OpenCode's per-request session header.
    // Prompt text is never an identity fallback.
    const sessionHeader = request.headers["x-session-id"]
    const sessionId = typeof sessionHeader === "string" ? sessionHeader.trim() : ""
    if (!sessionId) {
      return reply.code(400).send({ error: { message: "missing x-session-id" } })
    }

    const status = await deps.freebuff.ensureRunning()
    const client = deps.freebuff.client()
    if (!client || !status.engineRunning) {
      return reply.code(503).send({ error: { message: status.error ?? "FreeBuff engine unavailable" } })
    }

    let threadId: string
    let action: FreebuffDispatchAction
    let fingerprint: string
    try {
      const resolved = await registry.getOrCreate(client, workspace, sessionId, body.model, body.messages)
      threadId = resolved.threadId
      action = resolved.action
      fingerprint = resolved.fingerprint
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

    if (action.kind === "in-flight") {
      // Concurrent duplicate of the same turn. Never fake a completed model
      // response; surface a retryable conflict instead.
      return reply.code(409).send({ error: { message: "FreeBuff turn already in flight for this request" } })
    }

    if (action.kind === "completed-unavailable") {
      return reply.code(409).send({ error: { message: "FreeBuff turn already completed, but its replay result is no longer cached" } })
    }

    if (action.kind === "replay") {
      // Exact transport replay of an already-completed request: return the
      // recorded result, never an empty fake completion.
      if (body.stream) {
        reply.hijack()
        reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        if (action.result) {
          reply.raw.write(sseEncode(openAiSseChunk({ id, created, model: body.model, delta: { content: action.result } })))
        }
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
        choices: [{ index: 0, message: { role: "assistant", content: action.result }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: action.result.length, total_tokens: action.result.length },
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
        registry.completeTurn(threadId, fingerprint, text)
      } catch (error) {
        registry.failTurn(threadId, fingerprint)
        const message = error instanceof Error ? error.message : String(error)
        raw.write(`data: ${JSON.stringify({ error: { message } })}\n\n`)
        raw.end()
        return
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
      registry.completeTurn(threadId, fingerprint, text)
      return {
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: text.length, total_tokens: text.length },
      }
    } catch (error) {
      registry.failTurn(threadId, fingerprint)
      const message = error instanceof Error ? error.message : String(error)
      return reply.code(502).send({ error: { message } })
    }
  })
}

/**
 * Free the hosted-model slot, run one turn, and close the thread afterwards so
 * the slot is not held by an idle gateway conversation. If the admission still
 * fails because another tab is holding the slot, close the siblings again and
 * retry for a bounded window before surfacing the error: the holder is often a
 * FreeBuff Desktop tab the user closed a moment ago, whose cloud session takes
 * a few seconds to expire. Waiting it out makes resuming seamless instead of
 * failing the very first message, and an admission that never succeeded has
 * consumed no quota at all.
 */
export const SLOT_RETRY_ATTEMPTS = 6
export const SLOT_RETRY_WAIT_MS = 4_000
export const THREAD_CLOSE_WAIT_MS = 5_000

export async function runTurnWithSlotRetry(
  freebuff: FreebuffController,
  client: FreebuffClient,
  threadId: string,
  prompt: string,
  onText: (text: string) => void,
  options: {
    signal?: AbortSignal
    onStep?: (text: string) => void
    slotRetry?: { attempts?: number; waitMs?: number }
    closeWaitMs?: number
  } = {},
): Promise<string> {
  // If an earlier turn already entered closeThread, let it finish before this
  // message reopens the thread. Starting between the old generation check and
  // close completion would otherwise let a stale close kill this active turn.
  const pendingClose = pendingThreadCloses.get(threadId)
  if (pendingClose) {
    await waitForPendingThreadClose(threadId, pendingClose, options.closeWaitMs ?? THREAD_CLOSE_WAIT_MS, options.signal)
  }
  // This request owns a turn generation; a rapid next request bumps it, which
  // makes this request's post-turn close stand down instead of closing the
  // thread under the new turn.
  const generation = nextTurnGeneration(threadId)
  const attempts = options.slotRetry?.attempts ?? SLOT_RETRY_ATTEMPTS
  const waitMs = options.slotRetry?.waitMs ?? SLOT_RETRY_WAIT_MS
  const runOnce = async () => {
    throwIfRequestAborted(options.signal)
    await freebuff.freeSlotFor(threadId, { signal: options.signal })
    throwIfRequestAborted(options.signal)
    return runFreebuffTurn(client, threadId, prompt, onText, options)
  }
  let waitingNotified = false
  let lastError: unknown = null
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await runOnce()
      } catch (error) {
        if (!isFreebuffSessionLimitError(error)) throw error
        lastError = error
        if (attempt + 1 >= attempts) break
        // Another tab holds the slot; close the siblings and wait for the release
        // to propagate to the cloud before retrying the admission.
        if (!waitingNotified) {
          waitingNotified = true
          options.onStep?.("> waiting for the FreeBuff slot (another tab is holding it)…")
        }
        await freebuff.freeSlotFor(threadId, { waitMs: 1500, signal: options.signal })
        await waitForRetryDelay(waitMs, options.signal)
      }
    }
    const base = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`${base} No FreeBuff quota was consumed. Close the other tab, or use the slot release button in the FreeBuff panel.`)
  } finally {
    // Release the slot after the turn so a different conversation can start
    // without hitting the one-tab limit. Sending another message reopens the
    // thread and preserves its history. The generation guard stops a stale
    // post-turn close from closing a thread already reused by a newer turn.
    setTimeout(() => {
      if (currentTurnGeneration(threadId) !== generation) return
      const abort = new AbortController()
      const promise = client.closeThread(threadId, { signal: abort.signal }).then(() => undefined, () => undefined)
      const close = { promise, abort }
      pendingThreadCloses.set(threadId, close)
      void promise.finally(() => {
        if (pendingThreadCloses.get(threadId) === close) pendingThreadCloses.delete(threadId)
        if (currentTurnGeneration(threadId) === generation) turnGenerations.delete(threadId)
      })
    }, 750)
  }
}

const turnGenerations = new Map<string, number>()
interface PendingThreadClose {
  promise: Promise<void>
  abort: AbortController
}
const pendingThreadCloses = new Map<string, PendingThreadClose>()

function waitForPendingThreadClose(threadId: string, close: PendingThreadClose, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(new Error("Request aborted"))
    const timer = setTimeout(() => {
      close.abort.abort()
      finish(new Error(`FreeBuff thread close did not settle within ${timeoutMs}ms`))
    }, timeoutMs)
    if (timer.unref) timer.unref()
    close.promise.then(() => finish(), finish)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function waitForRetryDelay(waitMs: number, signal?: AbortSignal): Promise<void> {
  throwIfRequestAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("Request aborted"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, waitMs)
    if (timer.unref) timer.unref()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function throwIfRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Request aborted")
}

function currentTurnGeneration(threadId: string): number {
  return turnGenerations.get(threadId) ?? 0
}

/** Mark a new turn for the thread; the pending post-turn close must stand down. */
function nextTurnGeneration(threadId: string): number {
  const next = currentTurnGeneration(threadId) + 1
  turnGenerations.set(threadId, next)
  return next
}
