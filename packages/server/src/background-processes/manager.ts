import { spawn, spawnSync, type ChildProcess } from "child_process"
import { createWriteStream, existsSync, promises as fs, type WriteStream } from "fs"
import path from "path"
import { randomBytes } from "crypto"
import type { EventBus } from "../events/bus"
import type { WorkspaceManager } from "../workspaces/manager"
import { createInstanceClient } from "../workspaces/instance-client"
import type { Logger } from "../logger"
import type { BackgroundProcess, BackgroundProcessStatus, BackgroundProcessTerminalReason } from "../api-types"

const ROOT_DIR = ".saiwork/background_processes"
const INDEX_FILE = "index.json"
const OUTPUT_FILE = "output.txt"
const STOP_TIMEOUT_MS = 2000
const EXIT_WAIT_TIMEOUT_MS = 5000
const MAX_OUTPUT_BYTES = 20 * 1024
const OUTPUT_PUBLISH_INTERVAL_MS = 1000

interface ManagerDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
  spawnProcess?: typeof spawn
  spawnSyncProcess?: typeof spawnSync
  createOutputStream?: typeof createWriteStream
  writeIndex?: (indexPath: string, records: PersistedBackgroundProcess[]) => Promise<void>
  killProcess?: (child: ChildProcess, signal: NodeJS.Signals) => void
  platform?: NodeJS.Platform
  stopTimeoutMs?: number
  exitWaitTimeoutMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

interface RunningProcess {
  id: string
  child: ChildProcess
  outputPath: string
  exitPromise: Promise<void>
  workspaceId: string
  completion?: ProcessCompletion
  stopPromise?: Promise<void>
}

interface ProcessCompletion {
  reason: BackgroundProcessTerminalReason
  endContext: "normal" | "workspace_cleanup"
  removeAfterFinalize?: boolean
}

interface BackgroundProcessNotificationState {
  sessionID: string
  directory: string
  sentAt?: string
}

interface PersistedBackgroundProcess extends BackgroundProcess {
  notify?: BackgroundProcessNotificationState
}

/** Structured failure when the persisted process index is unreadable/corrupt. */
export class BackgroundProcessIndexError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = "BackgroundProcessIndexError"
  }
}

/** A child stayed live after both graceful and forceful cleanup attempts. */
export class BackgroundProcessCleanupError extends Error {
  constructor(readonly workspaceId: string, readonly processId: string, readonly pid?: number) {
    super(`Background process ${processId}${pid ? ` (PID ${pid})` : ""} did not exit after forced cleanup`)
    this.name = "BackgroundProcessCleanupError"
  }
}

/** Persisted state claims "running", but this coordinator cannot prove ownership. */
export class BackgroundProcessOwnershipError extends Error {
  constructor(readonly workspaceId: string, readonly processId: string, readonly pid?: number) {
    super(`Background process ${processId}${pid ? ` (PID ${pid})` : ""} is not owned by this coordinator`)
    this.name = "BackgroundProcessOwnershipError"
  }
}

interface StartOptions {
  notify?: boolean
  notification?: {
    sessionID: string
    directory: string
  }
}

export class BackgroundProcessManager {
  private readonly running = new Map<string, RunningProcess>()
  private readonly workspacePaths = new Map<string, string>()
  private readonly workspaceTransactions = new Map<string, Promise<void>>()
  private readonly workspaceCleanups = new Map<string, Promise<void>>()
  private readonly pendingStarts = new Set<Promise<unknown>>()
  private shuttingDown = false
  private shutdownPromise?: Promise<void>
  private listenersAttached = true

  private readonly onWorkspaceStopped = (event: { workspaceId: string }) => {
    this.observeWorkspaceCleanup(event.workspaceId)
  }

  private readonly onWorkspaceError = (event: { workspace: { id: string } }) => {
    this.observeWorkspaceCleanup(event.workspace.id)
  }

  constructor(private readonly deps: ManagerDeps) {
    this.deps.eventBus.on("workspace.stopped", this.onWorkspaceStopped)
    this.deps.eventBus.on("workspace.error", this.onWorkspaceError)
  }

