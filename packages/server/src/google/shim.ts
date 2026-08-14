/**
 * Pure translation between the OpenAI chat/completions shape that the OpenCode
 * AI SDK talks and the Antigravity cloudcode-pa request/response shape.
 *
 * Everything here is deterministic and side-effect free except the
 * ToolCallRegistry, which remembers Google's `thoughtSignature` for a tool call
 * so a stateless client replaying history can still satisfy the backend's
 * "functionCall parts must carry a thought_signature" requirement.
 */

import type { PersistedToolCallEntry, ToolCallRegistryPersister } from "./tool-call-persistence"

export interface OpenAiTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

export interface OpenAiToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface OpenAiContentPart {
  type: string
  text?: string
  image_url?: { url?: string }
}

export type OpenAiMessage =
  | { role: "system"; content: string | OpenAiContentPart[] }
  | { role: "user"; content: string | OpenAiContentPart[] }
  | { role: "assistant"; content?: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface OpenAiChatRequest {
  model: string
  messages: OpenAiMessage[]
  stream?: boolean
  tools?: OpenAiTool[]
  temperature?: number
  max_tokens?: number
  top_p?: number
}

export interface CloudCodeGenerateArgs {
  contents: Array<Record<string, unknown>>
  systemInstruction?: { parts: Array<{ text: string }> }
  tools?: Array<Record<string, unknown>>
  generationConfig?: Record<string, unknown>
}

/** Strip the SAIWORK provider prefix (`google_antigravity/...`) from a model id. */
export function normalizeAntigravityModel(model: string): string {
  const stripped = model.startsWith("google_antigravity/") ? model.slice("google_antigravity/".length) : model
  return stripped || model
}

function textOf(content: string | OpenAiContentPart[]): string {
  if (typeof content === "string") return content
  return content
    .filter((part): part is OpenAiContentPart & { text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

function inlineDataParts(content: string | OpenAiContentPart[]): Array<Record<string, unknown>> {
  if (typeof content === "string") return []
  const parts: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (part.type === "image_url" && part.image_url?.url?.startsWith("data:")) {
      const match = /^data:([^;,]+)[^,]*,(.+)$/.exec(part.image_url.url)
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
    }
  }
  return parts
}

export function openAiToolsToCloudCode(tools: OpenAiTool[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined
  const declarations = tools
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      ...(tool.function.parameters
        ? { parameters: sanitizeGeminiSchema(tool.function.parameters) }
        : {}),
    }))
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined
}

/**
 * Keys the cloudcode-pa backend accepts on a function `parameters` schema,
 * probed live against `daily-cloudcode-pa.googleapis.com` (a non-existent model
 * id returns 404 only after JSON schema validation, so the probe burns no
 * quota). OpenCode emits JSON-Schema 2020-12/OpenAPI 3.1 shapes (`$schema`,
 * `$defs`, `exclusiveMinimum`, `if/then/else`, object `additionalProperties`,
 * ...) that the backend rejects with "Unknown name ... Cannot find field".
 * Anything not in this set is stripped recursively; the OpenAPI 3.0 subset the
 * backend does accept survives.
 */
const SUPPORTED_GEMINI_SCHEMA_KEYS = new Set([
  "title",
  "description",
  "type",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "enum",
  "default",
  "example",
  "nullable",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
])

function sanitizeSchemaArray(value: unknown): unknown {
  if (!Array.isArray(value)) return sanitizeGeminiSchema(value)
  return value.map((entry) => sanitizeGeminiSchema(entry))
}

/**
 * Safe upper bound for a tool result or args payload forwarded to the backend
 * as a `google.protobuf.Struct`. The backend rejects oversized structs
 * ("Invalid value at ... function_response.response", size in bytes), so large
 * tool output is truncated to its head instead of failing the whole turn.
 */
export const MAX_FUNCTION_STRUCT_BYTES = 20_000

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** Cut a string on a UTF-8 sequence boundary so no multi-byte character is split. */
function byteSafeTruncate(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text
  const buffer = Buffer.from(text, "utf8")
  let end = Math.max(0, Math.min(maxBytes, buffer.length))
  // Back up to a sequence boundary: continuation bytes start with 10xxxxxx.
  while (end > 0 && (buffer[end] & 0b11000000) === 0b10000000) end -= 1
  return buffer.subarray(0, end).toString("utf8")
}

/**
 * Build a Struct-safe value from a tool result / args string. `google.protobuf.Struct`
 * only accepts an object at the top level, so non-objects are wrapped under
 * `result`. Whatever the input shape (malformed JSON, scalar, array, nested
 * object, multibyte text, or huge output), the returned object's UTF-8 JSON
 * serialization never exceeds `maxBytes`. Oversized payloads become
 * `{ result: <byte-safe prefix>, truncated: true }`, accounting for the
 * wrapper's own JSON overhead (including quote escaping) so the final bytes
 * still fit under the cap.
 */
export function functionStructValue(content: string, maxBytes = MAX_FUNCTION_STRUCT_BYTES): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return boundedStruct(content, maxBytes)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const candidate = { result: parsed }
    if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) return candidate
    return truncatedStruct(content, maxBytes)
  }
  if (utf8Bytes(JSON.stringify(parsed)) <= maxBytes) return parsed as Record<string, unknown>
  return truncatedStruct(content, maxBytes)
}

