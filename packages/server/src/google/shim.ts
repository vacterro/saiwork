/**
 * Pure translation between the OpenAI chat/completions shape that the OpenCode
 * AI SDK talks and the Antigravity cloudcode-pa request/response shape.
 *
 * Everything here is deterministic and side-effect free except the
 * ToolCallRegistry, which remembers Google's `thoughtSignature` for a tool call
 * so a stateless client replaying history can still satisfy the backend's
 * "functionCall parts must carry a thought_signature" requirement.
 */

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
const MAX_FUNCTION_STRUCT_BYTES = 20_000

/**
 * Build a Struct-safe value from a tool result / args string. `google.protobuf.Struct`
 * only accepts an object at the top level, but tool output is frequently a bare
 * scalar (a number like `74915`, a string, an array) or large. Non-objects are
 * wrapped under `result`; oversized payloads are truncated to their head with a
 * `truncated` flag so the model still sees the beginning of the output.
 */
export function functionStructValue(content: string, maxBytes = MAX_FUNCTION_STRUCT_BYTES): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { result: content }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { result: parsed }
  }
  const serialized = JSON.stringify(parsed)
  if (serialized.length > maxBytes) {
    return { result: content.slice(0, maxBytes), truncated: true }
  }
  return parsed as Record<string, unknown>
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
 * resends the full history each turn.
 */
export class ToolCallRegistry {
  private readonly map = new Map<string, { name: string; thoughtSignature?: string }>()
  private readonly order: string[] = []

  constructor(private readonly maxSize = 2000) {}

  record(id: string, name: string, thoughtSignature?: string): void {
    if (this.order.includes(id)) {
      const entry = this.map.get(id)
      if (entry) entry.thoughtSignature = thoughtSignature ?? entry.thoughtSignature
      return
    }
    if (this.map.size >= this.maxSize && this.order.length > 0) {
      const oldest = this.order.shift()
      if (oldest) this.map.delete(oldest)
    }
    this.map.set(id, { name, ...(thoughtSignature ? { thoughtSignature } : {}) })
    this.order.push(id)
  }

  lookup(id: string): { name: string; thoughtSignature?: string } | undefined {
    return this.map.get(id)
  }

  clear(): void {
    this.map.clear()
    this.order.length = 0
  }
}

/**
 * Translate an OpenAI chat request into the cloudcode-pa generate args.
 * Assistant tool calls and their results are reassembled into model/user turns
 * and re-attach any known thought signatures so the backend accepts them.
 */
export function translateOpenAiRequest(
  request: OpenAiChatRequest,
  registry: ToolCallRegistry,
): CloudCodeGenerateArgs {
  const contents: Array<Record<string, unknown>> = []
  let systemInstruction: { parts: Array<{ text: string }> } | undefined

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
      const call = registry.lookup(message.tool_call_id)
      if (!call) continue
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: call.name, response: functionStructValue(message.content) } }],
      })
      continue
    }
    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = []
      const text = message.content ? textOf(message.content) : ""
      if (text) parts.push({ text })
      for (const call of message.tool_calls ?? []) {
        const known = registry.lookup(call.id)
        const functionCall: Record<string, unknown> = {
          name: call.function.name,
          args: functionStructValue(call.function.arguments),
          id: call.id,
        }
        if (known?.thoughtSignature) {
          parts.push({ thoughtSignature: known.thoughtSignature, functionCall })
        } else {
          parts.push({ functionCall })
        }
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
      registry.record(id, name, typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined)
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

/** True when a frame signals the model stopped (used for finish_reason). */
export function frameHasFinishReason(frame: Record<string, unknown>): boolean {
  const response = frame.response
  if (!response || typeof response !== "object") return false
  const candidates = (response as Record<string, unknown>).candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return false
  const candidate = candidates[0] as Record<string, unknown>
  const content = candidate.content as Record<string, unknown> | undefined
  const parts = Array.isArray(content?.parts) ? (content.parts as Array<Record<string, unknown>>) : []
  if (parts.some((part) => part.functionCall)) return true
  return Boolean(candidate.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED")
}
