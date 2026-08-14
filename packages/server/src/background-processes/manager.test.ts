import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { EventEmitter } from "node:events"
import { promises as fs, type WriteStream } from "node:fs"
import path from "node:path"
import os from "node:os"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

import {
  BackgroundProcessManager,
  BackgroundProcessIndexError,
  BackgroundProcessOwnershipError,
} from "./manager"
import type { WorkspaceManager } from "../workspaces/manager"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"

const WORKSPACE_ID = "ws-test"
const SESSION_ID = "sess-1"
const INSTANCE_PORT = 9999
const AUTH_HEADER = "Basic test-auth"
const TERMINAL_TIMEOUT_MS = 3000

interface CapturedRequest {
  method: string
  url: string
  headers: Headers
  body: string
}

interface FailureHarnessOptions {
  onSpawn: (child: ChildProcess, outputStream: WriteStream) => void
  writeIndex?: (indexPath: string, records: any[]) => Promise<void>
  spawnThrows?: boolean
}

function createFakeChild(): ChildProcess {
  const child: any = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = null
  child.pid = undefined
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  return child as ChildProcess
}

interface OwnershipHarnessOptions {
  exitOnKill?: boolean
  writeIndex?: (indexPath: string, records: any[]) => Promise<void>
  platform?: NodeJS.Platform
  spawnSyncProcess?: (...args: any[]) => any
  useInjectedKill?: boolean
  stopTimeoutMs?: number
  exitWaitTimeoutMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

async function createOwnershipHarness(options: OwnershipHarnessOptions = {}) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "bp-ownership-test-"))
  const children: Array<ChildProcess & { killCalls: NodeJS.Signals[] }> = []
  const warnings: string[] = []
  let nextPid = 41_000

  const eventBus = new EventEmitter() as EventBus & EventEmitter & { publish(event: any): boolean }
  eventBus.publish = (event: any) => eventBus.emit(event.type, event)

  const logger = {
    warn: (_context: unknown, message?: string) => { if (message) warnings.push(message) },
    debug: () => {}, trace: () => {}, info: () => {}, error: () => {}, fatal: () => {},
    isLevelEnabled: () => false, level: "info",
    child: () => logger,
  } as unknown as Logger
  const workspaceManager = {
    get: (workspaceId: string) => workspaceId === WORKSPACE_ID ? { path: workspacePath } : undefined,
  } as unknown as WorkspaceManager

  const spawnProcess = (() => {
    const child: any = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = null
    child.pid = nextPid++
    child.killed = false
    child.killCalls = [] as NodeJS.Signals[]
    child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
      child.killCalls.push(signal)
      if (options.exitOnKill === false) return false
      if (child.killed) return true
      child.killed = true
      queueMicrotask(() => child.emit("close", null, signal))
      return true
    }
    children.push(child)
    return child as ChildProcess
  }) as typeof import("node:child_process").spawn

  const manager = new BackgroundProcessManager({
    workspaceManager,
    eventBus,
    logger,
    spawnProcess,
    createOutputStream: (() => new PassThrough() as unknown as WriteStream) as any,
    writeIndex: options.writeIndex,
    platform: options.platform ?? "linux",
    spawnSyncProcess: options.spawnSyncProcess as any,
    killProcess: options.useInjectedKill === false
      ? undefined
      : (child, signal) => { child.kill(signal) },
    stopTimeoutMs: options.stopTimeoutMs,
    exitWaitTimeoutMs: options.exitWaitTimeoutMs,
    setTimeoutFn: options.setTimeoutFn,
    clearTimeoutFn: options.clearTimeoutFn,
  })

  return { manager, eventBus, children, warnings, workspacePath }
}