function boundedStruct(value: unknown, maxBytes: number): Record<string, unknown> {
  const candidate = { result: value }
  if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) return candidate
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  return truncatedStruct(raw, maxBytes)
}

/**
 * `{ result: <byte-safe prefix>, truncated: true }`. Escaping in JSON.stringify
 * can inflate the raw bytes, so after the first trim the wrapper is re-measured
 * and trimmed again by the overflow; escaping is monotonic, so one correction
 * pass is enough.
 */
function truncatedStruct(content: string, maxBytes: number): Record<string, unknown> {
  let candidate: Record<string, unknown> = { result: content, truncated: true }
  for (let pass = 0; pass < 2; pass += 1) {
    const bytes = utf8Bytes(JSON.stringify(candidate))
    if (bytes <= maxBytes) return candidate
    const rawBytes = utf8Bytes(String(candidate.result))
    const overflow = bytes - maxBytes
    candidate = {
      result: byteSafeTruncate(String(candidate.result), Math.max(0, rawBytes - overflow)),
      truncated: true,
    }
  }
  return candidate
}

export function sanitizeGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((entry) => sanitizeGeminiSchema(entry))
  if (!node || typeof node !== "object") return node
  const source = node as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!SUPPORTED_GEMINI_SCHEMA_KEYS.has(key)) continue
    if (key === "additionalProperties" && typeof value !== "boolean") continue
    if (key === "properties") {
      // `properties` is a name -> schema map; recurse into each value, not the map.
      const props: Record<string, unknown> = {}
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [name, schema] of Object.entries(value as Record<string, unknown>)) {
          props[name] = sanitizeGeminiSchema(schema)
        }
      }
      result[key] = props
    } else if (key === "anyOf" || key === "oneOf" || key === "allOf" || key === "not") {
      result[key] = sanitizeSchemaArray(value)
    } else if (key === "items") {
      result[key] = sanitizeGeminiSchema(value)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Registry that maps an OpenAI tool-call id to Google's `thoughtSignature`
 * (and the function name). Bounded; used across requests because OpenCode
 * resends the full history each turn. Optionally backed by a durable persister
 * so the contract survives a server restart; entries carry the conversation
 * session id when known and are only served to their own conversation.
 */
export class ToolCallRegistry {
  private readonly map = new Map<string, PersistedToolCallEntry>()
  private readonly order: string[] = []
  private initPromise: Promise<void> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private persistQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly maxSize = 2000,
    private readonly ttlMs = 0,
    private readonly persister?: ToolCallRegistryPersister,
  ) {}

  private key(id: string, sessionId?: string): string {
    return `${sessionId ?? ""}\u0000${id}`
  }

  /** Load durable entries once; corruption fails safe to an empty registry. */
  ensureInitialized(): Promise<void> {
    if (this.initPromise) return this.initPromise
    const persister = this.persister
    if (!persister) {
      this.initPromise = Promise.resolve()
      return this.initPromise
    }
    this.initPromise = (async () => {
      try {
        const entries = await persister.load()
        for (const entry of entries) {
          if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) continue
          if (this.map.size >= this.maxSize) break
          const key = this.key(entry.id, entry.sessionId)
          if (this.map.has(key)) continue
          this.map.set(key, entry)
          this.order.push(key)
        }
      } catch {
        // Unreadable persistence must never block the shim; fresh records are
        // written on the next save.
      }
    })()
    return this.initPromise
  }

  record(id: string, name: string, thoughtSignature?: string, sessionId?: string): void {
    const now = Date.now()
    const key = this.key(id, sessionId)
    if (this.map.has(key)) {
      const entry = this.map.get(key)
      if (entry) {
        if (thoughtSignature && !entry.thoughtSignature) entry.thoughtSignature = thoughtSignature
        entry.createdAt = now
      }
    } else {
      if (this.map.size >= this.maxSize && this.order.length > 0) {
        const oldest = this.order.shift()
        if (oldest) this.map.delete(oldest)
      }
      this.map.set(key, {
        id,
        name,
        ...(thoughtSignature ? { thoughtSignature } : {}),
        ...(sessionId ? { sessionId } : {}),
        createdAt: now,
      })
      this.order.push(key)
    }
    this.schedulePersist()
  }

  lookup(id: string, sessionId?: string): PersistedToolCallEntry | undefined {
    const key = this.key(id, sessionId)
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key)
      const orderIndex = this.order.indexOf(key)
      if (orderIndex >= 0) this.order.splice(orderIndex, 1)
      return undefined
    }
    return entry
  }

  clear(): void {
    this.map.clear()
    this.order.length = 0
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.persister) void this.persist([]).catch(() => undefined)
  }

  /** Await any pending debounced persist (test determinism and shutdown). */
  async flush(): Promise<void> {
    const persister = this.persister
    if (!persister) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const snapshot = this.order
      .map((key) => this.map.get(key))
      .filter((entry): entry is PersistedToolCallEntry => Boolean(entry))
    await this.persist(snapshot)
  }

  /** Debounced trailing persist so a burst of records coalesces into one write. */
  private schedulePersist(): void {
    const persister = this.persister
    if (!persister) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const snapshot = this.order
        .map((key) => this.map.get(key))
        .filter((entry): entry is PersistedToolCallEntry => Boolean(entry))
      void this.persist(snapshot).catch(() => undefined)
    }, 250)
  }

  private persist(snapshot: PersistedToolCallEntry[]): Promise<void> {
    const persister = this.persister
    if (!persister) return Promise.resolve()
    const pending = this.persistQueue.catch(() => undefined).then(() => persister.save(snapshot))
    this.persistQueue = pending
    return pending
  }
}

