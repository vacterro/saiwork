import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { EventEmitter } from "node:events"
import { promises as fs } from "node:fs"
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
  onSpawn: (child: ChildProcess, outputWriter: FakeOutputWriter) => void
  writeIndex?: (indexPath: string, records: any[]) => Promise<void>
  spawnThrows?: boolean
}

class FakeOutputWriter {
  destroyed = false
  closed = false
  droppedBytes = 0
  private onError?: (error: unknown) => void

  constructor(_outputPath: string) {}

  setOnError(onError?: (error: unknown) => void) {
    this.onError = onError
  }

  enqueue(_data: Buffer) {}

  fail(error: unknown) {
    this.onError?.(error)
  }

  async close() {
    this.closed = true
  }

  async destroy() {
    this.destroyed = true
  }
}

function createFakeChild(): ChildProcess {
  const child: any = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = null
  child.pid = 42000
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
  const outputWriter = new FakeOutputWriter(path.join(workspacePath, "output.txt"))
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
          options.onSpawn(child, outputWriter)
          return child
        }) as any,
    createOutputWriter: ((_outputPath: string, options: any) => {
      outputWriter.setOnError(options.onError)
      return outputWriter
    }) as any,
    writeIndex: options.writeIndex,
    killProcess: (target) => {
      ;(target as any).killed = true
    },
  })

  return { manager, child, outputWriter, terminal, updates, warnings, workspacePath }
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

  it("stops and finalizes after an output writer error", { timeout: TERMINAL_TIMEOUT_MS }, async (t) => {
    const harness = await createFailureHarness({
      onSpawn: (_child, outputWriter) => {
        queueMicrotask(() => outputWriter.fail(new Error("injected output failure")))
      },
    })
    t.after(() => fs.rm(harness.workspacePath, { recursive: true, force: true }))

    const started = await harness.manager.start(WORKSPACE_ID, "output-failure", "ignored")
    assert.equal(started.status, "running")
    assert.equal(harness.child.killed, true)
    assert.equal(harness.outputWriter.destroyed, true)
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
    assert.equal(harness.outputWriter.destroyed, true)
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

describe("BackgroundProcessManager structural index validation", () => {
  const validRecord = (overrides: Record<string, unknown> = {}) => ({
    id: "proc_20260814_test",
    workspaceId: WORKSPACE_ID,
    title: "test",
    command: "echo hi",
    cwd: "/work",
    status: "stopped",
    startedAt: "2026-08-14T00:00:00.000Z",
    outputSizeBytes: 0,
    ...overrides,
  })

  async function seedIndex(workspacePath: string, records: unknown[]) {
    const indexDir = path.join(workspacePath, ".saiwork", "background_processes", WORKSPACE_ID)
    await fs.mkdir(indexDir, { recursive: true })
    const indexPath = path.join(indexDir, "index.json")
    const content = JSON.stringify(records)
    await fs.writeFile(indexPath, content)
    return { indexPath, content }
  }

  async function assertFailsClosed(records: unknown[], problem: RegExp) {
    const harness = await createFailureHarness({ onSpawn: () => {} })
    const { indexPath, content } = await seedIndex(harness.workspacePath, records)
    try {
      await assert.rejects(
        harness.manager.start(WORKSPACE_ID, "invalid-index", "ignored"),
        (error: unknown) => {
          assert.ok(error instanceof BackgroundProcessIndexError, `expected BackgroundProcessIndexError, got ${String(error)}`)
          assert.match(error.message, problem)
          return true
        },
      )
      assert.equal(await fs.readFile(indexPath, "utf-8"), content, "invalid index bytes must never be rewritten")
    } finally {
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    }
  }

  it("accepts an empty index", async () => {
    const harness = await createFailureHarness({ onSpawn: () => {} })
    try {
      await seedIndex(harness.workspacePath, [])
      const records = await harness.manager.list(WORKSPACE_ID)
      assert.deepEqual(records, [])
    } finally {
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    }
  })

  it("rejects [{}] as structurally corrupt", async () => {
    await assertFailsClosed([{}], /id is not a safe identifier/)
  })

  it("rejects a non-object id", async () => {
    await assertFailsClosed([validRecord({ id: 123 })], /id is not a safe identifier/)
  })

  it("rejects a path-like hostile id", async () => {
    await assertFailsClosed([validRecord({ id: "../../etc/passwd" })], /id is not a safe identifier/)
  })

  it("rejects duplicate ids", async () => {
    await assertFailsClosed([validRecord(), validRecord()], /duplicate process id/)
  })

  it("rejects a workspace mismatch", async () => {
    await assertFailsClosed([validRecord({ workspaceId: "other-ws" })], /does not match/)
  })

  it("rejects invalid status and invalid pid", async () => {
    await assertFailsClosed([validRecord({ status: "banana" })], /invalid status/)
    await assertFailsClosed([validRecord({ status: "running" })], /running process requires a positive integer pid/)
    await assertFailsClosed([validRecord({ status: "running", pid: -4 })], /running process requires a positive integer pid/)
  })

  it("accepts a historical record with optional fields intact", async () => {
    const harness = await createFailureHarness({ onSpawn: () => {} })
    try {
      await seedIndex(harness.workspacePath, [
        validRecord({
          status: "running",
          pid: 1234,
          outputDroppedBytes: 512,
          notify: { sessionID: "sess-1", directory: "/work/.saiwork" },
          terminalReason: "user_stopped",
        }),
      ])
      const records = await harness.manager.list(WORKSPACE_ID)
      assert.equal(records.length, 1)
      assert.equal(records[0].id, "proc_20260814_test")
    } finally {
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    }
  })

  it("preserves the existing index and rejects when the index write fails", async () => {
    const harness = await createFailureHarness({
      onSpawn: () => {},
      writeIndex: async () => {
        throw new Error("injected atomic index write failure")
      },
    })
    try {
      const { indexPath, content } = await seedIndex(harness.workspacePath, [validRecord()])
      await assert.rejects(
        harness.manager.start(WORKSPACE_ID, "write-fails", "ignored"),
        /injected atomic index write failure/,
      )
      assert.equal(await fs.readFile(indexPath, "utf-8"), content, "old index must stay authoritative on a failed write")
      assert.equal(harness.child.killed, true, "the child must not be left running when persistence fails")
    } finally {
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    }
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

  it("bounds a hanging Windows taskkill and falls back to the exact child", async (t) => {
    const taskkillCalls: any[][] = []
    const harness = await createOwnershipHarness({
      platform: "win32",
      useInjectedKill: false,
      spawnSyncProcess: (...args: any[]) => {
        taskkillCalls.push(args)
        const timeoutOption = (args[2] as Record<string, unknown> | undefined)?.timeout
        assert.ok(typeof timeoutOption === "number" && timeoutOption > 0, "taskkill must carry a bounded timeout")
        return {
          status: null,
          signal: null,
          output: [],
          pid: 1,
          stdout: null,
          stderr: null,
          error: { code: "ETIMEDOUT", message: "spawn taskkill ETIMEDOUT", errno: -2, syscall: "spawn", path: "taskkill", spawnargs: [] },
        }
      },
    })
    t.after(async () => {
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })
    const processRecord = await harness.manager.start(WORKSPACE_ID, "hanging-taskkill", "ignored")

    await harness.manager.stop(WORKSPACE_ID, processRecord.id)

    assert.equal(taskkillCalls.length, 1)
    assert.ok(harness.warnings.some((message) => message.includes("taskkill timed out")))
    assert.deepEqual(harness.children[0]?.killCalls, ["SIGTERM"], "the exact owned child is signalled after the timeout")
  })
})

const OUTPUT_CAP_BYTES = 512 * 1024
const OUTPUT_READ_HARD_CAP = 4 * 1024 * 1024

async function createOutputHarness(options: { outputStreamIntervalMs?: number } = {}) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "bp-output-test-"))
  const child = createFakeChild() as any
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    child.killed = true
    queueMicrotask(() => child.emit("close", null, signal))
    return true
  }
  const updates: any[] = []
  const eventBus = {
    on: () => {},
    off: () => {},
    publish: (event: any) => {
      const processRecord = event?.event?.properties?.process
      if (processRecord) updates.push(processRecord)
      return true
    },
  } as unknown as EventBus
  const logger = {
    warn: () => {},
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
    spawnProcess: (() => child) as any,
    outputStreamIntervalMs: options.outputStreamIntervalMs,
  })
  return { manager, child, updates, workspacePath, raw: undefined as EventEmitter | undefined }
}