async function createFailureHarness(options: FailureHarnessOptions) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "bp-failure-test-"))
  const child = createFakeChild()
  const outputStream = new PassThrough() as unknown as WriteStream
  const updates: any[] = []
  const warnings: string[] = []
  let resolveTerminal = () => {}
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })

  const eventBus = {
    on: () => {},
    publish: (event: any) => {
      const processRecord = event?.event?.properties?.process
      if (processRecord) {
        updates.push(processRecord)
        if (processRecord.status !== "running") resolveTerminal()
      }
      if (event?.event?.type === "background.process.removed") resolveTerminal()
      return true
    },
  } as unknown as EventBus

  const logger = {
    warn: (_context: unknown, message?: string) => {
      if (message) warnings.push(message)
    },
    debug: () => {},
    trace: () => {},
    info: () => {},
    error: () => {},
    fatal: () => {},
    isLevelEnabled: () => false,
    level: "info",
    child: () => logger,
  } as unknown as Logger

  const workspaceManager = {
    get: () => ({ path: workspacePath }),
  } as unknown as WorkspaceManager

  const manager = new BackgroundProcessManager({
    workspaceManager,
    eventBus,
    logger,
    spawnProcess: options.spawnThrows
      ? (() => {
          throw new Error("injected spawn failure")
        }) as any
      : (() => {
          options.onSpawn(child, outputStream)
          return child
        }) as any,
    createOutputStream: (() => outputStream) as any,
    writeIndex: options.writeIndex,
    killProcess: (target) => {
      ;(target as any).killed = true
    },
  })

  return { manager, child, outputStream, terminal, updates, warnings, workspacePath }
}

/**
 * Drives the real {@link BackgroundProcessManager} lifecycle (spawn a
 * fast-exiting command with notify enabled) against a mocked transport, so the
 * migrated `sendCompletionPrompt` path — factory + SDK client + `fetch` — is
 * exercised end to end without touching production wiring.
 *
 * The workspace temp directory is intentionally left in place (under
 * `os.tmpdir()`, OS-reaped): removing it from the test races the manager's
 * asynchronous finalization writes, which intermittently fail with ENOENT.
 */
async function runCompletionPrompt(
  fetchImpl: (input: Request, init: RequestInit | undefined) => Promise<Response>,
): Promise<{ requests: CapturedRequest[]; warned: boolean; directory: string }> {
  const requests: CapturedRequest[] = []
  const originalFetch = globalThis.fetch
  // Captured now but swapped in only inside the try below, so a failure during
  // setup (mkdtemp, manager construction) can't leak the mocked fetch.
  const fetchMock = (async (input: any, init: any) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: await req.text(),
    })
    return fetchImpl(input instanceof Request ? input : req, init)
  }) as typeof fetch

  let warned = false
  const logger = {
    warn: () => { warned = true },
    debug: () => {},
    trace: () => {},
    info: () => {},
    error: () => {},
    fatal: () => {},
    isLevelEnabled: () => false,
    level: "info",
    child: () => logger,
  } as unknown as Logger

  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "bp-test-"))
  // Distinct from the workspace root so the directory-override assertion is
  // discriminating: if `sendCompletionPrompt` stops passing `notify.directory`,
  // the factory would fall back to `workspacePath` and the header check fails.
  const sessionDir = path.join(workspacePath, "session-worktree")

  // Resolve once the manager publishes a terminal (non-running) status update.
  let resolveTerminal: () => void = () => {}
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve })
  const eventBus = {
    on: () => {},
    publish: (event: any) => {
      if (event?.type === "instance.event") {
        const type = event?.event?.type
        const status = event?.event?.properties?.process?.status
        if (type === "background.process.removed" || (status && status !== "running")) resolveTerminal()
      }
      return true
    },
  } as unknown as EventBus

  const workspaceManager = {
    get: () => ({ path: workspacePath }),
    getInstancePort: () => INSTANCE_PORT,
    getInstanceAuthorizationHeader: () => AUTH_HEADER,
  } as unknown as WorkspaceManager

  const manager = new BackgroundProcessManager({ workspaceManager, eventBus, logger })

  try {
    globalThis.fetch = fetchMock
    await manager.start(WORKSPACE_ID, "test-proc", "true", {
      notify: true,
      notification: { sessionID: SESSION_ID, directory: sessionDir },
    })
    // The terminal status update is published at the very end of finalize, so
    // resolving on it is a deterministic completion signal. Fail loudly rather
    // than racing a silent timeout that could mask a hang.
    let timeoutHandle: NodeJS.Timeout | undefined
    const reachedTerminal = await Promise.race([
      terminal.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), TERMINAL_TIMEOUT_MS)
      }),
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (!reachedTerminal) {
      throw new Error("background process did not reach a terminal state in time")
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  return { requests, warned, directory: sessionDir }
}

