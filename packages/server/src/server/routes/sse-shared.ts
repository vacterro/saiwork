/**
 * Shared OpenAI-SSE framing for the two local gateways (Antigravity + FreeBuff).
 * Both used to hand-roll the same chunk serialization; a single helper keeps
 * the wire format identical and prevents drift between the providers.
 */

export interface OpenAiSseToolCallDelta {
  index: number
  id: string
  name: string
  arguments: string
}

export function openAiSseChunk(params: {
  id: string
  created: number
  model: string
  delta?: { content?: string; toolCalls?: OpenAiSseToolCallDelta[] }
  finishReason?: string | null
}): Record<string, unknown> {
  const delta: Record<string, unknown> = {}
  if (params.delta?.content !== undefined) delta.content = params.delta.content
  if (params.delta?.toolCalls) {
    delta.tool_calls = params.delta.toolCalls.map((call) => ({
      index: call.index,
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [{ index: 0, delta, finish_reason: params.finishReason ?? null }],
  }
}

/** Serialize one SSE data frame. */
export function sseEncode(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}
