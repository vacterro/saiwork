import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync } from "node:fs"
import path from "node:path"

import type { Logger } from "../logger"
import { locateFreebuffInstall, type FreebuffInstall } from "./install"
import {
  createFreebuffShellLifetimeServer,
  type FreebuffShellLifetime,
} from "./shell-lifetime"
import type { FreebuffAuthState } from "./types"

export interface FreebuffLaunchIdentity {
  launchId: string
  pid: number
  port: number
}

interface FreebuffSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ["pipe", "pipe", "pipe"]
}

export interface FreebuffEngineOptions {
  logger: Logger
  /** Resolve the genuine Desktop engine install. */
  locate?: () => FreebuffInstall | null
  /** Initial requested port. Production uses 0; crash restarts reuse the announced port. */
  port?: number
  spawn?: (command: string, args: string[], options: FreebuffSpawnOptions) => ChildProcess
  healthProbe?: (identity: FreebuffLaunchIdentity, signal: AbortSignal) => Promise<boolean>
  createLifetime?: (onFailure: (error: Error) => void) => Promise<FreebuffShellLifetime>
  randomLaunchId?: () => string
  readyTimeoutMs?: number
  probeIntervalMs?: number
  stopGraceMs?: number
  forceStopWaitMs?: number
  restartLimit?: number
  restartStableMs?: number
  startupTimeoutRetries?: number
  now?: () => number
  platform?: NodeJS.Platform
}

export interface FreebuffEngineStatus {
  installFound: boolean
  engineRunning: boolean
  ready: boolean
  port: number | null
  root: string | null
  auth: FreebuffAuthState | null
  error: string | null
  /** Makes wrapper ownership explicit; SAIWORK never claims Electron signing identity. */
  coordinator: "saiwork"
  desktopVersion: string | null
}

type ReadyAnnouncement = FreebuffLaunchIdentity

interface Launch {
  child: ChildProcess
  launchId: string
  requestedPort: number
  preservePortOnFailure: boolean
  ready: boolean
  expectedStop: boolean
  closed: boolean
  failure: EngineLaunchError | null
  abort: AbortController
  announcement: Promise<ReadyAnnouncement>
  resolveAnnouncement: (announcement: ReadyAnnouncement) => void
  stdoutBuffer: string
  onStdout: (chunk: Buffer | string) => void
  onStderr: (chunk: Buffer | string) => void
  onStdoutError: (error: Error) => void
  onStderrError: (error: Error) => void
}

type LaunchFailureKind = "spawn" | "exit" | "timeout" | "cleanup" | "lifetime" | "version"

class EngineLaunchError extends Error {
  constructor(
    readonly kind: LaunchFailureKind,
    message: string,
  ) {
    super(message)
    this.name = "FreebuffEngineLaunchError"
  }
}

const FREEBUFF_ENGINE_READY_TIMEOUT_MS = 30_000
const FREEBUFF_ENGINE_HEALTH_PROBE_TIMEOUT_MS = 1_500
const FREEBUFF_ENGINE_STOP_GRACE_MS = 3_000
const FREEBUFF_ENGINE_FORCE_STOP_WAIT_MS = 500
const FREEBUFF_ENGINE_RESTART_LIMIT = 3
const FREEBUFF_ENGINE_RESTART_STABLE_MS = 60_000
const MAX_STDOUT_BUFFER_BYTES = 64 * 1024

/**
 * Owns exactly one genuine FreeBuff Desktop orchestrator and its authenticated
 * shell-lifetime channel. It never scans for, attaches to, or impersonates an
 * unrelated Desktop process.
 */
export class FreebuffEngineManager {
  private child: ChildProcess | null = null
  private launch: Launch | null = null
  private lifetime: FreebuffShellLifetime | null = null
  private install: FreebuffInstall | null = null
  private enginePort: number | null = null
  private ready = false
  private startError: string | null = null
  private lifecyclePromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private shutdownRequested = false
  private restartAttempts = 0
  private lastSpawnAt = 0
  private readonly statusListeners = new Set<(status: FreebuffEngineStatus) => void>()
  private readonly options: FreebuffEngineOptions

  constructor(options: FreebuffEngineOptions) {
    this.options = options
  }

