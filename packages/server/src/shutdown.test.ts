import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createServerShutdownHandler,
  orchestrateServerShutdown,
  SERVER_SHUTDOWN_COMPLETE,
  SERVER_SHUTDOWN_INCOMPLETE,
  type ServerShutdownOperations,
} from "./shutdown"

const logger = { info() {}, warn() {}, error() {} }
const operations = (overrides: Partial<ServerShutdownOperations> = {}): ServerShutdownOperations => ({
  stopInstanceEventBridge() {}, stopSidecars() {}, stopClientConnections() {},
  stopRemoteProxySessions() {}, stopWorkspaces() {}, stopHttpServers() {}, stopReleaseMonitor() {},
  stopSaipenWatcher() {}, stopQueueManager() {}, stopFreebuffEngine() {}, stopOrphanCleanup() {},
  stopBackgroundProcesses() {}, stopSaipenAutoUpdate() {}, stopPreviews() {},
  ...overrides,
})

describe("server shutdown orchestration", () => {
  it("retries workspace cleanup and preserves shutdown order", async () => {
    const calls: string[] = []
    let attempts = 0
    await orchestrateServerShutdown(operations({
      stopRemoteProxySessions: () => { calls.push("remote-proxy") },
      stopBackgroundProcesses: () => { calls.push("background-processes") },
      stopWorkspaces: () => { calls.push(`workspaces-${++attempts}`); if (attempts === 1) throw new Error("still alive") },
      stopHttpServers: () => { calls.push("http") },
    }), logger)
    assert.deepEqual(calls, ["remote-proxy", "background-processes", "workspaces-1", "workspaces-2", "http"])
  })

  it("stops the watcher and drains pending queue work after HTTP admission closes", async () => {
    const calls: string[] = []
    let releaseQueue!: () => void
    const queueDrain = new Promise<void>((resolve) => { releaseQueue = resolve })
    const shutdown = orchestrateServerShutdown(operations({
      stopSaipenWatcher: () => { calls.push("watcher") },
      stopHttpServers: () => { calls.push("http") },
      stopQueueManager: () => { calls.push("queue"); return queueDrain },
      stopReleaseMonitor: () => { calls.push("release-monitor") },
    }), logger)

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls.filter((call) => call === "watcher").length, 1)
    assert.ok(calls.indexOf("http") < calls.indexOf("queue"))
    assert.ok(!calls.includes("release-monitor") || calls.indexOf("http") < calls.indexOf("release-monitor"))
    releaseQueue()
    await shutdown
  })

  it("closes remaining resources and aggregates the concrete current error", async () => {
    const failure = new Error("workspace abc POSIX process group is still alive")
    const closed: string[] = []
    let attempts = 0
    await assert.rejects(orchestrateServerShutdown(operations({
      stopWorkspaces: () => { attempts++; throw failure },
      stopHttpServers: () => { closed.push("http") },
      stopReleaseMonitor: () => { closed.push("release-monitor") },
    }), logger), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 1)
      assert.match(error.errors[0].message, /^stopWorkspaces failed:/)
      assert.strictEqual(error.errors[0].cause, failure)
      return true
    })
    assert.deepEqual([attempts, closed], [2, ["http", "release-monitor"]])
  })

  it("starts workspace cleanup without waiting for preliminary shutdown", async () => {
    let releasePreliminary!: () => void
    const preliminary = new Promise<void>((resolve) => { releasePreliminary = resolve })
    let workspaceStarted = false
    const shutdown = orchestrateServerShutdown(operations({
      stopRemoteProxySessions: () => preliminary,
      stopWorkspaces: () => { workspaceStarted = true },
    }), logger)

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(workspaceStarted, true)
    releasePreliminary()
    await shutdown
  })

  it("stops the SAIPEN auto-update timer even when another operation fails", async () => {
    const stopped: string[] = []
    await assert.rejects(orchestrateServerShutdown(operations({
      stopSaipenAutoUpdate: () => { stopped.push("auto-update") },
      stopWorkspaces: () => { throw new Error("workspace shutdown failed") },
    }), logger), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      return true
    })
    assert.deepEqual(stopped, ["auto-update"], "auto-update must stop during shutdown despite the workspace failure")
  })
})