  async list(workspaceId: string): Promise<BackgroundProcess[]> {
    const records = await this.readIndex(workspaceId)
    const enriched = await Promise.all(
      records.map(async (record) => ({
        ...this.toPublicProcess(record),
        outputSizeBytes: await this.getOutputSize(workspaceId, record.id),
      })),
    )
    return enriched
  }

  async start(workspaceId: string, title: string, command: string, options: StartOptions = {}): Promise<BackgroundProcess> {
    if (this.shuttingDown) {
      throw new Error("Background process manager is shutting down")
    }

    const operation = this.startProcess(workspaceId, title, command, options)
    this.pendingStarts.add(operation)
    try {
      return await operation
    } finally {
      this.pendingStarts.delete(operation)
    }
  }

  private async startProcess(
    workspaceId: string,
    title: string,
    command: string,
    options: StartOptions,
  ): Promise<BackgroundProcess> {
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) {
      throw new Error("Workspace not found")
    }
    this.workspacePaths.set(workspaceId, workspace.path)

    const id = this.generateId()
    const processDir = await this.ensureProcessDir(workspaceId, id)
    if (this.shuttingDown) {
      throw new Error("Background process manager is shutting down")
    }
    const outputPath = path.join(processDir, OUTPUT_FILE)

    const outputStream = (this.deps.createOutputStream ?? createWriteStream)(outputPath, { flags: "a" })
    let outputFailed = false
    let infrastructureError: unknown
    let child: ChildProcess | undefined
    let closeStarted = false
    let failureKillTimer: NodeJS.Timeout | undefined

    const requestInfrastructureStop = () => {
      if (!child || child.killed || closeStarted) return
      this.killBackgroundProcess(child, "SIGTERM")
      if (failureKillTimer) return
      failureKillTimer = setTimeout(() => {
        if (!closeStarted && child) this.killBackgroundProcess(child, "SIGKILL")
      }, STOP_TIMEOUT_MS)
      failureKillTimer.unref?.()
    }

    const handleInfrastructureError = (error: unknown, message: string) => {
      if (!infrastructureError) {
        infrastructureError = error
        this.deps.logger.warn({ err: error, workspaceId, processId: id }, message)
      }
      requestInfrastructureStop()
    }

    outputStream.on("error", (error) => {
      outputFailed = true
      if (!outputStream.destroyed) outputStream.destroy()
      handleInfrastructureError(error, "Background process output stream failed")
    })

    const { shellCommand, shellArgs, spawnOptions } = this.buildShellSpawn(command)

    let spawnedChild: ChildProcess
    try {
      spawnedChild = (this.deps.spawnProcess ?? spawn)(shellCommand, shellArgs, {
        cwd: workspace.path,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
        ...spawnOptions,
      })
    } catch (error) {
      if (!outputStream.destroyed) outputStream.destroy()
      throw error
    }
    child = spawnedChild

    spawnedChild.on("error", (error) => {
      handleInfrastructureError(error, "Background process child failed")
    })

    spawnedChild.on("exit", () => {
      // Best-effort descendant cleanup after natural shell exit. A missing PID
      // is expected here and must not warn like an explicit stop failure.
      this.killProcessTree(spawnedChild, "SIGTERM", false)
    })

    if (infrastructureError) requestInfrastructureStop()

    const record: PersistedBackgroundProcess = {
      id,
      workspaceId,
      title,
      command,
      cwd: workspace.path,
      status: "running",
      pid: spawnedChild.pid,
      startedAt: new Date().toISOString(),
      outputSizeBytes: 0,
      notify: options.notify && options.notification
        ? {
            sessionID: options.notification.sessionID,
            directory: options.notification.directory,
          }
        : undefined,
    }

    const runningState: RunningProcess = {
      id,
      child: spawnedChild,
      outputPath,
      exitPromise: Promise.resolve(),
      workspaceId,
    }

    let resolveExit = () => {}
    let rejectExit = (_error: unknown) => {}
    const exitPromise = new Promise<void>((resolve, reject) => {
      resolveExit = resolve
      rejectExit = reject
    })
    void exitPromise.catch((error) => {
      this.deps.logger.warn({ err: error, workspaceId, processId: id }, "Background process completion failed")
    })

    runningState.exitPromise = exitPromise

    this.running.set(id, runningState)

    let initialPersistence: Promise<void> = Promise.resolve()