/** A role:"tool" history part whose call cannot be resolved is never dropped silently. */
export class FreebuffToolTranslationError extends Error {
  readonly toolCallId: string

  constructor(toolCallId: string) {
    super(
      `Cannot translate role:"tool" for unknown tool_call_id "${toolCallId}": no matching assistant tool_call in this or earlier requests`,
    )
    this.name = "FreebuffToolTranslationError"
    this.toolCallId = toolCallId
  }
}

/**
 * Translate an OpenAI chat request into the cloudcode-pa generate args.
 * Assistant tool calls and their results are reassembled into model/user turns
 * and re-attach any known thought signatures so the backend accepts them.
 * Incoming assistant tool calls are re-anchored in the registry so the tool
 * results that follow resolve even on a fresh registry after a restart; an
 * unresolvable tool result is a hard translation error, never a silent drop.
 */
export function translateOpenAiRequest(
  request: OpenAiChatRequest,
  registry: ToolCallRegistry,
  sessionId?: string,
): CloudCodeGenerateArgs {
  const contents: Array<Record<string, unknown>> = []
  let systemInstruction: { parts: Array<{ text: string }> } | undefined
  // Calls seen in THIS request: a tool result can follow its assistant call in
  // the same request even when the registry was reset between them.
  const seenCalls = new Map<string, { name: string; thoughtSignature?: string }>()

  const systemTexts: string[] = []
  for (const message of request.messages) {
    if (message.role === "system") {
      const text = textOf(message.content)
      if (text) systemTexts.push(text)
      continue
    }
    if (message.role === "user") {
      const text = textOf(message.content)
      const images = inlineDataParts(message.content)
      const parts: Array<Record<string, unknown>> = []
      if (text) parts.push({ text })
      if (images.length > 0) parts.push(...images)
      if (parts.length > 0) contents.push({ role: "user", parts })
      continue
    }
    if (message.role === "tool") {
      const entry = seenCalls.get(message.tool_call_id) ?? registry.lookup(message.tool_call_id, sessionId)
      if (!entry) {
        throw new FreebuffToolTranslationError(message.tool_call_id)
      }
      // Re-anchor so a later replay (or a same-request reconstruction) resolves.
      registry.record(message.tool_call_id, entry.name, entry.thoughtSignature, sessionId)
      // The backend requires every function response to reference the call it
      // answers (`tool_use_id` in its Anthropic-style validation). The OpenAI
      // tool_call_id IS that id -- it is the same value echoed on the
      // assistant `functionCall` part above -- so it is passed through rather
      // than invented.
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: entry.name,
            id: message.tool_call_id,
            response: functionStructValue(message.content),
          },
        }],
      })
      continue
    }
    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = []
      const text = message.content ? textOf(message.content) : ""
      if (text) parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        const known = seenCalls.get(call.id) ?? registry.lookup(call.id, sessionId)
        const entry = { name: call.function.name, thoughtSignature: known?.thoughtSignature }
        // A fresh registry (server restart, new process) must learn this call
        // so the following role:"tool" and later replays can resolve it.
        registry.record(call.id, entry.name, entry.thoughtSignature, sessionId)
        seenCalls.set(call.id, entry)
        const functionCall: Record<string, unknown> = {
          name: call.function.name,
          args: functionStructValue(call.function.arguments),
          id: call.id,
        }
        parts.push(entry.thoughtSignature
          ? { thoughtSignature: entry.thoughtSignature, functionCall }
          : { functionCall })
      }
      if (parts.length > 0) contents.push({ role: "model", parts })
    }
  }

  if (systemTexts.length > 0) {
    systemInstruction = { parts: systemTexts.map((text) => ({ text })) }
  }

  const generationConfig: Record<string, unknown> = {}
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature
  if (request.max_tokens !== undefined) generationConfig.maxOutputTokens = request.max_tokens
  if (request.top_p !== undefined) generationConfig.topP = request.top_p

  return {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(openAiToolsToCloudCode(request.tools) ? { tools: openAiToolsToCloudCode(request.tools) } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  }
}