describe("BackgroundProcessManager.sendCompletionPrompt", () => {
  it("posts the synthetic completion prompt to the instance via the SDK route", async () => {
    const { requests, directory } = await runCompletionPrompt(async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    )

    const promptCall = requests.find((r) => r.url.includes("/prompt_async"))
    assert.ok(promptCall, "expected a prompt_async request")
    assert.equal(promptCall.method, "POST")
    assert.equal(
      promptCall.url,
      `http://127.0.0.1:${INSTANCE_PORT}/session/${SESSION_ID}/prompt_async`,
    )
    assert.equal(promptCall.headers.get("authorization"), AUTH_HEADER)
    // The prompt is scoped to the session's directory (a POST keeps the
    // directory as a header — the SDK only rewrites header→query for GET/HEAD).
    assert.equal(promptCall.headers.get("x-opencode-directory"), encodeURIComponent(directory))

    const body = JSON.parse(promptCall.body)
    assert.equal(body.parts.length, 1)
    assert.equal(body.parts[0].type, "text")
    assert.equal(body.parts[0].synthetic, true)
    assert.match(body.parts[0].text, /test-proc/)
  })

  it("swallows a failed prompt and logs it without aborting finalization", async () => {
    const { warned } = await runCompletionPrompt(async () =>
      new Response("boom", { status: 500 }),
    )
    assert.equal(warned, true)
  })
})

describe("BackgroundProcessManager failure containment", () => {
  it("contains a child error followed by close", { timeout: TERMINAL_TIMEOUT_MS }, async (t) => {
    const harness = await createFailureHarness({
      onSpawn: (child) => {
        queueMicrotask(() => child.emit("error", new Error("injected child failure")))
      },
    })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))

    const started = await harness.manager.start(WORKSPACE_ID, "child-failure", "ignored")
    assert.equal(started.status, "running")
    assert.equal(harness.child.killed, true)
    assert.equal(harness.updates.some((record) => record.status === "error"), false)

    harness.child.emit("close", 1, null)
    await harness.terminal
    const records = await harness.manager.list(WORKSPACE_ID)

    assert.equal(records.length, 1)
    assert.equal(records[0].status, "error")
    assert.equal(records[0].terminalReason, "failed")
    assert.ok(harness.updates.some((record) => record.status === "error"))
  })

  it("stops and finalizes after an output stream error", { timeout: TERMINAL_TIMEOUT_MS }, async (t) => {
    const harness = await createFailureHarness({
      onSpawn: (_child, outputStream) => {
        queueMicrotask(() => outputStream.emit("error", new Error("injected output failure")))
      },
    })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))

    const started = await harness.manager.start(WORKSPACE_ID, "output-failure", "ignored")
    assert.equal(started.status, "running")
    assert.equal(harness.child.killed, true)
    assert.equal(harness.outputStream.destroyed, true)
    assert.equal(harness.updates.some((record) => record.status === "error"), false)

    harness.child.emit("close", 1, null)
    await harness.terminal
    const records = await harness.manager.list(WORKSPACE_ID)

    assert.equal(records.length, 1)
    assert.equal(records[0].status, "error")
    assert.equal(records[0].terminalReason, "failed")
    assert.ok(harness.updates.some((record) => record.status === "error"))
  })

  it("recovers from a one-time finalization failure", { timeout: TERMINAL_TIMEOUT_MS }, async (t) => {
    let writes = 0
    const harness = await createFailureHarness({
      onSpawn: (child) => {
        queueMicrotask(() => child.emit("close", 0, null))
      },
      writeIndex: async (indexPath, records) => {
        writes += 1
        if (writes === 2) throw new Error("injected finalization failure")
        await fs.writeFile(indexPath, JSON.stringify(records, null, 2))
      },
    })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))

    const started = await harness.manager.start(WORKSPACE_ID, "finalize-failure", "ignored")
    const records = await harness.manager.list(WORKSPACE_ID)

    assert.equal(writes, 3)
    assert.equal(started.status, "error")
    assert.equal(records.length, 1)
    assert.equal(records[0].status, "error")
    assert.notEqual(records[0].status, "running")
    assert.equal(records[0].terminalReason, "failed")
    assert.ok(harness.warnings.includes("Failed to finalize background process record"))
    assert.ok(harness.updates.some((record) => record.status === "error"))
  })

  it("rejects when the child cannot spawn and leaves no false running record", async (t) => {
    const harness = await createFailureHarness({ onSpawn: () => {}, spawnThrows: true })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))

    await assert.rejects(harness.manager.start(WORKSPACE_ID, "spawn-failure", "ignored"), /injected spawn failure/)
    assert.equal(harness.outputStream.destroyed, true)
    const records = await harness.manager.list(WORKSPACE_ID)
    assert.deepEqual(records, [])
  })

  it("fails closed when the index cannot be written at start", { timeout: TERMINAL_TIMEOUT_MS }, async (t) => {
    const harness = await createFailureHarness({
      onSpawn: () => {},
      writeIndex: async () => {
        throw new Error("injected index write failure")
      },
    })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))

    await assert.rejects(harness.manager.start(WORKSPACE_ID, "index-failure", "ignored"))
    assert.equal(harness.child.killed, true, "child must be stopped on an infrastructure failure")
    const records = await harness.manager.list(WORKSPACE_ID)
    assert.deepEqual(records, [])
  })

  it("fails closed on a corrupt process index and never overwrites it", { timeout: TERMINAL_TIMEOUT_MS }, async (t) => {
    const harness = await createFailureHarness({
      onSpawn: (child) => {
        queueMicrotask(() => child.emit("close", 0, null))
      },
    })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))

    const indexDir = path.join(harness.workspacePath, ".saiwork", "background_processes", WORKSPACE_ID)
    await fs.mkdir(indexDir, { recursive: true })
    const indexPath = path.join(indexDir, "index.json")
    const corrupt = "{ this is not valid json"
    await fs.writeFile(indexPath, corrupt)

    await assert.rejects(
      harness.manager.start(WORKSPACE_ID, "corrupt-index", "ignored"),
      BackgroundProcessIndexError,
    )
    assert.equal(await fs.readFile(indexPath, "utf-8"), corrupt, "the corrupt source must never be overwritten")
    const listed = await harness.manager.list(WORKSPACE_ID).catch(() => null)
    assert.equal(listed, null, "reads on a corrupt index fail closed rather than reporting empty")
  })
})

