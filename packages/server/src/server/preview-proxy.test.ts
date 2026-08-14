import assert from "node:assert/strict"
import { describe, it } from "node:test"
import http from "node:http"
import Fastify from "fastify"
import { registerPreviewProxyRoutes } from "./http-server"
import { PreviewManager } from "../previews/manager"

const nullLogger = {
  debug: () => {},
  warn: () => {},
  trace: () => {},
  info: () => {},
  error: () => {},
  child: () => nullLogger,
  isLevelEnabled: () => false,
}

async function startUpstream(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function htmlDocument(content: string): string {
  return `<!doctype html><html><head><title>Preview</title></head><body>${content}</body></html>`
}

describe("preview proxy hardening", () => {
  it("rewrites HTML asset URLs and re-sandboxes preview HTML server-side", async (t) => {
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "text/html")
      response.end(htmlDocument(`<script>parent.document.title='pwned';fetch('/api/state')</script><a href="/page">link</a>`))
    })
    t.after(() => upstream.close())
    const previewManager = new PreviewManager()
    const preview = previewManager.create("s1", upstream.url)
    const app = Fastify({ logger: false })
    registerPreviewProxyRoutes(app, { previewManager, logger: nullLogger as never })
    const response = await app.inject({ method: "GET", url: `${preview.proxyUrl}` })
    assert.equal(response.statusCode, 200)
    assert.ok(response.body.includes('<a href="/previews'))
    assert.ok(response.headers["content-security-policy"]?.includes("sandbox allow-same-origin"), "preview HTML is re-sandboxed server-side")
    assert.ok(response.headers["x-frame-options"] === undefined, "framing is allowed but the document stays sandboxed")
    await app.close()
  })

  it("fails boundedly when preview HTML exceeds the rewrite byte cap", async (t) => {
    const bigBody = htmlDocument(`<p>${"x".repeat(9 * 1024 * 1024)}</p>`)
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "text/html")
      response.end(bigBody)
    })
    t.after(() => upstream.close())
    const previewManager = new PreviewManager()
    const preview = previewManager.create("s1", upstream.url)
    const app = Fastify({ logger: false })
    registerPreviewProxyRoutes(app, { previewManager, logger: nullLogger as never })
    const response = await app.inject({ method: "GET", url: `${preview.proxyUrl}` })
    assert.equal(response.statusCode, 502, "an oversized rewrite body fails boundedly")
    assert.ok(response.json().error.includes("rewrite cap"), "the cap error is surfaced")
    await app.close()
  })

  it("streams a large binary without rewriting and without a buffered content-length", async (t) => {
    const payload = Buffer.alloc(6 * 1024 * 1024, 0x5a)
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "application/octet-stream")
      response.end(payload)
    })
    t.after(() => upstream.close())
    const previewManager = new PreviewManager()
    const preview = previewManager.create("s1", upstream.url)
    const app = Fastify({ logger: false })
    registerPreviewProxyRoutes(app, { previewManager, logger: nullLogger as never })
    const response = await app.inject({ method: "GET", url: `${preview.proxyUrl}` })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-length"], undefined, "streamed bodies do not claim a whole-body length")
    assert.deepEqual(response.rawPayload, payload, "the full binary is delivered intact")
    await app.close()
  })

  it("aborts a never-ending upstream with no content-length", async (t) => {
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("content-type", "text/html")
      const chunk = Buffer.from("<div>infinite</div>")
      const pump = () => {
        if (response.write(chunk)) {
          setImmediate(pump)
        } else {
          response.on("drain", pump)
        }
      }
      pump()
    })
    t.after(() => upstream.close())
    const previewManager = new PreviewManager()
    const preview = previewManager.create("s1", upstream.url)
    const app = Fastify({ logger: false })
    registerPreviewProxyRoutes(app, { previewManager, logger: nullLogger as never, upstreamTimeoutMs: 300 })
    const response = await app.inject({ method: "GET", url: `${preview.proxyUrl}` })
    assert.equal(response.statusCode, 504, "a stalled upstream is aborted and returns 504")
    await app.close()
  })

  it("returns 404 for an unknown preview token", async (t) => {
    const previewManager = new PreviewManager()
    const app = Fastify({ logger: false })
    registerPreviewProxyRoutes(app, { previewManager, logger: nullLogger as never })
    const response = await app.inject({ method: "GET", url: "/previews/unknown-token" })
    assert.equal(response.statusCode, 404)
    await app.close()
  })
})