export interface OpenAiChunk {
  content?: string
  toolCalls?: Array<{ index: number; id: string; name: string; arguments: string }>
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter" | null
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

/** Read one upstream `data:` frame and emit OpenAI stream deltas. */
export function translateCloudCodeFrame(
  frame: Record<string, unknown>,
  registry: ToolCallRegistry,
  sessionId?: string,
): OpenAiChunk[] {
  const response = frame.response
  if (!response || typeof response !== "object") return []
  const candidates = (response as Record<string, unknown>).candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const candidate = candidates[0] as Record<string, unknown>
  const content = candidate.content as Record<string, unknown> | undefined
  const parts = Array.isArray(content?.parts) ? (content.parts as Array<Record<string, unknown>>) : []

  const chunks: OpenAiChunk[] = []
  const toolCalls: OpenAiChunk["toolCalls"] = []
  for (const part of parts) {
    if (typeof part.text === "string" && part.text) {
      chunks.push({ content: part.text })
    }
    const call = part.functionCall as Record<string, unknown> | undefined
    if (call && typeof call === "object" && call.name) {
      const id = typeof call.id === "string" ? call.id : `call_${Date.now()}_${toolCalls.length}`
      const name = String(call.name)
      const argumentsJson =
        typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {})
      registry.record(id, name, typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined, sessionId)
      toolCalls.push({ index: toolCalls.length, id, name, arguments: argumentsJson })
    }
  }
  if (toolCalls.length > 0) chunks.push({ toolCalls })

  const usageMetadata = (response as Record<string, unknown>).usageMetadata as
    | Record<string, unknown>
    | undefined
  if (usageMetadata) {
    const prompt = usageMetadata.promptTokenCount
    const completion = usageMetadata.candidatesTokenCount
    if (typeof prompt === "number" || typeof completion === "number") {
      chunks.push({
        usage: {
          promptTokens: typeof prompt === "number" ? prompt : 0,
          completionTokens: typeof completion === "number" ? completion : 0,
          totalTokens: typeof usageMetadata.totalTokenCount === "number" ? usageMetadata.totalTokenCount : 0,
        },
      })
    }
  }

  return chunks
}
