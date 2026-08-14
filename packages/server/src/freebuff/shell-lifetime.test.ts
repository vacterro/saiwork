import assert from "node:assert/strict"
import { createHmac, randomBytes } from "node:crypto"
import net, { type Socket } from "node:net"
import { describe, it } from "node:test"

import { createFreebuffShellLifetimeServer } from "./shell-lifetime"

const TOKEN = "desktop-contract-test-token"

describe("FreeBuff shell lifetime contract", () => {
  it("performs the Desktop two-challenge HMAC exchange and heartbeats", async () => {
    const lifetime = await createFreebuffShellLifetimeServer({
      token: TOKEN,
      heartbeatIntervalMs: 10,
      handshakeTimeoutMs: 250,
    })
    const socket = net.connect({ host: "127.0.0.1", port: lifetime.port })
    const lines = createLineReader(socket)
    try {
      const serverChallenge = await lines.next()
      const clientChallenge = randomBytes(32).toString("base64url")
      const clientProof = createHmac("sha256", TOKEN)
        .update(`client:${serverChallenge}:${clientChallenge}`)
        .digest("base64url")
      socket.write(`${clientChallenge}:${clientProof}\n`)

      const serverProof = await lines.next()
      assert.equal(
        serverProof,
        createHmac("sha256", TOKEN)
          .update(`server:${serverChallenge}:${clientChallenge}`)
          .digest("base64url"),
      )
      assert.equal(await lines.next(), "ping")

      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
      lifetime.disconnectClients()
      await closed
    } finally {
      socket.destroy()
      await lifetime.close()
    }
  })

  it("rejects a bad proof, stays reusable, and closes idempotently", async () => {
    const lifetime = await createFreebuffShellLifetimeServer({
      token: TOKEN,
      heartbeatIntervalMs: 10,
      handshakeTimeoutMs: 250,
    })
    const bad = net.connect({ host: "127.0.0.1", port: lifetime.port })
    const badLines = createLineReader(bad)
    await badLines.next()
    const badClosed = new Promise<void>((resolve) => bad.once("close", () => resolve()))
    bad.write("challenge:not-a-valid-proof\n")
    await badClosed

    const good = net.connect({ host: "127.0.0.1", port: lifetime.port })
    const goodLines = createLineReader(good)
    const challenge = await goodLines.next()
    const clientChallenge = "second-client"
    const proof = createHmac("sha256", TOKEN)
      .update(`client:${challenge}:${clientChallenge}`)
      .digest("base64url")
    good.write(`${clientChallenge}:${proof}\n`)
    assert.equal(
      await goodLines.next(),
      createHmac("sha256", TOKEN)
        .update(`server:${challenge}:${clientChallenge}`)
        .digest("base64url"),
    )

    await Promise.all([lifetime.close(), lifetime.close()])
    good.destroy()
  })
})

function createLineReader(socket: Socket): { next: () => Promise<string> } {
  let buffer = ""
  const queued: string[] = []
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = []
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(line)
      else queued.push(line)
    }
  })
  socket.once("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("socket closed before next line"))
  })
  return {
    next: () => {
      const line = queued.shift()
      if (line !== undefined) return Promise.resolve(line)
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}

