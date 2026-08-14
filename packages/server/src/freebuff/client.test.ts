import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createFreebuffClient, type FetchLike } from "./client"

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function recordingFetch(log: Array<{ url: string; init?: RequestInit }>): FetchLike {
  return async (url, init) => {
    log.push({ url: String(url), init })
    return fakeResponse(200, {})
  }
}

describe("createFreebuffClient", () => {
  it("posts thread creation against /api/threads", async () => {
    const log: Array<{ url: string; init?: RequestInit }> = []
    const client = createFreebuffClient({ baseUrl: "http://127.0.0.1:57934", fetch: recordingFetch(log) })
    await client.createThread({ projectPath: "C:/proj", model: "deepseek/deepseek-v4-flash" })
    assert.equal(log[0].url, "http://127.0.0.1:57934/api/threads")
    const body = JSON.parse(String(log[0].init?.body))
    assert.deepEqual(body, { projectPath: "C:/proj", model: "deepseek/deepseek-v4-flash" })
    const headers = new Headers(log[0].init?.headers)
    assert.equal(headers.get("origin"), "http://127.0.0.1:57934")
    assert.equal(headers.get("sec-fetch-site"), "same-origin")
    assert.equal(headers.get("x-saiwork-coordinator"), "1")
  })

  it("dispatches a prompt via the thread message action", async () => {
    const log: Array<{ url: string; init?: RequestInit }> = []
    const client = createFreebuffClient({ baseUrl: "http://127.0.0.1:57934", fetch: recordingFetch(log) })
    await client.postMessage("thr-1", "fix the build", ["a.png"])
    assert.equal(log[0].url, "http://127.0.0.1:57934/api/thread/thr-1/message")
    const body = JSON.parse(String(log[0].init?.body))
    assert.deepEqual(body, { text: "fix the build", attachments: ["a.png"] })
  })

  it("lists threads and maps the response shape", async () => {
    const client = createFreebuffClient({
      baseUrl: "http://127.0.0.1:57934",
      fetch: async (url) => {
        assert.equal(String(url), "http://127.0.0.1:57934/api/threads")
        return fakeResponse(200, { threads: [{ id: "t1", status: "open" }] })
      },
    })
    const threads = await client.listThreads()
    assert.equal(threads.length, 1)
    assert.equal(threads[0].id, "t1")
  })

  it("throws typed errors on non-2xx responses", async () => {
    const client = createFreebuffClient({
      baseUrl: "http://127.0.0.1:57934",
      fetch: async () => fakeResponse(404, { error: "not found" }),
    })
    await assert.rejects(client.getThread("ghost"), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as Error & { status: number }).status, 404)
      assert.match(error.message, /not found/)
      return true
    })
  })

  it("parses SSE frames from the events endpoint and unsubscribes cleanly", async () => {
    const frames = [
      `data: ${JSON.stringify({ type: "thread", threadId: "t1", thread: { id: "t1" }, items: [] })}`,
      `data: ${JSON.stringify({ type: "agent", threadId: "t1", seq: 1, event: { type: "text", text: "hi" } })}`,
    ]
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${frames[0]}\n\n`))
        controller.enqueue(encoder.encode(`${frames[1]}\n\n`))
        controller.close()
      },
    })
    const client = createFreebuffClient({
      baseUrl: "http://127.0.0.1:57934",
      fetch: async () => new Response(body, { status: 200 }),
    })
    const events: unknown[] = []
    let ended = false
    await new Promise<void>((resolve) => {
      void client.subscribeEvents(
        (event) => {
          events.push(event)
          if (events.length === 2) resolve()
        },
        () => {
          ended = true
        },
      )
    })
    assert.equal(events.length, 2)
    assert.deepEqual(events[0], { type: "thread", threadId: "t1", thread: { id: "t1" }, items: [] })
    assert.deepEqual(events[1], { type: "agent", threadId: "t1", seq: 1, event: { type: "text", text: "hi" } })
  })

  it("tolerates malformed SSE frames without dropping later events", async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {not json}\n\n"))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "state", snapshot: {} })}\n\n`))
        controller.close()
      },
    })
    const client = createFreebuffClient({
      baseUrl: "http://127.0.0.1:57934",
      fetch: async () => new Response(body, { status: 200 }),
    })
    const events: unknown[] = []
    await new Promise<void>((resolve) => {
      void client.subscribeEvents(
        (event) => {
          events.push(event)
          resolve()
        },
        () => {},
      )
    })
    assert.equal(events.length, 1)
    assert.deepEqual(events[0], { type: "state", snapshot: {} })
  })
})
