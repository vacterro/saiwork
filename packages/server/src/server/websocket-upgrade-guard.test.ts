import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import type { Socket } from "net"

import { claimWebSocketUpgrade, guardWebSocketUpgrade, resolveUiDevWebSocketTarget } from "./websocket-upgrade-guard"

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    destroyed: boolean
    destroyCalls: number
    destroy: () => void
  }
  socket.destroyed = false
  socket.destroyCalls = 0
  socket.destroy = () => {
    socket.destroyed = true
    socket.destroyCalls += 1
  }
  return socket
}

function nextImmediate() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

test("guards and closes an unclaimed upgrade socket", async () => {
  const socket = fakeSocket()
  const errors: string[] = []

  guardWebSocketUpgrade(socket as unknown as Socket, (error) => errors.push(error.message))
  socket.emit("error", new Error("read ECONNRESET"))
  await nextImmediate()

  assert.deepEqual(errors, ["read ECONNRESET"])
  assert.equal(socket.destroyCalls, 1)
})

test("keeps a claimed socket open and guards repeated errors", async () => {
  const socket = fakeSocket()
  const errors: string[] = []

  claimWebSocketUpgrade(socket as unknown as Socket)
  guardWebSocketUpgrade(socket as unknown as Socket, (error) => errors.push(error.message))
  await nextImmediate()
  socket.emit("error", new Error("first"))
  socket.emit("error", new Error("second"))

  assert.equal(socket.destroyCalls, 0)
  assert.deepEqual(errors, ["first", "second"])
})

test("keeps UI dev websocket targets on the configured origin", () => {
  assert.equal(
    resolveUiDevWebSocketTarget("/@vite/client?token=one", "http://localhost:3000")?.href,
    "http://localhost:3000/@vite/client?token=one",
  )
  assert.equal(resolveUiDevWebSocketTarget("https://attacker.example/socket", "http://localhost:3000"), null)
  assert.equal(resolveUiDevWebSocketTarget("//attacker.example/socket", "http://localhost:3000"), null)
  assert.equal(resolveUiDevWebSocketTarget("/\\attacker.example/socket", "http://localhost:3000"), null)
})
