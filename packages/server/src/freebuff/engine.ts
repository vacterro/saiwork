import { spawn, type ChildProcess } from "node:child_process"
import path from "node:path"

import type { Logger } from "../logger"
import { findFreePort } from "./port"
import { locateFreebuffInstall, type FreebuffInstall } from "./install"
import type { FreebuffAuthState } from "./types"

export interface FreebuffEngineOptions {
  logger: Logger
  /** Resolve the engine install; default locates the desktop install. */
  locate?: () => FreebuffInstall | null
  /** Bind an engine instance to a specific port instead of a free one. */
  port?: number
  /** Spawn a process; default spawns bun directly. */
  spawn?: (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; stdio: "ignore"[] }) => ChildProcess
  /** Probe engine readiness; default polls /api/auth/status over loopback. */
  waitForReady?: (port: number) => Promise<boolean>
  /** Maximum time to wait for the engine to come up. */
  readyTimeoutMs?: number
}

export interface FreebuffEngineStatus {
  installFound: boolean
  engineRunning: boolean
  ready: boolean
  port: number | null
  root: string | null
  auth: FreebuffAuthState | null
  error: string | null
}

export const FREEBUFF_ENGINE_READY_TIMEOUT_MS = 20_000
export const FREEBUFF_ENGINE_STOP_TIMEOUT_MS = 5_000

/**
 * Owns the lifecycle of one headless FreeBuff orchestrator process.
 *
 * The orchestrator reads its account from `~/.config/freebuff-desktop/
 * state.json` (already logged in on this machine), so spawning it with a free
 * loopback port yields a ready agent engine with no additional auth dance.
 */
export class FreebuffEngineManager {
  private child: ChildProcess | null = null
  private install: FreebuffInstall | null = null
  private enginePort: number | null = null
  private ready = false
  private startError: string | null = null
  private readonly options: Required<Pick<FreebuffEngineOptions, "logger">> & FreebuffEngineOptions

  constructor(options: FreebuffEngineOptions) {
    this.options = options
  }

  get status(): FreebuffEngineStatus {
    const running = this.child !== null && this.child.exitCode === null && !this.child.killed
    if (this.install === null && !running) {
      // Resolve the install lazily so a cold status probe still reports what is
      // available without starting the engine.
      this.install = this.options.locate ? this.options.locate() : locateFreebuffInstall()
    }
    return {
      installFound: this.install !== null,
      engineRunning: running,
      ready: this.ready && running,
      port: this.enginePort,
      root: this.install?.root ?? null,
      auth: this.install?.auth ?? null,
      error: this.startError,
    }
  }

  private get logger(): Logger {
    return this.options.logger
  }

  async start(): Promise<FreebuffEngineStatus> {
    if (this.child && this.child.exitCode === null && this.ready) {
      return this.status
    }

    const locate = this.options.locate ?? (() => locateFreebuffInstall())
    this.install = locate()
    if (!this.install) {
      this.startError = "FreeBuff desktop install not found; install FreeBuff Desktop or set SAIWORK_FREEBUFF_HOME"
      this.logger.warn({ error: this.startError }, "FreeBuff engine start aborted")
      return this.status
    }

    const port = this.options.port ?? (await findFreePort())
    const spawnFn = this.options.spawn ?? ((command, args, options) => spawn(command, args, options))
    const waitForReady = this.options.waitForReady ?? defaultWaitForReady
    const readyTimeoutMs = this.options.readyTimeoutMs ?? FREEBUFF_ENGINE_READY_TIMEOUT_MS

    this.logger.info(
      { bun: this.install.bunPath, orchestrator: this.install.orchestratorPath, port, user: this.install.auth?.user?.email },
      "Starting FreeBuff engine",
    )

    const child = spawnFn(this.install.bunPath, [this.install.orchestratorPath], {
      cwd: path.dirname(this.install.orchestratorPath),
      env: {
        ...process.env,
        PORT: String(port),
        FREEBUFF_APP_VERSION: "embedded-by-saiwork",
      },
      stdio: ["ignore", "ignore", "ignore"],
    })
    this.child = child
    this.enginePort = port
    this.ready = false
    this.startError = null

    child.once("error", (error) => {
      this.startError = error.message
      this.logger.error({ error: error.message }, "FreeBuff engine failed to spawn")
    })
    child.once("exit", (code, signal) => {
      this.logger.warn({ code, signal }, "FreeBuff engine exited")
      if (this.child === child) {
        this.child = null
        this.ready = false
      }
    })

    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.startError = `FreeBuff engine exited during startup (code ${child.exitCode})`
        this.logger.error({ code: child.exitCode }, "FreeBuff engine exited during startup")
        return this.status
      }
      try {
        if (await waitForReady(port)) {
          this.ready = true
          this.logger.info({ port }, "FreeBuff engine ready")
          return this.status
        }
      } catch (error) {
        this.logger.debug({ error: error instanceof Error ? error.message : String(error) }, "FreeBuff engine readiness probe failed")
      }
      await delay(400)
    }

    this.startError = "FreeBuff engine did not become ready in time"
    this.logger.warn({ timeoutMs: readyTimeoutMs }, "FreeBuff engine readiness timeout")
    return this.status
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = false
    if (!child || child.exitCode !== null) return
    this.logger.info({ port: this.enginePort }, "Stopping FreeBuff engine")
    const exited = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true))
      setTimeout(() => resolve(false), FREEBUFF_ENGINE_STOP_TIMEOUT_MS)
    })
    child.kill()
    const ok = await exited
    if (!ok && child.exitCode === null) {
      child.kill("SIGKILL")
    }
    this.enginePort = null
  }
}

export function defaultWaitForReady(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/api/auth/status`, {
    signal: AbortSignal.timeout(2_000),
  })
    .then((response) => response.ok)
    .catch(() => false)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
