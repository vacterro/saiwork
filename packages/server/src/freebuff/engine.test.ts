import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"

import {
  defaultWaitForReady,
  FreebuffEngineManager,
  type FreebuffEngineOptions,
  type FreebuffLaunchIdentity,
} from "./engine"
import type { FreebuffInstall } from "./install"
import type { FreebuffShellLifetime } from "./shell-lifetime"

const INSTALL: FreebuffInstall = {
  root: "C:/freebuff",
  bunPath: "C:/freebuff/resources/bun/bun.exe",
  orchestratorPath: "C:/freebuff/resources/orchestrator/orchestrator.js",
  version: "0.0.61",
  auth: { token: "tok", user: { id: "u1", email: "dev@example.com" } },
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: Array<NodeJS.Signals | number | undefined> = []
  readonly stdinChunks: Buffer[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  constructor(readonly pid: number, private readonly exitsOnKill = true) {
    super()
    this.stdin.on("data", (chunk: Buffer) => this.stdinChunks.push(Buffer.from(chunk)))
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    this.signals.push(signal)
    if (this.exitsOnKill) this.close(signal === "SIGKILL" ? 137 : 0, typeof signal === "string" ? signal : null)
    return true
  }

  close(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
    this.emit("close", code, signal)
  }

  get stdinText(): string {
    return Buffer.concat(this.stdinChunks).toString("utf8")
  }
}

interface SpawnCapture {
  command: string
  args: string[]
  options: Parameters<NonNullable<FreebuffEngineOptions["spawn"]>>[2]
  child: FakeChild
}

function fakeLifetime(overrides: Partial<FreebuffShellLifetime> = {}): FreebuffShellLifetime & { closes: number; disconnects: number } {
  const state = {
    port: 29_991,
    token: "one-time-shell-secret",
    closes: 0,
    disconnects: 0,
    disconnectClients() {
      state.disconnects += 1
      overrides.disconnectClients?.()
    },
    async close() {
      state.closes += 1
      await overrides.close?.()
    },
  }
  return state
}

const logger = { info() {}, warn() {}, error() {}, debug() {} }

function createManager(overrides: Partial<FreebuffEngineOptions> = {}): FreebuffEngineManager {
  return new FreebuffEngineManager({
    logger: logger as never,
    locate: () => INSTALL,
    readyTimeoutMs: 80,
    probeIntervalMs: 1,
    forceStopWaitMs: 10,
    stopGraceMs: 10,
    startupTimeoutRetries: 0,
    randomLaunchId: () => "launch-owned-by-saiwork",
    ...overrides,
  })
}

function announce(capture: SpawnCapture, port: number): void {
  capture.child.stdout.write(`[orchestrator-ready] ${JSON.stringify({
    launchId: capture.options.env.FREEBUFF_LAUNCH_ID,
    pid: capture.child.pid,
    port,
  })}\n`)
}

describe("FreebuffEngineManager Desktop contract", () => {
  it("uses PORT=0, installed version, launch identity, piped token, and bound health", async () => {
    const captures: SpawnCapture[] = []
    const lifetime = fakeLifetime()
    let probed: FreebuffLaunchIdentity | null = null
    const engine = createManager({
      createLifetime: async () => lifetime,
      spawn: (command, args, options) => {
        const capture = { command, args, options, child: new FakeChild(4_201) }
        captures.push(capture)
        queueMicrotask(() => announce(capture, 31_337))
        return capture.child as unknown as ChildProcess
      },
      healthProbe: async (identity) => {
        probed = identity
        return true
      },
    })

    const status = await engine.start()
    assert.equal(captures.length, 1)
    const capture = captures[0]!
    assert.equal(capture.command, INSTALL.bunPath)
    assert.deepEqual(capture.args, [INSTALL.orchestratorPath])
    assert.deepEqual(capture.options.stdio, ["pipe", "pipe", "pipe"])
    assert.equal(capture.options.env.PORT, "0")
    assert.equal(capture.options.env.FREEBUFF_LAUNCH_ID, "launch-owned-by-saiwork")
    assert.equal(capture.options.env.FREEBUFF_SHELL_LIFETIME_PORT, String(lifetime.port))
    assert.equal(capture.options.env.FREEBUFF_PROFILE_LOCK_WAIT_MS, "10000")
    assert.equal(capture.options.env.FREEBUFF_APP_VERSION, "0.0.61")
    assert.equal(capture.options.env.SAIWORK_FREEBUFF_COORDINATOR, "1")
    assert.equal(capture.options.env.FREEBUFF_SIGNING_STATE, undefined)
    assert.equal(capture.options.env.FREEBUFF_SIGNING_TEAM, undefined)
    assert.equal(capture.child.stdinText, `${lifetime.token}\n`)
    assert.deepEqual(probed, { launchId: "launch-owned-by-saiwork", pid: 4_201, port: 31_337 })
    assert.equal(status.ready, true)
    assert.equal(status.port, 31_337)
    assert.equal(status.coordinator, "saiwork")
    assert.equal(status.desktopVersion, "0.0.61")
    await engine.stop()
    assert.equal(lifetime.closes, 1)
  })

  it("coalesces concurrent starts into one child", async () => {
    const health = deferred<boolean>()
    let spawns = 0
    let child!: FakeChild
    const engine = createManager({
      createLifetime: async () => fakeLifetime(),
      spawn: (command, args, options) => {
        spawns += 1
        child = new FakeChild(4_202)
        const capture = { command, args, options, child }
        queueMicrotask(() => announce(capture, 31_338))
        return child as unknown as ChildProcess
      },
      healthProbe: async () => health.promise,
    })

    const starts = [engine.start(), engine.start(), engine.start()]
    await tick()
    assert.equal(spawns, 1)
    health.resolve(true)
    const statuses = await Promise.all(starts)
    assert.ok(statuses.every((status) => status.ready))
    assert.equal(spawns, 1)
    await engine.stop()
  })

  it("ignores forged readiness and only probes the owned PID and launch", async () => {
    const identities: FreebuffLaunchIdentity[] = []
    let capture!: SpawnCapture
    const engine = createManager({
      createLifetime: async () => fakeLifetime(),
      spawn: (command, args, options) => {
        capture = { command, args, options, child: new FakeChild(4_203) }
        queueMicrotask(() => {
          capture.child.stdout.write(`[orchestrator-ready] ${JSON.stringify({ launchId: "foreign", pid: 9_999, port: 31_339 })}\n`)
          announce(capture, 31_340)
        })
        return capture.child as unknown as ChildProcess
      },
      healthProbe: async (identity) => {
        identities.push(identity)
        return true
      },
    })

    const status = await engine.start()
    assert.equal(status.port, 31_340)
    assert.deepEqual(identities, [{ launchId: "launch-owned-by-saiwork", pid: 4_203, port: 31_340 }])
    await engine.stop()
  })

  it("kills and reaps a child that never announces readiness", async () => {
    const lifetime = fakeLifetime()
    const child = new FakeChild(4_204)
    const engine = createManager({
      readyTimeoutMs: 15,
      createLifetime: async () => lifetime,
      spawn: () => child as unknown as ChildProcess,
      healthProbe: async () => true,
    })

    const status = await engine.start()
    assert.equal(status.ready, false)
    assert.equal(status.engineRunning, false)
    assert.match(status.error ?? "", /announce readiness/)
    assert.deepEqual(child.signals, ["SIGKILL"])
    assert.equal(lifetime.disconnects, 1)
    assert.equal(lifetime.closes, 1)
  })

  it("contains a startup output-stream failure instead of crashing the server", async () => {
    const child = new FakeChild(4_205)
    const engine = createManager({
      createLifetime: async () => fakeLifetime(),
      spawn: () => {
        queueMicrotask(() => child.stdout.emit("error", new Error("broken stdout")))
        return child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })
    const status = await engine.start()
    assert.equal(status.engineRunning, false)
    assert.match(status.error ?? "", /stdout stream failed/)
    assert.deepEqual(child.signals, ["SIGKILL"])
  })

  it("cancels an in-flight start during stop and leaves no stale error", async () => {
    const lifetime = fakeLifetime()
    const child = new FakeChild(4_206)
    const engine = createManager({
      readyTimeoutMs: 500,
      createLifetime: async () => lifetime,
      spawn: () => child as unknown as ChildProcess,
      healthProbe: async () => true,
    })
    const starting = engine.start()
    await tick()
    await Promise.all([starting, engine.stop()])
    assert.equal(engine.status.engineRunning, false)
    assert.equal(engine.status.ready, false)
    assert.equal(engine.status.error, null)
    assert.equal(lifetime.closes, 1)
  })

  it("retries an initial timeout once only after the failed child is gone", async () => {
    const captures: SpawnCapture[] = []
    const engine = createManager({
      readyTimeoutMs: 12,
      startupTimeoutRetries: 1,
      createLifetime: async () => fakeLifetime(),
      spawn: (command, args, options) => {
        const capture = { command, args, options, child: new FakeChild(4_210 + captures.length) }
        captures.push(capture)
        if (captures.length === 2) queueMicrotask(() => announce(capture, 31_341))
        return capture.child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })

    const status = await engine.start()
    assert.equal(status.ready, true)
    assert.equal(captures.length, 2)
    assert.equal(captures[0]!.child.exitCode, 137)
    assert.equal(captures[0]!.options.env.PORT, "0")
    assert.equal(captures[1]!.options.env.PORT, "0")
    await engine.stop()
  })

  it("restarts a crashed child on the same port with a fresh identity", async () => {
    const captures: SpawnCapture[] = []
    let launchSequence = 0
    const engine = createManager({
      createLifetime: async () => fakeLifetime(),
      randomLaunchId: () => `launch-${++launchSequence}`,
      spawn: (command, args, options) => {
        const capture = { command, args, options, child: new FakeChild(4_220 + captures.length) }
        captures.push(capture)
        queueMicrotask(() => announce(capture, options.env.PORT === "0" ? 31_342 : Number(options.env.PORT)))
        return capture.child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })

    assert.equal((await engine.start()).ready, true)
    captures[0]!.child.close(1)
    await waitUntil(() => captures.length === 2 && engine.status.ready)
    assert.equal(captures[1]!.options.env.PORT, "31342")
    assert.equal(captures[0]!.options.env.FREEBUFF_LAUNCH_ID, "launch-1")
    assert.equal(captures[1]!.options.env.FREEBUFF_LAUNCH_ID, "launch-2")
    assert.equal(engine.status.port, 31_342)
    await engine.stop()
  })

  it("bounds a crash loop to three same-port respawns and closes lifetime state", async () => {
    const captures: SpawnCapture[] = []
    const lifetime = fakeLifetime()
    const engine = createManager({
      readyTimeoutMs: 10,
      restartLimit: 3,
      createLifetime: async () => lifetime,
      spawn: (command, args, options) => {
        const capture = { command, args, options, child: new FakeChild(4_230 + captures.length) }
        captures.push(capture)
        if (captures.length === 1) queueMicrotask(() => announce(capture, 31_343))
        return capture.child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })

    await engine.start()
    captures[0]!.child.close(1)
    await waitUntil(() => /recovery exhausted/.test(engine.status.error ?? ""), 500)
    assert.equal(captures.length, 4)
    assert.deepEqual(captures.slice(1).map((capture) => capture.options.env.PORT), ["31343", "31343", "31343"])
    assert.equal(engine.status.engineRunning, false)
    assert.equal(engine.status.port, null)
    assert.equal(lifetime.closes, 1)
  })

  it("uses lifetime close for graceful Windows shutdown before any forced kill", async () => {
    let child!: FakeChild
    const lifetime = fakeLifetime({
      close: async () => child.close(0),
    })
    const engine = createManager({
      platform: "win32",
      createLifetime: async () => lifetime,
      spawn: (command, args, options) => {
        child = new FakeChild(4_240)
        const capture = { command, args, options, child }
        queueMicrotask(() => announce(capture, 31_344))
        return child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })

    await engine.start()
    await engine.stop()
    assert.equal(lifetime.closes, 1)
    assert.deepEqual(child.signals, [])
    assert.equal(engine.status.engineRunning, false)
    assert.equal(engine.status.port, null)
  })

  it("starts cleanly again after a complete SAIWORK stop", async () => {
    const captures: SpawnCapture[] = []
    const lifetimes: ReturnType<typeof fakeLifetime>[] = []
    const engine = createManager({
      createLifetime: async () => {
        const lifetime = fakeLifetime()
        lifetimes.push(lifetime)
        return lifetime
      },
      spawn: (command, args, options) => {
        const capture = { command, args, options, child: new FakeChild(4_242 + captures.length) }
        captures.push(capture)
        queueMicrotask(() => announce(capture, 31_350 + captures.length))
        return capture.child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })
    assert.equal((await engine.start()).ready, true)
    await engine.stop()
    assert.equal((await engine.start()).ready, true)
    await engine.stop()
    assert.equal(captures.length, 2)
    assert.equal(lifetimes.length, 2)
    assert.deepEqual(lifetimes.map((lifetime) => lifetime.closes), [1, 1])
  })

  it("contains an unexpected lifetime-server failure and retains its cause", async () => {
    let failLifetime!: (error: Error) => void
    let child!: FakeChild
    const engine = createManager({
      platform: "linux",
      createLifetime: async (onFailure) => {
        failLifetime = onFailure
        return fakeLifetime()
      },
      spawn: (command, args, options) => {
        child = new FakeChild(4_244)
        const capture = { command, args, options, child }
        queueMicrotask(() => announce(capture, 31_355))
        return child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })
    await engine.start()
    failLifetime(new Error("listener failed"))
    await waitUntil(() => !engine.status.engineRunning && /listener failed/.test(engine.status.error ?? ""))
    assert.equal(child.exitCode, 0)
  })

  it("never reports stopped when even forced shutdown cannot contain the owned child", async () => {
    let child!: FakeChild
    const engine = createManager({
      platform: "win32",
      stopGraceMs: 5,
      forceStopWaitMs: 5,
      createLifetime: async () => fakeLifetime(),
      spawn: (command, args, options) => {
        child = new FakeChild(4_245, false)
        const capture = { command, args, options, child }
        queueMicrotask(() => announce(capture, 31_346))
        return child as unknown as ChildProcess
      },
      healthProbe: async () => true,
    })
    await engine.start()
    await assert.rejects(engine.stop(), /did not exit/)
    assert.equal(engine.status.engineRunning, true)
    assert.equal(engine.status.ready, false)
    assert.equal(engine.status.port, 31_346)
    child.close(137, "SIGKILL")
    await engine.stop()
    assert.equal(engine.status.engineRunning, false)
  })

  it("refuses to start when the installed Desktop version is unverifiable", async () => {
    let spawned = false
    const engine = createManager({
      locate: () => ({ ...INSTALL, version: null }),
      spawn: () => {
        spawned = true
        return new FakeChild(4_250) as unknown as ChildProcess
      },
    })
    const status = await engine.start()
    assert.equal(spawned, false)
    assert.match(status.error ?? "", /version could not be verified/)
  })
})

describe("defaultWaitForReady", () => {
  it("requires the launch header and exact PID, launch, and port response", async () => {
    const originalFetch = globalThis.fetch
    let request: { url: string; headers: Headers } | null = null
    globalThis.fetch = (async (input, init) => {
      request = { url: String(input), headers: new Headers(init?.headers) }
      return new Response(JSON.stringify({ ok: true, launchId: "bound-launch", pid: 8_001, port: 31_345 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    try {
      const identity = { launchId: "bound-launch", pid: 8_001, port: 31_345 }
      assert.equal(await defaultWaitForReady(identity, new AbortController().signal), true)
      assert.equal(request!.url, "http://127.0.0.1:31345/healthz")
      assert.equal(request!.headers.get("x-freebuff-launch-id"), "bound-launch")
      assert.equal(await defaultWaitForReady({ ...identity, pid: 8_002 }, new AbortController().signal), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
