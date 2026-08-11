import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, it } from "node:test"

import { FreebuffEngineManager } from "./engine"
import type { FreebuffInstall } from "./install"

const INSTALL: FreebuffInstall = {
  root: "C:/freebuff",
  bunPath: "C:/freebuff/resources/bun/bun.exe",
  orchestratorPath: "C:/freebuff/resources/orchestrator/orchestrator.js",
  auth: { token: "tok", user: { id: "u1", email: "dev@example.com" } },
}

interface FakeChild extends EventEmitter {
  exitCode: number | null
  killed: boolean
  kill: (signal?: string) => void
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.exitCode = null
  child.killed = false
  child.kill = () => {
    child.killed = true
    child.exitCode = 0
  }
  return child
}

const logger = { info() {}, warn() {}, error() {}, debug() {} }

function manager(overrides: {
  locate?: () => FreebuffInstall | null
  spawn?: (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: "ignore"[] }) => FakeChild
  waitForReady?: (port: number) => Promise<boolean>
}) {
  return new FreebuffEngineManager({
    logger: logger as never,
    port: 19_321,
    locate: overrides.locate ?? (() => INSTALL),
    spawn: (command, args) => overrides.spawn!(command, args, { cwd: undefined, env: {}, stdio: ["ignore", "ignore", "ignore"] }) as unknown as ChildProcess,
    waitForReady: overrides.waitForReady ?? (async () => true),
    readyTimeoutMs: 50,
  })
}

describe("FreebuffEngineManager", () => {
  it("spawns the orchestrator on the configured port and becomes ready", async () => {
    let spawned: { command: string; args: string[]; env?: NodeJS.ProcessEnv } | null = null
    const engine = manager({
      spawn: (command, args) => {
        spawned = { command, args }
        return fakeChild()
      },
    })
    const status = await engine.start()
    assert.equal(status.installFound, true)
    assert.equal(status.engineRunning, true)
    assert.equal(status.ready, true)
    assert.equal(status.port, 19_321)
    assert.equal(spawned!.command, "C:/freebuff/resources/bun/bun.exe")
    assert.deepEqual(spawned!.args, ["C:/freebuff/resources/orchestrator/orchestrator.js"])
    await engine.stop()
  })

  it("reports a missing install instead of spawning", async () => {
    const engine = manager({ locate: () => null })
    const status = await engine.start()
    assert.equal(status.installFound, false)
    assert.equal(status.engineRunning, false)
    assert.match(status.error ?? "", /not found/)
  })

  it("fails when readiness never arrives", async () => {
    const engine = manager({
      spawn: () => fakeChild(),
      waitForReady: async () => false,
    })
    const status = await engine.start()
    assert.equal(status.ready, false)
    assert.match(status.error ?? "", /did not become ready/)
    await engine.stop()
  })

  it("reports spawn failure", async () => {
    const engine = manager({
      spawn: () => {
        const child = fakeChild()
        queueMicrotask(() => child.emit("error", new Error("ENOENT")))
        return child
      },
      waitForReady: async () => false,
    })
    const status = await engine.start()
    assert.equal(status.ready, false)
  })
})