    const finalizeProcess = (code: number | null) => {
      if (closeStarted) return
      closeStarted = true
      if (failureKillTimer) clearTimeout(failureKillTimer)

      void (async () => {
        try {
          await initialPersistence
        } catch (error) {
          infrastructureError ??= error
        }

        try {
          await this.closeOutputStream(outputStream, outputFailed)
        } catch (error) {
          handleInfrastructureError(error, "Failed to close background process output")
        }

        const requestedCompletion = runningState.completion
        const completion: ProcessCompletion = infrastructureError
          ? {
              reason: "failed",
              endContext: requestedCompletion?.endContext ?? "normal",
              ...(requestedCompletion?.removeAfterFinalize ? { removeAfterFinalize: true } : {}),
            }
          : requestedCompletion ?? this.completionFromExit(code)

        record.terminalReason = completion.reason
        record.status = this.statusFromReason(completion.reason)
        record.exitCode = code === null ? undefined : code
        record.stoppedAt = new Date().toISOString()

        try {
          await this.finalizeRecord(workspaceId, record, completion)
        } catch (error) {
          this.deps.logger.warn({ err: error, workspaceId, processId: id }, "Failed to finalize background process record")
          record.terminalReason = "failed"
          record.status = "error"
          await this.recoverFailedFinalization(workspaceId, record, completion)
        }
      })().then(
        () => {
          this.running.delete(id)
          resolveExit()
        },
        (error) => {
          this.running.delete(id)
          rejectExit(error)
        },
      )
    }

    spawnedChild.on("close", finalizeProcess)

    let lastPublishAt = 0
    const maybePublishSize = () => {
      const now = Date.now()
      if (now - lastPublishAt < OUTPUT_PUBLISH_INTERVAL_MS) {
        return
      }
      lastPublishAt = now
      this.publishUpdate(workspaceId, record)
    }

    spawnedChild.stdout?.on("data", (data) => {
      if (outputFailed) return
      outputStream.write(data)
      record.outputSizeBytes = (record.outputSizeBytes ?? 0) + data.length
      maybePublishSize()
    })
    spawnedChild.stderr?.on("data", (data) => {
      if (outputFailed) return
      outputStream.write(data)
      record.outputSizeBytes = (record.outputSizeBytes ?? 0) + data.length
      maybePublishSize()
    })

    initialPersistence = this.upsertIndex(workspaceId, record)