  get status(): FreebuffEngineStatus {
    const running = isChildRunning(this.child)
    if (this.install === null && !running) {
      this.install = (this.options.locate ?? locateFreebuffInstall)()
    }
    return {
      installFound: this.install !== null,
      engineRunning: running,
      ready: this.ready && running,
      port: this.enginePort,
      root: this.install?.root ?? null,
      auth: this.install?.auth ?? null,
      error: this.startError,
      coordinator: "saiwork",
      desktopVersion: this.install?.version ?? null,
    }
  }

  onStatusChange(listener: (status: FreebuffEngineStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  async start(): Promise<FreebuffEngineStatus> {
    if (this.stopPromise) await this.stopPromise
    if (this.ready && isChildRunning(this.child)) return this.status
    if (this.lifecyclePromise) {
      await this.lifecyclePromise
      return this.status
    }

    this.shutdownRequested = false
    const task = this.startInitial()
    this.lifecyclePromise = task
    try {
      await task
    } finally {
      if (this.lifecyclePromise === task) this.lifecyclePromise = null
    }
    return this.status
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const task = this.performStop()
    this.stopPromise = task
    try {
      await task
    } finally {
      if (this.stopPromise === task) this.stopPromise = null
    }
  }

  private async startInitial(): Promise<void> {
    this.ready = false
    this.startError = null
    this.enginePort = null
    this.restartAttempts = 0
    this.install = (this.options.locate ?? locateFreebuffInstall)()
    if (!this.install) {
      this.fail("FreeBuff Desktop install not found; install FreeBuff Desktop or set SAIWORK_FREEBUFF_HOME")
      return
    }
    if (!this.install.version) {
      this.fail("FreeBuff Desktop package version could not be verified; refusing to forge Desktop metadata")
      return
    }

    try {
      const createLifetime = this.options.createLifetime
        ?? ((onFailure) => createFreebuffShellLifetimeServer({ onFailure }))
      const lifetime = await createLifetime((error) => this.handleLifetimeFailure(error))
      if (this.shutdownRequested) {
        await lifetime.close()
        return
      }
      if (!Number.isInteger(lifetime.port) || lifetime.port <= 0 || lifetime.port > 65_535 || !lifetime.token || lifetime.token.length > 1_024) {
        await lifetime.close()
        this.fail("FreeBuff shell lifetime server returned invalid connection settings")
        return
      }
      this.lifetime = lifetime
    } catch (cause) {
      this.fail(`FreeBuff shell lifetime server failed: ${errorMessage(cause)}`)
      return
    }

    const timeoutRetries = this.options.startupTimeoutRetries ?? 1
    let failure: EngineLaunchError | null = null
    for (let attempt = 0; attempt <= timeoutRetries && !this.shutdownRequested; attempt += 1) {
      try {
        await this.spawnAndWait(this.options.port ?? 0)
        return
      } catch (cause) {
        failure = asLaunchError(cause)
        if (failure.kind !== "timeout" || attempt >= timeoutRetries) break
        this.options.logger.warn({ attempt: attempt + 1 }, "FreeBuff startup timed out; retrying with a clean child")
      }
    }

    if (failure) this.fail(failure.message)
    await this.closeLifetime()
    this.enginePort = null
  }

  private async spawnAndWait(requestedPort: number): Promise<void> {
    const install = this.install
    const lifetime = this.lifetime
    if (!install?.version) throw new EngineLaunchError("version", "FreeBuff Desktop version unavailable")
    if (!lifetime) throw new EngineLaunchError("lifetime", "FreeBuff shell lifetime server unavailable")
    if (this.shutdownRequested) throw new EngineLaunchError("cleanup", "FreeBuff startup cancelled")

    const launchId = (this.options.randomLaunchId ?? randomUUID)()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(requestedPort),
      FREEBUFF_LAUNCH_ID: launchId,
      FREEBUFF_SHELL_LIFETIME_PORT: String(lifetime.port),
      FREEBUFF_PROFILE_LOCK_WAIT_MS: "10000",
      FREEBUFF_APP_VERSION: install.version,
      SAIWORK_FREEBUFF_COORDINATOR: "1",
    }
    // Electron alone may assert its signing state and CDP bridge identity.
    delete env.FREEBUFF_SIGNING_STATE
    delete env.FREEBUFF_SIGNING_TEAM
    delete env.FREEBUFF_CDP_BRIDGE_PORT
    delete env.FREEBUFF_CDP_BRIDGE_TOKEN

    if ((this.options.platform ?? process.platform) !== "win32") {
      try {
        chmodSync(install.bunPath, 0o755)
      } catch {
        // Desktop treats executable-bit repair as best effort; spawn reports
        // the concrete error if the runtime is still not executable.
      }
    }

    const spawnFn = this.options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
    let child: ChildProcess
    try {
      child = spawnFn(install.bunPath, [install.orchestratorPath], {
        cwd: path.dirname(install.orchestratorPath),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (cause) {
      throw new EngineLaunchError("spawn", `Failed to spawn FreeBuff orchestrator: ${errorMessage(cause)}`)
    }
    if (!Number.isInteger(child.pid) || (child.pid ?? 0) <= 0 || !child.stdin || !child.stdout || !child.stderr) {
      try {
        child.kill("SIGKILL")
      } catch {}
      throw new EngineLaunchError("spawn", "FreeBuff orchestrator did not expose an owned PID and piped stdio")
    }

    let resolveAnnouncement!: (announcement: ReadyAnnouncement) => void
    const announcement = new Promise<ReadyAnnouncement>((resolve) => {
      resolveAnnouncement = resolve
    })
    const launch: Launch = {
      child,
      launchId,
      requestedPort,
      preservePortOnFailure: requestedPort !== 0 && this.enginePort === requestedPort,
      ready: false,
      expectedStop: false,
      closed: false,
      failure: null,
      abort: new AbortController(),
      announcement,
      resolveAnnouncement,
      stdoutBuffer: "",
      onStdout: () => {},
      onStderr: () => {},
      onStdoutError: () => {},
      onStderrError: () => {},
    }
    launch.onStdout = (chunk) => this.consumeStdout(launch, chunk)
    // Always drain stderr so a full pipe cannot stall the child. Desktop owns
    // the verbose log; SAIWORK keeps its idle path free of per-chunk logging.
    launch.onStderr = () => {}
    const handleOutputError = (stream: "stdout" | "stderr", cause: Error) => {
      this.options.logger.warn({ stream, pid: child.pid, error: cause.message }, "FreeBuff output stream failed")
      if (launch.ready || launch.failure) return
      launch.failure = new EngineLaunchError("spawn", `FreeBuff ${stream} stream failed: ${cause.message}`)
      launch.abort.abort()
    }
    launch.onStdoutError = (error) => handleOutputError("stdout", error)
    launch.onStderrError = (error) => handleOutputError("stderr", error)
    child.stdout.on("data", launch.onStdout)
    child.stderr.on("data", launch.onStderr)
    child.stdout.on("error", launch.onStdoutError)
    child.stderr.on("error", launch.onStderrError)
    child.on("error", (cause) => {
      if (!launch.failure) launch.failure = new EngineLaunchError("spawn", `FreeBuff orchestrator error: ${errorMessage(cause)}`)
      launch.abort.abort()
      this.options.logger.error({ error: errorMessage(cause), pid: child.pid }, "FreeBuff orchestrator process error")
    })
    child.once("close", (code, signal) => this.handleLaunchClose(launch, code, signal))

    this.child = child
    this.launch = launch
    this.ready = false
    this.lastSpawnAt = this.now()
    this.emitStatus()
    child.stdin.on("error", (cause) => {
      if (launch.ready || launch.failure) return
      launch.failure = new EngineLaunchError("spawn", `FreeBuff stdin bootstrap failed: ${errorMessage(cause)}`)
      launch.abort.abort()
    })
    try {
      child.stdin.end(`${lifetime.token}\n`)
    } catch (cause) {
      launch.failure = new EngineLaunchError("spawn", `FreeBuff stdin bootstrap failed: ${errorMessage(cause)}`)
      launch.abort.abort()
    }

    this.options.logger.info(
      { bun: install.bunPath, orchestrator: install.orchestratorPath, requestedPort, pid: child.pid, desktopVersion: install.version },
      "Starting SAIWORK-coordinated FreeBuff engine",
    )

    try {
      const deadline = this.now() + (this.options.readyTimeoutMs ?? FREEBUFF_ENGINE_READY_TIMEOUT_MS)
      const readyAnnouncement = await this.waitForAnnouncement(launch, deadline)
      await this.waitForHealth(launch, readyAnnouncement, deadline)
      if (!isChildRunning(child) || this.launch !== launch || this.shutdownRequested) {
        throw launch.failure ?? new EngineLaunchError("exit", "FreeBuff orchestrator stopped before becoming ready")
      }
      launch.ready = true
      this.ready = true
      this.enginePort = readyAnnouncement.port
      this.startError = null
      this.options.logger.info(
        { port: readyAnnouncement.port, pid: readyAnnouncement.pid },
        "SAIWORK-coordinated FreeBuff engine ready",
      )
      this.emitStatus()
    } catch (cause) {
      const failure = asLaunchError(cause)
      launch.expectedStop = true
      const contained = await this.forceStopLaunch(launch)
      if (!contained) {
        throw new EngineLaunchError("cleanup", "Failed FreeBuff child could not be contained")
      }
      throw failure
    }
  }

  private consumeStdout(launch: Launch, chunk: Buffer | string): void {
    const text = String(chunk)
    if (launch.ready) return
    launch.stdoutBuffer += text
    const lines = launch.stdoutBuffer.split("\n")
    launch.stdoutBuffer = lines.pop() ?? ""
    if (launch.stdoutBuffer.length > MAX_STDOUT_BUFFER_BYTES) {
      launch.stdoutBuffer = launch.stdoutBuffer.slice(-MAX_STDOUT_BUFFER_BYTES)
    }
    for (const rawLine of lines) {
      const line = rawLine.trim()
      const prefix = "[orchestrator-ready] "
      if (!line.startsWith(prefix)) continue
      let value: unknown
      try {
        value = JSON.parse(line.slice(prefix.length))
      } catch {
        continue
      }
      if (!isReadyAnnouncement(value)) continue
      if (
        value.launchId !== launch.launchId
        || value.pid !== launch.child.pid
        || (launch.requestedPort !== 0 && value.port !== launch.requestedPort)
      ) continue
      launch.resolveAnnouncement(value)
      return
    }
  }

  private async waitForAnnouncement(launch: Launch, deadline: number): Promise<ReadyAnnouncement> {
    return raceLaunchStep(launch, launch.announcement, deadline, () => this.now(), "FreeBuff engine did not announce readiness in time")
  }

  private async waitForHealth(launch: Launch, identity: ReadyAnnouncement, deadline: number): Promise<void> {
    const probe = this.options.healthProbe ?? defaultWaitForReady
    const intervalMs = this.options.probeIntervalMs ?? 300
    while (this.now() < deadline) {
      throwLaunchFailure(launch)
      const remaining = deadline - this.now()
      const probeTimeout = Math.max(1, Math.min(FREEBUFF_ENGINE_HEALTH_PROBE_TIMEOUT_MS, remaining))
      const probeAbort = new AbortController()
      const onLaunchAbort = () => probeAbort.abort()
      launch.abort.signal.addEventListener("abort", onLaunchAbort, { once: true })
      try {
        const healthy = await raceWithTimeout(
          probe(identity, probeAbort.signal),
          probeTimeout,
          () => probeAbort.abort(),
        )
        if (healthy) return
      } catch {
        throwLaunchFailure(launch)
      } finally {
        launch.abort.signal.removeEventListener("abort", onLaunchAbort)
      }
      await abortableDelay(Math.min(intervalMs, Math.max(1, deadline - this.now())), launch)
    }
    throw new EngineLaunchError("timeout", "FreeBuff engine did not pass its launch-bound health probe in time")
  }

  private handleLaunchClose(launch: Launch, code: number | null, signal: NodeJS.Signals | null): void {
    launch.closed = true
    if (!launch.failure && !launch.ready && !launch.expectedStop) {
      launch.failure = new EngineLaunchError("exit", `FreeBuff engine exited during startup (code ${code ?? "none"}, signal ${signal ?? "none"})`)
    }
    launch.abort.abort()
    launch.child.stdout?.off("data", launch.onStdout)
    launch.child.stderr?.off("data", launch.onStderr)
    launch.child.stdout?.off("error", launch.onStdoutError)
    launch.child.stderr?.off("error", launch.onStderrError)
    if (this.launch !== launch) return

    this.child = null
    this.launch = null
    const recover = launch.ready && !launch.expectedStop && !this.shutdownRequested
    this.ready = false
    if (!recover && !(launch.preservePortOnFailure && !this.shutdownRequested)) this.enginePort = null
    this.options.logger.warn({ code, signal, pid: launch.child.pid, recover }, "FreeBuff engine exited")
    this.emitStatus()
    if (recover) this.scheduleCrashRecovery(new EngineLaunchError("exit", `FreeBuff engine crashed (code ${code ?? "none"}, signal ${signal ?? "none"})`))
  }

  private scheduleCrashRecovery(initialFailure: EngineLaunchError): void {
    const previous = this.lifecyclePromise
    const recovery = (async () => {
      if (previous) await previous.catch(() => {})
      await this.recoverFromCrash(initialFailure)
    })()
    this.lifecyclePromise = recovery
    void recovery.finally(() => {
      if (this.lifecyclePromise === recovery) this.lifecyclePromise = null
    })
  }

  private async recoverFromCrash(initialFailure: EngineLaunchError): Promise<void> {
    let failure = initialFailure
    while (!this.shutdownRequested && this.enginePort !== null) {
      if (this.now() - this.lastSpawnAt > (this.options.restartStableMs ?? FREEBUFF_ENGINE_RESTART_STABLE_MS)) {
        this.restartAttempts = 0
      }
      if (this.restartAttempts >= (this.options.restartLimit ?? FREEBUFF_ENGINE_RESTART_LIMIT)) break
      this.restartAttempts += 1
      try {
        await this.spawnAndWait(this.enginePort)
        return
      } catch (cause) {
        failure = asLaunchError(cause)
        this.options.logger.warn({ attempt: this.restartAttempts, error: failure.message }, "FreeBuff crash restart failed")
        if (failure.kind === "cleanup") break
      }
    }
    if (this.shutdownRequested) return
    this.fail(`FreeBuff crash recovery exhausted: ${failure.message}`)
    await this.closeLifetime()
    this.enginePort = null
    this.emitStatus()
  }

  private async performStop(): Promise<void> {
    this.shutdownRequested = true
    this.ready = false
    const launch = this.launch
    if (launch) {
      launch.expectedStop = true
      if (!launch.ready) {
        launch.failure = new EngineLaunchError("cleanup", "FreeBuff startup cancelled")
        launch.abort.abort()
      }
    }
    await this.closeLifetime()
    const lifecycle = this.lifecyclePromise
    if (lifecycle) await lifecycle.catch(() => {})

    const current = this.launch ?? launch
    if (current && isChildRunning(current.child)) {
      if ((this.options.platform ?? process.platform) !== "win32") {
        try {
          current.child.kill("SIGTERM")
        } catch {}
      }
      let closed = await waitForChildClose(current.child, this.options.stopGraceMs ?? FREEBUFF_ENGINE_STOP_GRACE_MS)
      if (!closed && isChildRunning(current.child)) {
        try {
          current.child.kill("SIGKILL")
        } catch {}
        closed = await waitForChildClose(current.child, this.options.forceStopWaitMs ?? FREEBUFF_ENGINE_FORCE_STOP_WAIT_MS)
      }
      if (!closed && isChildRunning(current.child)) {
        this.startError = "FreeBuff engine did not exit after graceful and forced shutdown"
        this.emitStatus()
        throw new Error(this.startError)
      }
    }
    this.child = null
    this.launch = null
    this.enginePort = null
    this.startError = null
    this.emitStatus()
  }

  private async forceStopLaunch(launch: Launch): Promise<boolean> {
    if (!isChildRunning(launch.child)) return true
    this.lifetime?.disconnectClients()
    try {
      launch.child.kill("SIGKILL")
    } catch {}
    const closed = await waitForChildClose(launch.child, this.options.forceStopWaitMs ?? FREEBUFF_ENGINE_FORCE_STOP_WAIT_MS)
    if (closed || !isChildRunning(launch.child)) {
      if (this.launch === launch) {
        this.child = null
        this.launch = null
        this.ready = false
        if (!(launch.preservePortOnFailure && !this.shutdownRequested)) this.enginePort = null
        this.emitStatus()
      }
      return true
    }
    return false
  }

  private handleLifetimeFailure(error: Error): void {
    if (this.shutdownRequested) return
    const failure = `FreeBuff shell lifetime channel failed: ${error.message}`
    this.fail(failure)
    void this.stop().then(() => {
      // Manual stop clears stale errors; an automatic safety stop must retain
      // its root cause so status explains why the engine disappeared.
      this.startError = failure
      this.emitStatus()
    }, (cause) => {
      this.options.logger.error({ error: errorMessage(cause) }, "Failed to contain FreeBuff after lifetime channel failure")
    })
  }

  private async closeLifetime(): Promise<void> {
    const lifetime = this.lifetime
    this.lifetime = null
    if (!lifetime) return
    try {
      await lifetime.close()
    } catch (cause) {
      this.options.logger.warn({ error: errorMessage(cause) }, "FreeBuff shell lifetime close failed")
    }
  }

  private fail(message: string): void {
    this.startError = message
    this.ready = false
    this.options.logger.warn({ error: message }, "FreeBuff engine unavailable")
    this.emitStatus()
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return
    const status = this.status
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch (cause) {
        this.options.logger.warn({ error: errorMessage(cause) }, "FreeBuff status listener failed")
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
}

/** Desktop's exact launch-bound `/healthz` contract. */
export async function defaultWaitForReady(identity: FreebuffLaunchIdentity, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${identity.port}/healthz`, {
      headers: { "x-freebuff-launch-id": identity.launchId },
      signal,
    })
    if (!response.ok) return false
    const health = await response.json() as Partial<FreebuffLaunchIdentity> & { ok?: boolean }
    return health.ok === true
      && health.launchId === identity.launchId
      && health.pid === identity.pid
      && health.port === identity.port
  } catch {
    return false
  }
}

function isReadyAnnouncement(value: unknown): value is ReadyAnnouncement {
  if (typeof value !== "object" || value === null) return false
  const announcement = value as Partial<ReadyAnnouncement>
  return typeof announcement.launchId === "string"
    && Number.isInteger(announcement.pid)
    && (announcement.pid ?? 0) > 0
    && Number.isInteger(announcement.port)
    && (announcement.port ?? 0) > 0
    && (announcement.port ?? 0) <= 65_535
}

function isChildRunning(child: ChildProcess | null): child is ChildProcess {
  return child !== null && child.exitCode === null && child.signalCode === null
}

function throwLaunchFailure(launch: Launch): void {
  if (launch.failure) throw launch.failure
  if (launch.closed || !isChildRunning(launch.child)) {
    throw new EngineLaunchError("exit", "FreeBuff orchestrator stopped before becoming ready")
  }
}

async function raceLaunchStep<T>(
  launch: Launch,
  promise: Promise<T>,
  deadline: number,
  now: () => number,
  timeoutMessage: string,
): Promise<T> {
  throwLaunchFailure(launch)
  const remaining = deadline - now()
  if (remaining <= 0) throw new EngineLaunchError("timeout", timeoutMessage)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      launch.abort.signal.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve(value as T)
    }
    const onAbort = () => finish(launch.failure ?? new EngineLaunchError("exit", "FreeBuff orchestrator stopped before becoming ready"))
    const timer = setTimeout(() => finish(new EngineLaunchError("timeout", timeoutMessage)), remaining)
    launch.abort.signal.addEventListener("abort", onAbort, { once: true })
    promise.then((value) => finish(null, value), finish)
  })
}

function abortableDelay(ms: number, launch: Launch): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      launch.abort.signal.removeEventListener("abort", onAbort)
      reject(launch.failure ?? new EngineLaunchError("exit", "FreeBuff orchestrator stopped"))
    }
    const timer = setTimeout(() => {
      launch.abort.signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    launch.abort.signal.addEventListener("abort", onAbort, { once: true })
    if (launch.abort.signal.aborted) onAbort()
  })
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as T)
    }
    const timer = setTimeout(() => {
      onTimeout()
      finish(new EngineLaunchError("timeout", "FreeBuff health probe timed out"))
    }, timeoutMs)
    promise.then((value) => finish(null, value), finish)
  })
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isChildRunning(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (closed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off("close", onClose)
      resolve(closed || !isChildRunning(child))
    }
    const onClose = () => finish(true)
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
    child.once("close", onClose)
  })
}

function asLaunchError(cause: unknown): EngineLaunchError {
  return cause instanceof EngineLaunchError
    ? cause
    : new EngineLaunchError("spawn", errorMessage(cause))
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