function outputPathFor(workspacePath: string, processId: string) {
  return path.join(workspacePath, ".saiwork", "background_processes", WORKSPACE_ID, processId, "output.txt")
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out")
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

describe("BackgroundProcessManager bounded output", () => {
  it("keeps a chatty child's on-disk output within the cap and reports dropped bytes", { timeout: 15000 }, async (t) => {
    const harness = await createOutputHarness()
    t.after(async () => {
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })

    const processRecord = await harness.manager.start(WORKSPACE_ID, "chatty", "ignored")
    const chunk = Buffer.alloc(512, 0x61)
    for (let i = 0; i < 2600; i += 1) {
      harness.child.stdout.write(chunk)
    }

    await waitFor(() => harness.updates.some((record) => record.outputDroppedBytes > 0))

    const published = harness.updates.find((record) => record.outputDroppedBytes > 0)
    assert.ok(published.outputDroppedBytes > 0)
    assert.ok(published.outputSizeBytes <= OUTPUT_CAP_BYTES, `retained size ${published.outputSizeBytes} exceeds cap`)

    const onDisk = await fs.stat(outputPathFor(harness.workspacePath, processRecord.id))
    assert.ok(onDisk.size <= OUTPUT_CAP_BYTES, `disk size ${onDisk.size} exceeds cap`)

    const output = await harness.manager.readOutput(WORKSPACE_ID, processRecord.id, {})
    assert.ok(output.content.length > 0)
    assert.ok(output.content.length <= OUTPUT_CAP_BYTES)
    assert.equal(output.content[output.content.length - 1], "a")
  })

  it("emits a truncate event and resumes from the retained tail after rotation", { timeout: 15000 }, async (t) => {
    const harness = await createOutputHarness({ outputStreamIntervalMs: 10 })
    t.after(async () => {
      harness.raw?.emit("close")
      await harness.manager.shutdown()
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    })

    const processRecord = await harness.manager.start(WORKSPACE_ID, "streaming", "ignored")
    const chunks: string[] = []
    const raw = new EventEmitter() as any
    raw.setHeader = () => {}
    raw.flushHeaders = () => {}
    raw.end = () => {}
    raw.write = (value: string) => { chunks.push(String(value)) }
    const reply: any = {
      raw,
      code: () => reply,
      send: () => {},
      hijack: () => {},
    }
    harness.raw = raw

    const chunk = Buffer.alloc(512, 0x61)
    for (let i = 0; i < 60; i += 1) {
      harness.child.stdout.write(chunk)
    }
    const outputPath = outputPathFor(harness.workspacePath, processRecord.id)
    await waitFor(async () => {
      try {
        await fs.stat(outputPath)
        return true
      } catch {
        return false
      }
    })

    await harness.manager.streamOutput(WORKSPACE_ID, processRecord.id, reply)
    for (let i = 0; i < 20; i += 1) {
      harness.child.stdout.write(chunk)
    }
    await waitFor(() => chunks.some((value) => value.includes('"type":"chunk"')))

    for (let i = 0; i < 2600; i += 1) {
      harness.child.stdout.write(chunk)
    }
    await waitFor(() => chunks.some((value) => value.includes('"type":"truncate"')), 8000)

    assert.ok(chunks.some((value) => value.includes('"type":"truncate"')))
  })
})

describe("BackgroundProcessManager output read bounds", () => {
  async function seedOutputFile(harness: Awaited<ReturnType<typeof createOutputHarness>>, content: Buffer) {
    const outputPath = path.join(
      harness.workspacePath,
      ".saiwork",
      "background_processes",
      WORKSPACE_ID,
      "proc_fixed",
      "output.txt",
    )
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, content)
    return outputPath
  }

  it("honors maxBytes=1 and clamps an attacker maxBytes to the hard cap", async () => {
    const harness = await createOutputHarness()
    try {
      const content = Buffer.alloc(OUTPUT_READ_HARD_CAP + 1024, 0x61)
      await seedOutputFile(harness, content)

      const tiny = await harness.manager.readOutput(WORKSPACE_ID, "proc_fixed", { maxBytes: 1 })
      assert.ok(tiny.content.length <= 1, `maxBytes=1 read must stay bounded, got ${tiny.content.length}`)
      assert.equal(tiny.truncated, true)

      const attacker = await harness.manager.readOutput(WORKSPACE_ID, "proc_fixed", { maxBytes: OUTPUT_READ_HARD_CAP + 1 })
      assert.ok(attacker.content.length <= OUTPUT_READ_HARD_CAP, "hard cap must win over client input")
      assert.equal(attacker.truncated, true)

      const atCap = await harness.manager.readOutput(WORKSPACE_ID, "proc_fixed", { maxBytes: OUTPUT_READ_HARD_CAP })
      assert.ok(atCap.content.length <= OUTPUT_READ_HARD_CAP)
    } finally {
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    }
  })

  it("bounds a huge legacy file read when maxBytes is omitted", async () => {
    const harness = await createOutputHarness()
    try {
      const content = Buffer.alloc(2 * 1024 * 1024, 0x62)
      await seedOutputFile(harness, content)
      const result = await harness.manager.readOutput(WORKSPACE_ID, "proc_fixed", {})
      assert.ok(result.content.length <= OUTPUT_CAP_BYTES, `default read must stay within the log cap`)
      assert.equal(result.truncated, true)
    } finally {
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    }
  })

  it("never starts a truncated tail with a UTF-8 replacement character", async () => {
    const harness = await createOutputHarness()
    try {
      const emoji = Buffer.from("😀")
      const prefix = Buffer.from("HEAD")
      const rebuilt = Buffer.concat([prefix, ...Array.from({ length: 1000 }, () => emoji)])
      await seedOutputFile(harness, rebuilt)

      // Window of 5 bytes lands at [..80][F0 9F 98 80]: one leading
      // continuation byte, then a complete emoji. It must decode to "😀"
      // with no leading U+FFFD.
      const result = await harness.manager.readOutput(WORKSPACE_ID, "proc_fixed", { maxBytes: 5 })
      assert.equal(result.content.startsWith("\uFFFD"), false, "truncated tail must not begin with U+FFFD")
      assert.equal(result.content, "😀")

      const cyrillic = Buffer.from("АБВГД😀ежз")
      await seedOutputFile(harness, cyrillic)
      const cut = await harness.manager.readOutput(WORKSPACE_ID, "proc_fixed", { maxBytes: 3 })
      assert.equal(cut.content.startsWith("\uFFFD"), false, "Cyrillic tail cut mid-codepoint must not start with U+FFFD")
    } finally {
      await fs.rm(harness.workspacePath, { recursive: true, force: true })
    }
  })
})
