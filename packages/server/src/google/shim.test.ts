import assert from "node:assert/strict"
import Fastify from "fastify"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  FreebuffToolTranslationError,
  functionStructValue,
  normalizeAntigravityModel,
  openAiToolsToCloudCode,
  ToolCallRegistry,
  translateCloudCodeFrame,
  translateOpenAiRequest,
  type OpenAiChatRequest,
} from "./shim"
import { createFileToolCallRegistryPersister } from "./tool-call-persistence"
import { ANTIGRAVITY_SHIM_API_KEY } from "./adapter"
import { registerGoogleShimRoutes } from "../server/routes/google-shim"

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

  it("keeps the Struct serializer under the byte cap for every input shape", () => {
    const shapes: string[] = [
      "not json at all",
      '"a plain string"',
      "74915",
      "true",
      "false",
      "null",
      '["a","b",1,true,null]',
      '{"ok":true,"nested":{"deep":[1,2,3]}}',
      JSON.stringify({ deep: { deeper: { deepest: { value: "x".repeat(2000) } } } }),
      JSON.stringify({ text: "Привет мир" }),
      JSON.stringify({ text: "Tere, maailm! Õäöüšž" }),
      JSON.stringify({ text: "こんにちは世界" }),
      JSON.stringify({ text: "emoji 🚀🧭🛠️" }),
      JSON.stringify({ output: "x".repeat(50_000) }),
      JSON.stringify(["y".repeat(30_000)]),
    ]
    for (const shape of shapes) {
      const bytes = Buffer.byteLength(JSON.stringify(functionStructValue(shape, 5_000)), "utf8")
      assert.ok(bytes <= 5_000, `shape over cap: ${bytes} bytes for ${shape.slice(0, 40)}`)
    }
  })

  it("never emits broken surrogate endings when truncating multibyte text", () => {
    const result = functionStructValue(JSON.stringify({ text: "🚀".repeat(10_000) }), 1_000)
    assert.equal(result.truncated, true)
    const preview = String(result.result)
    const serialized = JSON.stringify(result)
    assert.doesNotThrow(() => Buffer.from(serialized, "utf8").toString("utf8"))
    // No lone high surrogate can survive the byte cut.
    assert.ok(!/[\uD800-\uDBFF]$/.test(preview))
    // And re-encoding the wrapper round-trips cleanly.
    assert.equal(JSON.parse(serialized).truncated, true)
  })

  it("re-anchors incoming assistant tool calls so a fresh registry resolves the tool result", () => {
    const registry = new ToolCallRegistry()
    const request: OpenAiChatRequest = {
      model: "gemini-3.6-flash-medium",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_replayed", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_replayed", content: "file contents" },
      ],
    }
    // A fresh registry has never seen this call; the assistant block must
    // record it so the following role:"tool" resolves instead of being dropped.
    const args = translateOpenAiRequest(request, registry)
    const functionResponse = (args.contents[1] as { parts: Array<Record<string, unknown>> }).parts[0]
      .functionResponse as Record<string, unknown>
    assert.equal(functionResponse.name, "read_file")
    assert.equal(functionResponse.id, "call_replayed")
    assert.deepEqual(functionResponse.response, { result: "file contents" })
  })

  it("throws a typed error instead of silently dropping an unknown tool result", () => {
    const registry = new ToolCallRegistry()
    const request: OpenAiChatRequest = {
      model: "gemini-3.6-flash-medium",
      messages: [{ role: "tool", tool_call_id: "call_never_seen", content: "orphan result" }],
    }
    assert.throws(
      () => translateOpenAiRequest(request, registry),
      (error) => error instanceof FreebuffToolTranslationError && error.toolCallId === "call_never_seen",
    )
  })

  it("survives a server restart via the persisted registry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saiwork-toolcall-"))
    try {
      const filePath = join(directory, "tool-call-registry.json")
      const persister = createFileToolCallRegistryPersister(filePath)

      // Turn one: record the call+signature, flush to disk.
      const first = new ToolCallRegistry(2000, 0, persister)
      first.record("call_persisted", "bash", "signature-123", "sess-9")
      await first.flush()

      // Restart: a brand-new registry loads the durable entry.
      const second = new ToolCallRegistry(2000, 0, persister)
      await second.ensureInitialized()
      assert.deepEqual(second.lookup("call_persisted", "sess-9"), {
        id: "call_persisted",
        name: "bash",
        thoughtSignature: "signature-123",
        sessionId: "sess-9",
        createdAt: first.lookup("call_persisted", "sess-9")!.createdAt,
      })

      // A replayed tool result now resolves through the loaded entry.
      const request: OpenAiChatRequest = {
        model: "gemini-3.6-flash-medium",
        messages: [{ role: "tool", tool_call_id: "call_persisted", content: "result" }],
      }
      const args = translateOpenAiRequest(request, second, "sess-9")
      const functionResponse = (args.contents[0] as { parts: Array<Record<string, unknown>> }).parts[0]
        .functionResponse as Record<string, unknown>
      assert.equal(functionResponse.name, "bash")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("flush waits for an older debounced save before writing the latest registry", async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let saves = 0
    let stored: string[] = []
    const registry = new ToolCallRegistry(2000, 0, {
      load: async () => [],
      save: async (entries) => {
        saves += 1
        if (saves === 1) await firstGate
        stored = entries.map((entry) => entry.id)
      },
    })
    registry.record("old", "bash")
    await new Promise((resolve) => setTimeout(resolve, 300))
    registry.record("new", "read_file")
    const flush = registry.flush()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(saves, 1)
    releaseFirst()
    await flush
    assert.deepEqual(stored, ["old", "new"])
  })

  it("session-scoped registry entries never resolve in another conversation", () => {
    const registry = new ToolCallRegistry()
    registry.record("call_a", "read_file", "sig-a", "sess-1")
    assert.ok(registry.lookup("call_a", "sess-1"))
    assert.equal(registry.lookup("call_a", "sess-2"), undefined)
    assert.equal(registry.lookup("call_a"), undefined)
    // Entries without a session remain in their own namespace.
    registry.record("call_b", "bash", "sig-b")
    assert.ok(registry.lookup("call_b"))
    assert.equal(registry.lookup("call_b", "sess-3"), undefined)
  })

  it("keeps identical tool call ids isolated across conversations", () => {
    const registry = new ToolCallRegistry()
    registry.record("call_same", "read_file", "sig-1", "sess-1")
    registry.record("call_same", "bash", "sig-2", "sess-2")
    assert.equal(registry.lookup("call_same", "sess-1")?.name, "read_file")
    assert.equal(registry.lookup("call_same", "sess-2")?.name, "bash")
  })

  it("can record an id again after its TTL expires", async () => {
    const registry = new ToolCallRegistry(1, 1)
    registry.record("call_a", "old")
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(registry.lookup("call_a"), undefined)
    registry.record("call_a", "new")
    assert.equal(registry.lookup("call_a")?.name, "new")
  })

  it("requires a nonblank route session identity", async () => {
    for (const sessionId of [undefined, "   "]) {
      const app = Fastify({ logger: false })
      registerGoogleShimRoutes(app, { registry: new ToolCallRegistry() })
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${ANTIGRAVITY_SHIM_API_KEY}`,
          ...(sessionId === undefined ? {} : { "x-session-id": sessionId }),
        },
        payload: { model: "gemini-3.6-flash-medium", messages: [{ role: "user", content: "hello" }] },
      })
      await app.close()
      assert.equal(response.statusCode, 400)
      assert.match(response.json().error.message, /x-session-id/)
    }
  })

  it("keeps identical streamed and non-streamed tool ids isolated by route session", async () => {
    const registry = new ToolCallRegistry()
    let call = 0
    const session = {
      async *streamGenerate() {
        const name = call++ === 0 ? "read_file" : "bash"
        yield {
          response: {
            candidates: [{
              content: {
                role: "model",
                parts: [{ thoughtSignature: `sig-${name}`, functionCall: { name, args: {}, id: "call_same" } }],
              },
            }],
          },
        }
      },
    }
    const app = Fastify({ logger: false })
    registerGoogleShimRoutes(app, { registry, session: session as never })
    const base = { model: "gemini-3.6-flash-medium", messages: [{ role: "user", content: "run" }] }
    const streamed = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${ANTIGRAVITY_SHIM_API_KEY}`, "x-session-id": "session-a" },
      payload: { ...base, stream: true },
    })
    const plain = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${ANTIGRAVITY_SHIM_API_KEY}`, "x-session-id": "session-b" },
      payload: base,
    })
    await app.close()

    assert.equal(streamed.statusCode, 200)
    assert.equal(plain.statusCode, 200)
    assert.equal(registry.lookup("call_same", "session-a")?.name, "read_file")
    assert.equal(registry.lookup("call_same", "session-b")?.name, "bash")
  })

  it("returns a client error for an orphan tool result", async () => {
    const app = Fastify({ logger: false })
    registerGoogleShimRoutes(app, { registry: new ToolCallRegistry() })
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${ANTIGRAVITY_SHIM_API_KEY}`,
        "x-session-id": "sess-route",
      },
      payload: {
        model: "gemini-3.6-flash-medium",
        messages: [{ role: "tool", tool_call_id: "call_missing", content: "orphan" }],
      },
    })
    await app.close()

    assert.equal(response.statusCode, 400)
    assert.match(response.json().error.message, /unknown tool_call_id/)
  })
})
