import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  functionStructValue,
  normalizeAntigravityModel,
  openAiToolsToCloudCode,
  ToolCallRegistry,
  translateCloudCodeFrame,
  translateOpenAiRequest,
  type OpenAiChatRequest,
} from "./shim"

describe("antigravity shim translation", () => {
  it("normalizes scoped model ids", () => {
    assert.equal(normalizeAntigravityModel("google_antigravity/gemini-pro-agent"), "gemini-pro-agent")
    assert.equal(normalizeAntigravityModel("gemini-pro-agent"), "gemini-pro-agent")
  })

  it("maps tools to function declarations", () => {
    const tools = openAiToolsToCloudCode([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ])
    assert.deepEqual(tools, [
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
      },
    ])
    assert.equal(openAiToolsToCloudCode(undefined), undefined)
  })

  it("strips JSON-Schema-2020 keywords the backend rejects from tool schemas", () => {
    const tools = openAiToolsToCloudCode([
      {
        type: "function",
        function: {
          name: "bash",
          description: "Run a command",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: true,
            properties: {
              command: { type: "string", minLength: 1 },
              timeout: { type: "integer", exclusiveMinimum: 0, maximum: 60_000 },
            },
            required: ["command"],
            if: { type: "object" },
            $defs: { X: { type: "string" } },
          },
        },
      },
    ])
    assert.deepEqual(tools, [
      {
        functionDeclarations: [
          {
            name: "bash",
            description: "Run a command",
            parameters: {
              type: "object",
              additionalProperties: true,
              properties: {
                command: { type: "string", minLength: 1 },
                timeout: { type: "integer", maximum: 60_000 },
              },
              required: ["command"],
            },
          },
        ],
      },
    ])
  })

  it("sanitizes nested and array schema positions", () => {
    const sanitized = openAiToolsToCloudCode([
      {
        type: "function",
        function: {
          name: "search",
          parameters: {
            type: "object",
            properties: {
              terms: { type: "array", items: { type: "string", const: "x" } },
              options: { anyOf: [{ type: "string", $schema: "x" }, { type: "integer", exclusiveMinimum: 0 }] },
              extra: { $ref: "#/$defs/X" },
            },
          },
        },
      },
    ])
    const declarations = sanitized![0].functionDeclarations as Array<Record<string, unknown>>
    assert.deepEqual(declarations[0].parameters, {
      type: "object",
      properties: {
        terms: { type: "array", items: { type: "string" } },
        options: { anyOf: [{ type: "string" }, { type: "integer" }] },
        extra: {},
      },
    })
  })

  it("builds a generate request from chat messages", () => {
    const request: OpenAiChatRequest = {
      model: "gemini-pro-agent",
      messages: [
        { role: "system", content: "You are concise." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.2,
      max_tokens: 100,
    }
    const args = translateOpenAiRequest(request, new ToolCallRegistry())
    assert.deepEqual(args.systemInstruction, { parts: [{ text: "You are concise." }] })
    assert.deepEqual(args.contents, [{ role: "user", parts: [{ text: "Hello" }] }])
    assert.deepEqual(args.generationConfig, { temperature: 0.2, maxOutputTokens: 100 })
  })

  it("reassembles tool calls and results with thought signatures", () => {
    const registry = new ToolCallRegistry()
    registry.record("call_1", "calc", "SIG123")

    const request: OpenAiChatRequest = {
      model: "gemini-3.6-flash-medium",
      messages: [
        { role: "user", content: "2+2?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "calc", arguments: '{"a":2,"b":2}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"result":4}' },
      ],
      tools: [
        {
          type: "function",
          function: { name: "calc", description: "add", parameters: { type: "object" } },
        },
      ],
    }
    const args = translateOpenAiRequest(request, registry)
    assert.deepEqual(args.contents, [
      { role: "user", parts: [{ text: "2+2?" }] },
      {
        role: "model",
        parts: [{ thoughtSignature: "SIG123", functionCall: { name: "calc", args: { a: 2, b: 2 }, id: "call_1" } }],
      },
      { role: "user", parts: [{ functionResponse: { name: "calc", id: "call_1", response: { result: 4 } } }] },
    ])
    assert.ok(args.tools)
  })

  it("echoes the tool call id on every function response (backend requires tool_use_id)", () => {
    const registry = new ToolCallRegistry()
    registry.record("call_9", "bash", "SIG9")
    const request: OpenAiChatRequest = {
      model: "gemini-3.6-flash-medium",
      messages: [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_9", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }],
        },
        { role: "tool", tool_call_id: "call_9", content: "hi" },
      ],
    }
    const args = translateOpenAiRequest(request, registry)
    const second = args.contents[2] as Record<string, unknown> | undefined
    const parts = second?.parts as Array<Record<string, unknown>> | undefined
    const responsePart = parts?.[0]?.functionResponse as Record<string, unknown> | undefined
    assert.equal(responsePart?.id, "call_9", "functionResponse must carry the call id the backend validates as tool_use_id")
  })

  it("emits tool calls and records signatures from cloudcode frames", () => {
    const registry = new ToolCallRegistry()
    const frame = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { thoughtSignature: "SIGABC", functionCall: { name: "calc", args: { a: 1, b: 2 }, id: "call_9" } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      },
    }
    const chunks = translateCloudCodeFrame(frame, registry)
    const toolChunk = chunks.find((chunk) => chunk.toolCalls)
    assert.ok(toolChunk)
    assert.deepEqual(toolChunk!.toolCalls, [
      { index: 0, id: "call_9", name: "calc", arguments: '{"a":1,"b":2}' },
    ])
    assert.equal(registry.lookup("call_9")?.thoughtSignature, "SIGABC")
    assert.equal(registry.lookup("call_9")?.name, "calc")
    assert.deepEqual(chunks[1], { usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } })
  })

  it("emits text deltas and skips signature-only parts", () => {
    const registry = new ToolCallRegistry()
    const frame = {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ thoughtSignature: "T" }, { text: "Hello" }, { text: " world" }],
            },
          },
        ],
      },
    }
    const chunks = translateCloudCodeFrame(frame, registry)
    assert.deepEqual(chunks.map((chunk) => chunk.content).filter(Boolean), ["Hello", " world"])
  })

  it("drops unknown frames", () => {
    assert.deepEqual(translateCloudCodeFrame({ error: { message: "boom" } }, new ToolCallRegistry()), [])
    assert.deepEqual(translateCloudCodeFrame({}, new ToolCallRegistry()), [])
  })

  it("wraps scalar and array tool results as Struct-safe objects", () => {
    assert.deepEqual(functionStructValue("74915"), { result: 74915 })
    assert.deepEqual(functionStructValue('["a","b"]'), { result: ["a", "b"] })
    assert.deepEqual(functionStructValue("null"), { result: null })
    assert.deepEqual(functionStructValue("plain text"), { result: "plain text" })
    assert.deepEqual(functionStructValue('{"ok":true}'), { ok: true })
  })

  it("truncates oversized tool results instead of failing the turn", () => {
    const big = '{"output":"' + "x".repeat(30_000) + '"}'
    const result = functionStructValue(big, 5_000)
    assert.equal(result.truncated, true)
    const preview = String(result.result)
    assert.ok(preview.length <= 5_000)
    assert.ok(preview.startsWith('{"output":"xxx'))
  })

  it("applies Struct-safe wrapping to tool responses and call args in history", () => {
    const registry = new ToolCallRegistry()
    registry.record("call_1", "read_file", "SIG")
    const request: OpenAiChatRequest = {
      model: "gemini-3.6-flash-medium",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "74915" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "74915" },
      ],
    }
    const args = translateOpenAiRequest(request, registry)
    const modelTurn = args.contents[0] as { parts: Array<Record<string, unknown>> }
    const functionCall = modelTurn.parts[0].functionCall as Record<string, unknown>
    assert.deepEqual(functionCall.args, { result: 74915 })
    const userTurn = args.contents[1] as { parts: Array<Record<string, unknown>> }
    const functionResponse = userTurn.parts[0].functionResponse as Record<string, unknown>
    assert.deepEqual(functionResponse.response, { result: 74915 })
  })
})