describe("server shutdown signal boundary", () => {
  it("reports incomplete cleanup and holds for final tree enforcement", async () => {
    const calls: string[] = []
    const exits: number[] = []
    const statuses: string[] = []
    let releaseHold!: () => void
    const hold = new Promise<void>((resolve) => { releaseHold = resolve })
    const handler = createServerShutdownHandler({
      shutdown: async () => { calls.push("cleanup"); throw new Error("retained child survived") },
      logger: { info: () => calls.push("info"), warn() {}, error: () => calls.push("error") },
      forceExit: (code) => { calls.push("force-exit"); exits.push(code) },
      setExitCode: () => undefined,
      reportStatus: (status) => statuses.push(status),
      holdAfterFailure: () => hold,
      retryAttempts: 0,
    })
    const pending = handler("SIGTERM")
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual([exits, statuses, calls], [[], [SERVER_SHUTDOWN_INCOMPLETE], ["info", "cleanup", "error", "error"]])
    handler("SIGTERM")
    assert.deepEqual(exits, [1])
    releaseHold()
    await pending
  })

  it("reports complete cleanup before allowing natural exit", async () => {
    const statuses: string[] = [], exitCodes: number[] = []
    const handler = createServerShutdownHandler({
      shutdown: async () => undefined,
      logger,
      reportStatus: (status) => statuses.push(status),
      setExitCode: (code) => exitCodes.push(code),
    })
    await handler("stdin")
    assert.deepEqual(statuses, [SERVER_SHUTDOWN_COMPLETE])
    assert.deepEqual(exitCodes, [0])
  })

  it("keeps retrying identity-aware cleanup during the final enforcement budget", async () => {
    let attempts = 0
    const statuses: string[] = [], exitCodes: number[] = []
    const handler = createServerShutdownHandler({
      shutdown: async () => {
        attempts++
        if (attempts === 1) throw new Error("detached group still alive")
      },
      logger,
      reportStatus: (status) => statuses.push(status),
      setExitCode: (code) => exitCodes.push(code),
      retryDelayMs: 0,
    })

    await handler("stdin")
    assert.equal(attempts, 2)
    assert.deepEqual(statuses, [SERVER_SHUTDOWN_COMPLETE])
    assert.deepEqual(exitCodes, [0])
  })

  it("preserves containment after the standalone cleanup retry budget", async () => {
    let attempts = 0
    const statuses: string[] = [], exitCodes: number[] = [], forcedExits: number[] = []
    let releaseHold!: () => void
    const hold = new Promise<void>((resolve) => { releaseHold = resolve })
    const handler = createServerShutdownHandler({
      shutdown: async () => { attempts++; throw new Error("process tree remains alive") },
      logger,
      reportStatus: (status) => statuses.push(status),
      setExitCode: (code) => exitCodes.push(code),
      forceExit: (code) => forcedExits.push(code),
      holdAfterFailure: () => hold,
      retryDelayMs: 0,
      retryAttempts: 2,
    })

    const pending = handler("stdin")
    while (attempts < 3) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(attempts, 3)
    assert.deepEqual(statuses, [SERVER_SHUTDOWN_INCOMPLETE])
    assert.deepEqual(exitCodes, [1])
    assert.deepEqual(forcedExits, [])
    handler("SIGTERM")
    assert.deepEqual(forcedExits, [1])
    releaseHold()
    await pending
  })

  it("escalates a second signal while sharing first-signal cleanup", async () => {
    let finish!: () => void
    const cleanup = new Promise<void>((resolve) => { finish = resolve })
    const exits: number[] = [], exitCodes: number[] = []
    const handler = createServerShutdownHandler({ shutdown: () => cleanup, logger,
      forceExit: (code) => exits.push(code), setExitCode: (code) => exitCodes.push(code), reportStatus: () => undefined })
    const first = handler("SIGINT"), second = handler("SIGTERM")
    assert.strictEqual(first, second)
    assert.deepEqual(exits, [1])
    finish(); await first
    assert.deepEqual(exitCodes, [0])
  })
})