describe("BackgroundProcessManager ownership and shutdown", () => {
  it("shares exact child ownership across listener-facing references", async (t) => {
    const harness = await createOwnershipHarness()
    t.after(async () => {
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })
    const httpListenerManager = harness.manager
    const httpsListenerManager = harness.manager
    const [first, second] = await Promise.all([
      httpListenerManager.start(WORKSPACE_ID, "http-child", "ignored"),
      httpListenerManager.start(WORKSPACE_ID, "other-child", "ignored"),
    ])

    const stopped = await httpsListenerManager.stop(WORKSPACE_ID, first.id)
    const firstChild = harness.children.find((child) => child.pid === first.pid)
    const secondChild = harness.children.find((child) => child.pid === second.pid)

    assert.equal(stopped?.status, "stopped")
    assert.deepEqual(firstChild?.killCalls, ["SIGTERM"])
    assert.deepEqual(secondChild?.killCalls, [])
    assert.equal((await httpListenerManager.list(WORKSPACE_ID)).find((entry) => entry.id === second.id)?.status, "running")
    await harness.manager.shutdown()
    assert.deepEqual(secondChild?.killCalls, ["SIGTERM"])
    assert.equal(harness.eventBus.listenerCount("workspace.stopped"), 0)
    assert.equal(harness.eventBus.listenerCount("workspace.error"), 0)
  })

  it("serializes concurrent index read-modify-write transactions", async (t) => {
    let writes = 0
    let releaseFirstWrite!: () => void
    let firstWriteStarted!: () => void
    const firstWrite = new Promise<void>((resolve) => { firstWriteStarted = resolve })
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve })
    const harness = await createOwnershipHarness({
      writeIndex: async (indexPath, records) => {
        writes += 1
        if (writes === 1) {
          firstWriteStarted()
          await firstWriteGate
        }
        await fs.writeFile(indexPath, JSON.stringify(records, null, 2))
      },
    })
    t.after(async () => {
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })

    const first = harness.manager.start(WORKSPACE_ID, "first", "ignored")
    await firstWrite
    const second = harness.manager.start(WORKSPACE_ID, "second", "ignored")
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFirstWrite()
    await Promise.all([first, second])

    const records = await harness.manager.list(WORKSPACE_ID)
    assert.equal(records.length, 2)
    assert.deepEqual(new Set(records.map((record) => record.title)), new Set(["first", "second"]))
  })

  it("keeps containment timers referenced and clears both after exit", async (t) => {
    const created: NodeJS.Timeout[] = []
    const cleared = new Set<NodeJS.Timeout>()
    const harness = await createOwnershipHarness({
      setTimeoutFn: ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
        const handle = setTimeout(callback, delay, ...args)
        created.push(handle)
        return handle
      }) as typeof setTimeout,
      clearTimeoutFn: ((handle: NodeJS.Timeout) => {
        cleared.add(handle)
        clearTimeout(handle)
      }) as typeof clearTimeout,
    })
    t.after(async () => {
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })
    const processRecord = await harness.manager.start(WORKSPACE_ID, "timer-child", "ignored")

    await harness.manager.stop(WORKSPACE_ID, processRecord.id)

    assert.equal(created.length, 2)
    assert.ok(created.every((handle) => handle.hasRef()))
    assert.deepEqual(cleared, new Set(created))
  })

  it("handles event cleanup rejection and makes shutdown await the concrete failure", async (t) => {
    const harness = await createOwnershipHarness({
      exitOnKill: false,
      stopTimeoutMs: 5,
      exitWaitTimeoutMs: 15,
    })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))
    await harness.manager.start(WORKSPACE_ID, "stubborn", "ignored")

    harness.eventBus.publish({ type: "workspace.stopped", workspaceId: WORKSPACE_ID })
    const warningDeadline = Date.now() + 500
    while (!harness.warnings.includes("Background process workspace cleanup failed") && Date.now() < warningDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }

    assert.ok(harness.warnings.includes("Background process workspace cleanup failed"))
    assert.equal((await harness.manager.list(WORKSPACE_ID))[0]?.status, "running")
    await assert.rejects(harness.manager.shutdown(), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /shutdown failed/)
      return true
    })
    await assert.rejects(
      harness.manager.start(WORKSPACE_ID, "late", "ignored"),
      /shutting down/,
    )
  })

  it("refuses to forge a stopped state without live coordinator ownership", async (t) => {
    const harness = await createOwnershipHarness()
    t.after(async () => {
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })
    const indexDir = path.join(harness.workspacePath, ".saiwork", "background_processes", WORKSPACE_ID)
    await fs.mkdir(indexDir, { recursive: true })
    await fs.writeFile(path.join(indexDir, "index.json"), JSON.stringify([{
      id: "proc_unowned",
      workspaceId: WORKSPACE_ID,
      title: "unowned",
      command: "ignored",
      cwd: harness.workspacePath,
      status: "running",
      pid: 49_999,
      startedAt: new Date().toISOString(),
      outputSizeBytes: 0,
    }]))

    await assert.rejects(
      harness.manager.stop(WORKSPACE_ID, "proc_unowned"),
      BackgroundProcessOwnershipError,
    )
    assert.equal((await harness.manager.list(WORKSPACE_ID))[0]?.status, "running")
  })

  it("falls back to the exact direct child when Windows taskkill returns status 1", async (t) => {
    const taskkillCalls: any[][] = []
    const harness = await createOwnershipHarness({
      platform: "win32",
      useInjectedKill: false,
      spawnSyncProcess: (...args: any[]) => {
        taskkillCalls.push(args)
        return { status: 1, signal: null, output: [], pid: 1, stdout: null, stderr: null }
      },
    })
    t.after(async () => {
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })
    const processRecord = await harness.manager.start(WORKSPACE_ID, "windows-child", "ignored")

    await harness.manager.stop(WORKSPACE_ID, processRecord.id)

    assert.equal(taskkillCalls.length, 1)
    assert.deepEqual(taskkillCalls[0]?.slice(0, 2), ["taskkill", ["/PID", String(harness.children[0]?.pid), "/T"]])
    assert.deepEqual(harness.children[0]?.killCalls, ["SIGTERM"])
    assert.ok(harness.warnings.includes("Windows taskkill failed; falling back to the direct child"))
  })
})
