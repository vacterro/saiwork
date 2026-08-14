import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { fetch } from "undici"
import Fastify from "fastify"
import { registerPluginRoutes } from "./plugin"
import { PluginChannelManager } from "../../plugins/channel"
import { VoiceModeManager } from "../../plugins/voice-mode"
import { ClientConnectionManager } from "../../clients/connection-manager"
import { EventBus } from "../../events/bus"

const nullLogger = {
  debug: () => {},
  warn: () => {},
  trace: () => {},
  info: () => {},
  error: () => {},
  child: () => nullLogger,
  isLevelEnabled: () => false,
}

async function collectSseFrames(url: string, durationMs: number): Promise<string[]> {
  const controller = new AbortController()
  const frames: string[] = []
  const response = await fetch(url, { signal: controller.signal })
  const reader = response.body!.getReader()
  let buffer = ""
  const deadline = Date.now() + durationMs
  const timer = setInterval(() => {
    if (Date.now() >= deadline) controller.abort()
  }, 5)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += new TextDecoder().decode(value)
      let index: number
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (frame.startsWith("data: ")) frames.push(frame)
      }
    }
  } catch {
    // deadline abort
  } finally {
    clearInterval(timer)
  }
  return frames
}

describe("plugin SSE heartbeat is connection-scoped (no N^2)", () => {
  it("two clients each receive ~one ping per interval, not every client's pings", async (t) => {
    const clientConnections = new ClientConnectionManager(nullLogger as never)
    const channel = new PluginChannelManager(nullLogger as never)
    const voiceModeManager = new VoiceModeManager({ connections: clientConnections, channel, logger: nullLogger as never })
    const app = Fastify({ logger: false })
    registerPluginRoutes(app, {
      workspaceManager: { get: (id: string) => (id === "w1" ? { path: "/work" } : undefined) } as never,
      eventBus: new EventBus(),
      logger: nullLogger as never,
      channel,
      voiceModeManager,
      heartbeatIntervalMs: 40,
    })
    const port = await new Promise<number>((resolve) => {
      app.listen({ port: 0, host: "127.0.0.1" }, () => resolve((app.server.address() as { port: number }).port))
    })
    t.after(async () => {
      clientConnections.shutdown()
      await app.close()
    })
    const url = `http://127.0.0.1:${port}/workspaces/w1/plugin/events`

    const [clientA, clientB] = await Promise.all([collectSseFrames(url, 150), collectSseFrames(url, 150)])
    const pingsA = clientA.filter((frame) => frame.includes('"saiwork.ping"')).length
    const pingsB = clientB.filter((frame) => frame.includes('"saiwork.ping"')).length
    assert.ok(pingsA >= 2, `client A receives heartbeats (got ${pingsA})`)
    assert.ok(pingsA < 6, `client A receives ~1 ping per interval, not N^2 (got ${pingsA})`)
    assert.ok(pingsB >= 2, `client B receives heartbeats (got ${pingsB})`)
    assert.ok(pingsB < 6, `client B receives ~1 ping per interval, not N^2 (got ${pingsB})`)
    assert.ok(Math.abs(pingsA - pingsB) <= 1, `both clients see the same heartbeat count (A=${pingsA}, B=${pingsB})`)
  })
})
