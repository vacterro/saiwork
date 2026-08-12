import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"

import {
  AntigravitySession,
  extractTokensFromStateValue,
  readStateDbValue,
  refreshAccessToken,
} from "./antigravity-session"

describe("antigravity session", () => {
  it("extracts oauth tokens from the base64 state blob", () => {
    const blob = Buffer.from(
      `session{refresh_token:"1//REFRESHabc123" access:"ya29.ACCESSxyz789" email:"x@y.z"}`,
    ).toString("base64")
    const tokens = extractTokensFromStateValue(blob)
    assert.equal(tokens.refreshToken, "1//REFRESHabc123")
    assert.equal(tokens.accessToken, "ya29.ACCESSxyz789")
  })

  it("returns no tokens for garbage state", () => {
    assert.deepEqual(extractTokensFromStateValue("not-base64!!"), {})
  })

  it("reads a value from the sqlite state db", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saiwork-state-test-"))
    const dbPath = path.join(dir, "state.vscdb")
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE ItemTable (key TEXT, value BLOB)")
    db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("jetskiStateSync.agentManagerInitState", "hello-world")
    db.close()

    assert.equal(readStateDbValue(dbPath, "jetskiStateSync.agentManagerInitState"), "hello-world")
    assert.equal(readStateDbValue(dbPath, "missing"), null)
    assert.equal(readStateDbValue(path.join(dir, "absent.vscdb"), "x"), null)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("refreshes once and caches the access token across calls", async () => {
    const refreshed: string[] = []
    const session = new AntigravitySession({
      readTokens: () => ({ refreshToken: "1//REFRESH" }),
      refresh: async (token) => {
        refreshed.push(token)
        return { accessToken: "ya29.fresh", expiresAt: Date.now() + 3600 * 1000 }
      },
    })
    const originalFetch = globalThis.fetch
    let calls = 0
    const sseBody = 'data: {"response":{"candidates":[]}}\n\n'
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(sseBody, { status: 200 })
    }) as typeof fetch
    const contents = [{ role: "user", parts: [{ text: "hi" }] }]
    try {
      for (let i = 0; i < 2; i += 1) {
        for await (const _frame of session.streamGenerate("gemini-3.6-flash-medium", { contents })) {
          // drain
        }
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(refreshed.length, 1)
    assert.equal(calls, 2)
  })

  it("streams and parses upstream sse frames", async () => {
    const sseBody =
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]}}]}}\n\n' +
      'data: [DONE]\n\n'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(sseBody, { status: 200 })
    }) as typeof fetch
    const session = new AntigravitySession({
      readTokens: () => ({ accessToken: "ya29.stored" }),
    })
    try {
      const frames: Array<Record<string, unknown>> = []
      for await (const frame of session.streamGenerate("gemini-3.6-flash-medium", {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      })) {
        frames.push(frame)
      }
      assert.equal(frames.length, 1)
      const response = frames[0].response as Record<string, unknown>
      const candidates = response.candidates as Array<{
        content: { role: string; parts: Array<{ text?: string }> }
      }>
      assert.equal(candidates[0].content.role, "model")
      assert.equal(candidates[0].content.parts[0].text, "OK")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("parses CRLF-delimited sse frames so the answer is not truncated to its first chunk", async () => {
    // Google's gRPC-transcoded SSE uses CRLF separators. The splitter looks
    // for "\n\n", so without line-ending normalization only the first data:
    // line of the whole stream survives (a text answer collapses to one word).
    const sseBody =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Картинки"}]}}]}}\r\n\r\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":" \u2014 это изображения"}]}}]}}\r\n\r\n' +
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":""}}],"finishReason":"STOP"}]}}\r\n\r\n'
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(sseBody, { status: 200 })
    }) as typeof fetch
    const session = new AntigravitySession({
      readTokens: () => ({ accessToken: "ya29.stored" }),
    })
    try {
      const frames: Array<Record<string, unknown>> = []
      for await (const frame of session.streamGenerate("gemini-3.6-flash-medium", {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      })) {
        frames.push(frame)
      }
      const texts: string[] = []
      for (const frame of frames) {
        const candidates = (frame.response as { candidates?: unknown })?.candidates as
          | Array<{ content?: { parts?: Array<{ text?: string }> } }>
          | undefined
        for (const part of candidates?.[0]?.content?.parts ?? []) {
          if (part.text) texts.push(part.text)
        }
      }
      assert.equal(texts.length, 2)
      assert.equal(texts.join(""), "Картинки — это изображения")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("propagates backend errors with the server message", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: { message: "No capacity available for model X" } }),
        { status: 503, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch
    const session = new AntigravitySession({
      readTokens: () => ({ accessToken: "ya29.stored" }),
    })
    try {
      await assert.rejects(
        session.listModels(),
        /No capacity available for model X/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