    try {
      await initialPersistence
    } catch (error) {
      handleInfrastructureError(error, "Failed to persist initial background process record")
      throw error
    }
    if (closeStarted) {
      await exitPromise
    } else {
      record.outputSizeBytes = await this.getOutputSize(workspaceId, record.id)
      if (closeStarted) {
        await exitPromise
      } else {
        this.publishUpdate(workspaceId, record)
      }
    }
    return this.toPublicProcess(record)
  }

  async stop(workspaceId: string, processId: string): Promise<BackgroundProcess | null> {
    const record = await this.findProcess(workspaceId, processId)
    if (!record) {
      return null
    }

    const running = this.getRunningProcess(workspaceId, processId)
    if (running) {
      await this.requestStop(running, { reason: "user_stopped", endContext: "normal" })
      const updated = await this.findProcess(workspaceId, processId)
      return updated ? this.toPublicProcess(updated) : this.toPublicProcess(record)
    }

    if (record.status === "running") {
      throw new BackgroundProcessOwnershipError(workspaceId, processId, record.pid)
    }

    return this.toPublicProcess(record)
  }

  async terminate(workspaceId: string, processId: string): Promise<void> {
    const record = await this.findProcess(workspaceId, processId)
    if (!record) return

    const running = this.getRunningProcess(workspaceId, processId)
    if (running) {
      await this.requestStop(running, {
        reason: "user_terminated",
        endContext: "normal",
        removeAfterFinalize: true,
      })
      return
    }

    if (record.status === "running") {
      throw new BackgroundProcessOwnershipError(workspaceId, processId, record.pid)
    }
    await this.finalizeRecord(workspaceId, record, {
      reason: "user_terminated",
      endContext: "normal",
      removeAfterFinalize: true,
    })
  }

  async readOutput(
    workspaceId: string,
    processId: string,
    options: { method?: "full" | "tail" | "head" | "grep"; pattern?: string; lines?: number; maxBytes?: number },
  ) {
    const outputPath = this.getOutputPath(workspaceId, processId)
    if (!existsSync(outputPath)) {
      return { id: processId, content: "", truncated: false, sizeBytes: 0 }
    }

    const stats = await fs.stat(outputPath)
    const sizeBytes = stats.size
    const method = options.method ?? "full"
    const lineCount = options.lines ?? 10

    const raw = await this.readOutputBytes(outputPath, sizeBytes, options.maxBytes)
    let content = raw

    switch (method) {
      case "head":
        content = this.headLines(raw, lineCount)
        break
      case "tail":
        content = this.tailLines(raw, lineCount)
        break
      case "grep":
        if (!options.pattern) {
          throw new Error("Pattern is required for grep output")
        }
        content = this.grepLines(raw, options.pattern)
        break
      default:
        content = raw
    }

    const effectiveMaxBytes = options.maxBytes
    return {
      id: processId,
      content,
      truncated: effectiveMaxBytes !== undefined && sizeBytes > effectiveMaxBytes,
      sizeBytes,
    }
  }

  async streamOutput(workspaceId: string, processId: string, reply: any) {
    const outputPath = this.getOutputPath(workspaceId, processId)
    if (!existsSync(outputPath)) {
      reply.code(404).send({ error: "Output not found" })
      return
    }

    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    const file = await fs.open(outputPath, "r")
    let position = (await file.stat()).size

    const tick = async () => {
      const stats = await file.stat()
      if (stats.size <= position) return

      const length = stats.size - position
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, position)
      position = stats.size

      const content = buffer.toString("utf-8")
      reply.raw.write(`data: ${JSON.stringify({ type: "chunk", content })}\n\n`)
    }

    const interval = setInterval(() => {
      tick().catch((error) => {
        this.deps.logger.warn({ err: error }, "Failed to stream background process output")
      })
    }, 1000)

    const close = () => {
      clearInterval(interval)
      file.close().catch(() => undefined)
      reply.raw.end?.()
    }

    reply.raw.on("close", close)
    reply.raw.on("error", close)
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise

    this.shuttingDown = true
    this.detachWorkspaceListeners()
    const operation = this.performShutdown()
    this.shutdownPromise = operation
    try {
      await operation
    } catch (error) {
      if (this.shutdownPromise === operation) this.shutdownPromise = undefined
      throw error
    }
  }

  private async performShutdown(): Promise<void> {
    await Promise.allSettled(Array.from(this.pendingStarts))

    const workspaceIds = new Set<string>([
      ...this.workspacePaths.keys(),
      ...this.workspaceCleanups.keys(),
      ...Array.from(this.running.values(), (running) => running.workspaceId),
    ])
    const results = await Promise.allSettled(
      Array.from(workspaceIds, (workspaceId) => this.scheduleWorkspaceCleanup(workspaceId)),
    )
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (this.running.size > 0 && failures.length === 0) {
      failures.push(new Error(
        `Background process cleanup remains incomplete for: ${Array.from(this.running.keys()).join(", ")}`,
      ))
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Background process manager shutdown failed")
    }
  }

  private detachWorkspaceListeners() {
    if (!this.listenersAttached) return
    this.listenersAttached = false
    this.deps.eventBus.off("workspace.stopped", this.onWorkspaceStopped)
    this.deps.eventBus.off("workspace.error", this.onWorkspaceError)
  }

  private observeWorkspaceCleanup(workspaceId: string) {
    void this.scheduleWorkspaceCleanup(workspaceId).catch((error) => {
      this.deps.logger.warn({ err: error, workspaceId }, "Background process workspace cleanup failed")
    })
  }

  private scheduleWorkspaceCleanup(workspaceId: string): Promise<void> {
    const existing = this.workspaceCleanups.get(workspaceId)
    if (existing) return existing

    const operation = this.cleanupWorkspace(workspaceId)
    const tracked = operation.finally(() => {
      if (this.workspaceCleanups.get(workspaceId) === tracked) {
        this.workspaceCleanups.delete(workspaceId)
      }
    })
    this.workspaceCleanups.set(workspaceId, tracked)
    return tracked
  }

  private async cleanupWorkspace(workspaceId: string) {
    const runningProcesses = Array.from(this.running.values())
      .filter((running) => running.workspaceId === workspaceId)
    const results = await Promise.allSettled(runningProcesses.map((running) => this.requestStop(running, {
      reason: "user_terminated",
      endContext: "workspace_cleanup",
      removeAfterFinalize: true,
    })))
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length > 0) {
      throw new AggregateError(failures, `Background process cleanup failed for workspace ${workspaceId}`)
    }

    await this.removeWorkspaceDir(workspaceId)
    this.workspacePaths.delete(workspaceId)
  }

  private killProcessTree(child: ChildProcess, signal: NodeJS.Signals, reportFailure = true): boolean {
    const pid = child.pid
    if (pid && this.platform === "win32") {
      const args = this.buildWindowsTaskkillArgs(pid, signal)
      try {
        const result = (this.deps.spawnSyncProcess ?? spawnSync)("taskkill", args, { stdio: "ignore" })
        if (result.status === 0 && !result.error) return true
        if (reportFailure) {
          this.deps.logger.warn(
            { pid, signal, status: result.status, err: result.error },
            "Windows taskkill failed; falling back to the direct child",
          )
        }
      } catch (error) {
        if (reportFailure) {
          this.deps.logger.warn(
            { pid, signal, err: error },
            "Windows taskkill threw; falling back to the direct child",
          )
        }
      }
    } else if (pid) {
      try {
        process.kill(-pid, signal)
        return true
      } catch {
        // Fall back to killing the direct child.
      }
    }

    try {
      return child.kill(signal)
    } catch (error) {
      if (reportFailure) {
        this.deps.logger.warn({ pid, signal, err: error }, "Failed to signal background process child")
      }
      return false
    }
  }

  private async waitForExit(running: RunningProcess) {
    let exited = false
    const exitPromise = running.exitPromise.finally(() => {
      exited = true
    })

    const scheduleTimeout = this.deps.setTimeoutFn ?? setTimeout
    const cancelTimeout = this.deps.clearTimeoutFn ?? clearTimeout
    const killTimeout = scheduleTimeout(() => {
      if (!exited) {
        this.killBackgroundProcess(running.child, "SIGKILL")
      }
    }, this.stopTimeoutMs)

    let exitWaitTimeout: NodeJS.Timeout | undefined
    const deadline = new Promise<false>((resolve) => {
      exitWaitTimeout = scheduleTimeout(() => resolve(false), this.exitWaitTimeoutMs)
    })

    try {
      const didExit = await Promise.race([
        exitPromise.then(() => true),
        deadline,
      ])

      if (!didExit || !exited) {
        this.killBackgroundProcess(running.child, "SIGKILL")
        const error = new BackgroundProcessCleanupError(
          running.workspaceId,
          running.id,
          running.child.pid,
        )
        this.deps.logger.warn({ err: error, pid: running.child.pid }, "Timed out waiting for background process to exit")
        throw error
      }
    } finally {
      cancelTimeout(killTimeout)
      if (exitWaitTimeout) cancelTimeout(exitWaitTimeout)
    }
  }

  private getRunningProcess(workspaceId: string, processId: string): RunningProcess | undefined {
    const running = this.running.get(processId)
    return running?.workspaceId === workspaceId ? running : undefined
  }

  private async requestStop(running: RunningProcess, completion: ProcessCompletion): Promise<void> {
    if (!running.completion?.removeAfterFinalize || completion.removeAfterFinalize) {
      running.completion = completion
    }
    if (running.stopPromise) return running.stopPromise

    const operation = (async () => {
      if (!running.child.killed) this.killBackgroundProcess(running.child, "SIGTERM")
      await this.waitForExit(running)
    })()
    running.stopPromise = operation
    try {
      await operation
    } finally {
      if (running.stopPromise === operation) running.stopPromise = undefined
    }
  }


  private buildShellSpawn(command: string): { shellCommand: string; shellArgs: string[]; spawnOptions?: Record<string, unknown> } {
    if (this.platform === "win32") {
      const comspec = process.env.ComSpec || "cmd.exe"
      return {
        shellCommand: comspec,
        shellArgs: ["/d", "/s", "/c", command],
        spawnOptions: { windowsVerbatimArguments: true },
      }
    }

    // Keep bash for macOS/Linux.
    return { shellCommand: "bash", shellArgs: ["-c", command] }
  }

  private buildWindowsTaskkillArgs(pid: number, signal: NodeJS.Signals): string[] {
    // Default to graceful termination (no /F), then force kill when we escalate.
    const force = signal === "SIGKILL"
    const args = ["/PID", String(pid), "/T"]
    if (force) {
      args.push("/F")
    }
    return args
  }

  private completionFromExit(code: number | null): ProcessCompletion {
    if (code === 0) {
      return { reason: "finished", endContext: "normal" }
    }

    return { reason: "failed", endContext: "normal" }
  }

  private statusFromReason(reason: BackgroundProcessTerminalReason): BackgroundProcessStatus {
    if (reason === "failed") return "error"
    return "stopped"
  }

  private killBackgroundProcess(child: ChildProcess, signal: NodeJS.Signals) {
    if (this.deps.killProcess) {
      this.deps.killProcess(child, signal)
      return
    }
    this.killProcessTree(child, signal)
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private get stopTimeoutMs(): number {
    return this.deps.stopTimeoutMs ?? STOP_TIMEOUT_MS
  }

  private get exitWaitTimeoutMs(): number {
    return this.deps.exitWaitTimeoutMs ?? EXIT_WAIT_TIMEOUT_MS
  }

  private async closeOutputStream(outputStream: WriteStream, failed: boolean) {
    if (failed || outputStream.destroyed) {
      if (!outputStream.destroyed) outputStream.destroy()
      if (outputStream.closed) return
      await new Promise<void>((resolve) => outputStream.once("close", resolve))
      return
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const complete = (error?: unknown) => {
        if (settled) return
        settled = true
        outputStream.off("error", onError)
        error ? reject(error) : resolve()
      }
      const onError = (error: unknown) => complete(error)
      outputStream.once("error", onError)
      try {
        outputStream.end(() => complete())
      } catch (error) {
        complete(error)
      }
    })
  }

  private async recoverFailedFinalization(
    workspaceId: string,
    record: PersistedBackgroundProcess,
    completion: ProcessCompletion,
  ) {
    if (completion.removeAfterFinalize) {
      await this.removeFromIndex(workspaceId, record.id)
      await this.removeProcessDir(workspaceId, record.id)
      this.deps.eventBus.publish({
        type: "instance.event",
        instanceId: workspaceId,
        event: { type: "background.process.removed", properties: { processId: record.id } },
      })
      return
    }

    await this.upsertIndex(workspaceId, record)
    record.outputSizeBytes = await this.getOutputSize(workspaceId, record.id)
    this.publishUpdate(workspaceId, record)
  }

  private async readOutputBytes(outputPath: string, sizeBytes: number, maxBytes?: number): Promise<string> {
    if (maxBytes === undefined || sizeBytes <= maxBytes) {
      return await fs.readFile(outputPath, "utf-8")
    }

    const start = Math.max(0, sizeBytes - maxBytes)
    const file = await fs.open(outputPath, "r")
    const buffer = Buffer.alloc(sizeBytes - start)
    await file.read(buffer, 0, buffer.length, start)
    await file.close()
    return buffer.toString("utf-8")
  }

  private headLines(input: string, lines: number): string {
    const parts = input.split(/\r?\n/)
    return parts.slice(0, Math.max(0, lines)).join("\n")
  }

  private tailLines(input: string, lines: number): string {
    const parts = input.split(/\r?\n/)
    return parts.slice(Math.max(0, parts.length - lines)).join("\n")
  }

  private grepLines(input: string, pattern: string): string {
    let matcher: RegExp
    try {
      matcher = new RegExp(pattern)
    } catch {
      throw new Error("Invalid grep pattern")
    }
    return input
      .split(/\r?\n/)
      .filter((line) => matcher.test(line))
      .join("\n")
  }

  private async ensureProcessDir(workspaceId: string, processId: string) {
    const root = await this.ensureWorkspaceDir(workspaceId)
    const processDir = path.join(root, processId)
    await fs.mkdir(processDir, { recursive: true })
    return processDir
  }

  private async ensureWorkspaceDir(workspaceId: string) {
    const workspacePath = this.requireWorkspacePath(workspaceId)
    const root = path.join(workspacePath, ROOT_DIR, workspaceId)
    await fs.mkdir(root, { recursive: true })
    return root
  }

  private getOutputPath(workspaceId: string, processId: string) {
    return path.join(this.requireWorkspacePath(workspaceId), ROOT_DIR, workspaceId, processId, OUTPUT_FILE)
  }

  private async findProcess(workspaceId: string, processId: string): Promise<PersistedBackgroundProcess | null> {
    const records = await this.readIndex(workspaceId)
    return records.find((entry) => entry.id === processId) ?? null
  }

  private async readIndex(workspaceId: string): Promise<PersistedBackgroundProcess[]> {
    return this.withWorkspaceTransaction(workspaceId, () => this.readIndexUnlocked(workspaceId))
  }

  private async readIndexUnlocked(workspaceId: string): Promise<PersistedBackgroundProcess[]> {
    const indexPath = await this.getIndexPath(workspaceId)
    if (!existsSync(indexPath)) return []

    // A corrupt/unreadable index is DATA, not "empty": every mutation reads it
    // through here, so it fails closed and can never overwrite the original
    // with an empty or partial list.
    const raw = await fs.readFile(indexPath, "utf-8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new BackgroundProcessIndexError(
        `Background process index is corrupt (invalid JSON) at ${indexPath}`,
        error,
      )
    }
    if (!Array.isArray(parsed)) {
      throw new BackgroundProcessIndexError(
        `Background process index is not an array at ${indexPath}`,
      )
    }
    return parsed as PersistedBackgroundProcess[]
  }

  private async upsertIndex(workspaceId: string, record: PersistedBackgroundProcess) {
    await this.withWorkspaceTransaction(workspaceId, async () => {
      const records = await this.readIndexUnlocked(workspaceId)
      const index = records.findIndex((entry) => entry.id === record.id)
      if (index >= 0) {
        records[index] = record
      } else {
        records.push(record)
      }
      await this.writeIndexUnlocked(workspaceId, records)
    })
  }

  private async removeFromIndex(workspaceId: string, processId: string) {
    await this.withWorkspaceTransaction(workspaceId, async () => {
      const records = await this.readIndexUnlocked(workspaceId)
      const next = records.filter((entry) => entry.id !== processId)
      await this.writeIndexUnlocked(workspaceId, next)
    })
  }

  private async writeIndexUnlocked(workspaceId: string, records: PersistedBackgroundProcess[]) {
    const indexPath = await this.getIndexPath(workspaceId)
    await fs.mkdir(path.dirname(indexPath), { recursive: true })
    if (this.deps.writeIndex) {
      await this.deps.writeIndex(indexPath, records)
      return
    }
    await fs.writeFile(indexPath, JSON.stringify(records, null, 2))
  }

  private async withWorkspaceTransaction<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceTransactions.get(workspaceId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tail = current.then(() => undefined, () => undefined)
    this.workspaceTransactions.set(workspaceId, tail)
    try {
      return await current
    } finally {
      if (this.workspaceTransactions.get(workspaceId) === tail) {
        this.workspaceTransactions.delete(workspaceId)
      }
    }
  }

  private async getIndexPath(workspaceId: string) {
    return path.join(this.requireWorkspacePath(workspaceId), ROOT_DIR, workspaceId, INDEX_FILE)
  }

  private async removeProcessDir(workspaceId: string, processId: string) {
    const workspacePath = this.getWorkspacePath(workspaceId)
    if (!workspacePath) return
    const processDir = path.join(workspacePath, ROOT_DIR, workspaceId, processId)
    await fs.rm(processDir, { recursive: true, force: true })
  }

  private async removeWorkspaceDir(workspaceId: string) {
    const workspacePath = this.getWorkspacePath(workspaceId)
    if (!workspacePath) return
    await this.withWorkspaceTransaction(workspaceId, async () => {
      const workspaceDir = path.join(workspacePath, ROOT_DIR, workspaceId)
      await fs.rm(workspaceDir, { recursive: true, force: true })
    })
  }

  private getWorkspacePath(workspaceId: string): string | undefined {
    const cached = this.workspacePaths.get(workspaceId)
    if (cached) return cached
    const workspace = this.deps.workspaceManager.get(workspaceId)
    if (!workspace) return undefined
    this.workspacePaths.set(workspaceId, workspace.path)
    return workspace.path
  }

  private requireWorkspacePath(workspaceId: string): string {
    const workspacePath = this.getWorkspacePath(workspaceId)
    if (!workspacePath) throw new Error("Workspace not found")
    return workspacePath
  }

  private async getOutputSize(workspaceId: string, processId: string): Promise<number> {
    const outputPath = this.getOutputPath(workspaceId, processId)
    if (!existsSync(outputPath)) {
      return 0
    }
    try {
      const stats = await fs.stat(outputPath)
      return stats.size
    } catch {
      return 0
    }
  }

  private publishUpdate(workspaceId: string, record: PersistedBackgroundProcess) {
    this.deps.eventBus.publish({
      type: "instance.event",
      instanceId: workspaceId,
      event: { type: "background.process.updated", properties: { process: this.toPublicProcess(record) } },
    })
  }

  private toPublicProcess(record: PersistedBackgroundProcess): BackgroundProcess {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      title: record.title,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      pid: record.pid,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt,
      exitCode: record.exitCode,
      outputSizeBytes: record.outputSizeBytes,
      terminalReason: record.terminalReason,
      notifyEnabled: Boolean(record.notify),
    }
  }

  private async finalizeRecord(workspaceId: string, record: PersistedBackgroundProcess, completion: ProcessCompletion) {
    if (this.shouldSendCompletionPrompt(record, completion)) {
      try {
        await this.sendCompletionPrompt(workspaceId, record)
        if (record.notify) {
          record.notify.sentAt = new Date().toISOString()
        }
      } catch (error) {
        this.deps.logger.warn({ err: error, workspaceId, processId: record.id }, "Failed to send background process completion prompt")
      }
    }

    if (completion.removeAfterFinalize) {
      await this.removeFromIndex(workspaceId, record.id)
      await this.removeProcessDir(workspaceId, record.id)

      this.deps.eventBus.publish({
        type: "instance.event",
        instanceId: workspaceId,
        event: { type: "background.process.removed", properties: { processId: record.id } },
      })
      return
    }

    await this.upsertIndex(workspaceId, record)
    record.outputSizeBytes = await this.getOutputSize(workspaceId, record.id)
    this.publishUpdate(workspaceId, record)
  }

  private shouldSendCompletionPrompt(record: PersistedBackgroundProcess, completion: ProcessCompletion) {
    if (completion.endContext === "workspace_cleanup") return false
    if (!record.notify) return false
    return !record.notify.sentAt
  }

  private async sendCompletionPrompt(workspaceId: string, record: PersistedBackgroundProcess) {
    const notify = record.notify
    if (!notify || !record.terminalReason) return

    const client = createInstanceClient(this.deps.workspaceManager, workspaceId, {
      directory: notify.directory,
    })
    if (!client) {
      throw new Error("Workspace instance is not ready")
    }

    await client.session.promptAsync(
      {
        sessionID: notify.sessionID,
        parts: [
          {
            type: "text",
            text: this.buildSyntheticCompletionPrompt(record),
            synthetic: true,
          },
        ],
      },
      { throwOnError: true },
    )
  }

  private buildCompletionPrompt(record: PersistedBackgroundProcess): string {
    const ref = `Background process "${record.title}" (${record.id})`

    switch (record.terminalReason) {
      case "finished":
        return `${ref} finished successfully.`
      case "failed":
        return record.exitCode === undefined ? `${ref} failed.` : `${ref} failed with exit code ${record.exitCode}.`
      case "user_stopped":
        return `${ref} was stopped by user.`
      case "user_terminated":
        return `${ref} was terminated by user.`
    }

    return `${ref} ended.`
  }

  private buildSyntheticCompletionPrompt(record: PersistedBackgroundProcess): string {
    return `<system-message>${this.escapeTaggedText(this.buildCompletionPrompt(record))}</system-message>`
  }

  private escapeTaggedText(input: string): string {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
  }

  private generateId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)
    const random = randomBytes(3).toString("hex")
    return `proc_${timestamp}_${random}`
  }
}
