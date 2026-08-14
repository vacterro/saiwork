import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { FastifyReply } from "fastify"
import { PluginChannelManager, type PluginOutboundEvent } from "./channel"
import { VoiceModeManager } from "./voice-mode"
import { connectionKey, ClientConnectionManager } from "../clients/connection-manager"

const nullLogger = {
  debug: () => {},
  warn: () => {},
  trace: () => {},
  info: () => {},
  error: () => {},
  child: () => nullLogger,
  isLevelEnabled: () => false,
}

interface FakeReply {
  written: string[]
  closed: boolean
  writeCalls: number
  writeResult: boolean
  raw: {
    write: (frame: string) => boolean
    end: () => void
  }
}

function makeReply(writeResult = true): FakeReply {
  const reply: FakeReply = {
    written: [],
    closed: false,
    writeCalls: 0,
    writeResult,
    raw: {
      write: () => true,
      end: () => { reply.closed = true },
    },
  }
  reply.raw.write = (frame: string) => {
    reply.writeCalls += 1
    reply.written.push(frame)
    return reply.writeResult
  }
  return reply
}

const ping: PluginOutboundEvent = { type: "saiwork.ping", properties: { ts: Date.now() } }

describe("PluginChannelManager per-client bounded sender", () => {
  it("a connection-scoped send reaches only its own client", () => {
    const channel = new PluginChannelManager(nullLogger as never)
    const a = makeReply()
    const b = makeReply()
    const regA = channel.register("w1", a as never as FastifyReply)
    const regB = channel.register("w1", b as never as FastifyReply)

    regA.send(ping)
    assert.equal(a.written.length, 1, "client A receives its own heartbeat")
    assert.equal(b.written.length, 0, "client B receives nothing from A's registration")
    regA.close()
    regB.close()
  })

  it("workspace broadcast still reaches every client of the workspace", () => {
    const channel = new PluginChannelManager(nullLogger as never)
    const a = makeReply()
    const b = makeReply()
    const regA = channel.register("w1", a as never as FastifyReply)
    const regB = channel.register("w2", b as never as FastifyReply)

    channel.send("w1", ping)
    assert.equal(a.written.length, 1)
    assert.equal(b.written.length, 0, "a different workspace client is not spammed")
    regA.close()
    regB.close()
  })

  it("a slow client is bounded and disconnected once, not grown unboundedly", () => {
    const channel = new PluginChannelManager(nullLogger as never)
    const slow = makeReply(false) // write() always false -> backpressure
    const registration = channel.register("w1", slow as never as FastifyReply)

    for (let i = 0; i < 10_000; i += 1) {
      registration.send({ type: "plugin.event", properties: { n: i } })
    }
    assert.ok(slow.writeCalls <= 1, "a never-draining client receives at most the first frame")
    assert.equal(slow.closed, true, "the slow client is disconnected on overflow")
    assert.ok(registration !== undefined)
  })

  it("closing one client does not affect another", () => {
    const channel = new PluginChannelManager(nullLogger as never)
    const a = makeReply()
    const b = makeReply()
    const regA = channel.register("w1", a as never as FastifyReply)
    const regB = channel.register("w1", b as never as FastifyReply)

    regA.close()
    regB.send(ping)
    assert.equal(b.written.length, 1, "B still delivers after A closes")
    regB.close()
  })
})

describe("canonical connection keys cannot collide", () => {
  it("(a:b, c) and (a, b:c) are distinct keys and co-exist", () => {
    const manager = new ClientConnectionManager(nullLogger as never)
    const closeA = manager.register({ clientId: "a:b", connectionId: "c", close: () => {} })
    const closeB = manager.register({ clientId: "a", connectionId: "b:c", close: () => {} })

    assert.ok(manager.isConnected({ clientId: "a:b", connectionId: "c" }), "the first connection is addressed correctly")
    assert.ok(manager.isConnected({ clientId: "a", connectionId: "b:c" }), "the second connection is addressed correctly")
    assert.notEqual(connectionKey({ clientId: "a:b", connectionId: "c" }), connectionKey({ clientId: "a", connectionId: "b:c" }))

    assert.equal(manager.pong({ clientId: "a:b", connectionId: "c" }), true, "pong hits the right record")
    assert.equal(manager.pong({ clientId: "a", connectionId: "b:c" }), true)
    closeA()
    assert.ok(!manager.isConnected({ clientId: "a:b", connectionId: "c" }))
    assert.ok(manager.isConnected({ clientId: "a", connectionId: "b:c" }), "disconnecting one never touches the other")
    closeB()
    manager.shutdown()
  })
})

describe("voice mode connection identity", () => {
  it("enabling/disabling one voice connection never changes another, even under key collisions", () => {
    const manager = new ClientConnectionManager(nullLogger as never)
    const channel = new PluginChannelManager(nullLogger as never)
    const voice = new VoiceModeManager({ connections: manager, channel, logger: nullLogger as never })

    const first = { clientId: "a:b", connectionId: "c" }
    const second = { clientId: "a", connectionId: "b:c" }
    manager.register({ ...first, close: () => {} })
    manager.register({ ...second, close: () => {} })

    assert.equal(voice.setEnabled("w1", first, true), true)
    assert.equal(voice.isEnabled("w1"), true)
    assert.equal(voice.setEnabled("w1", second, false), true)
    assert.equal(voice.isEnabled("w1"), true, "disabling an unrelated connection keeps voice mode on")

    assert.equal(voice.setEnabled("w1", first, false), true)
    assert.equal(voice.isEnabled("w1"), false, "disabling the owner turns voice mode off")
    manager.shutdown()
  })

  it("syncInstance sends the current snapshot only to the new connection, never workspace-wide", () => {
    const manager = new ClientConnectionManager(nullLogger as never)
    const channel = new PluginChannelManager(nullLogger as never)
    let channelSends = 0
    const originalSend = channel.send.bind(channel)
    channel.send = ((workspaceId: string, event: PluginOutboundEvent) => {
      channelSends += 1
      originalSend(workspaceId, event)
    }) as never
    const voice = new VoiceModeManager({ connections: manager, channel, logger: nullLogger as never })

    const snapshots: PluginOutboundEvent[] = []
    voice.syncInstance("w1", (event) => snapshots.push(event))
    assert.equal(snapshots.length, 1, "the newly registered connection receives exactly one current-state snapshot")
    assert.equal(snapshots[0]?.type, "saiwork.voiceMode")
    assert.equal(channelSends, 0, "syncInstance must NOT broadcast workspace-wide (reconnect-storm safety)")

    // A real aggregate transition still reaches everyone through channel.send.
    manager.register({ clientId: "a", connectionId: "b", close: () => {} })
    voice.setEnabled("w1", { clientId: "a", connectionId: "b" }, true)
    assert.equal(channelSends, 1, "publishIfChanged still publishes actual aggregate transitions workspace-wide")
    manager.shutdown()
  })
})
