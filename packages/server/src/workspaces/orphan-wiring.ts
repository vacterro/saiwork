import { spawnSync } from "node:child_process"

import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import {
  capturePidIdentity,
  readOrphanRegistry,
  sweepOrphanProcesses,
  writeOrphanRegistry,
  type OrphanEntry,
  type OrphanProbe,
  type OrphanSignal,
} from "./orphan-cleanup"
import type { WorkspaceDescriptor } from "../api-types"

export interface OrphanCleanupControllerOptions {
  registryPath: string
  eventBus: EventBus
  logger: Logger
  platform?: NodeJS.Platform
  spawnCommand?: typeof spawnSync
  probe?: OrphanProbe
  signal?: OrphanSignal
  /** Injectable registry IO for tests. */
  read?: (registryPath: string) => OrphanEntry[]
  write?: (registryPath: string, entries: OrphanEntry[]) => void
}

/**
 * Wires the orphan-process registry to workspace lifecycle events and runs one
 * sweep on server start. Workspaces that stop cleanly are forgotten, so the
 * entries left at startup are exactly the processes a previous, hard-killed
 * SAIWORK run abandoned.
 */
export function createOrphanCleanupController(options: OrphanCleanupControllerOptions) {
  const read = options.read ?? readOrphanRegistry
  const write = options.write ?? writeOrphanRegistry
  const common = {
    platform: options.platform,
    spawnCommand: options.spawnCommand,
    probe: options.probe,
    signal: options.signal,
  }

  const record = (workspace: WorkspaceDescriptor) => {
    if (!workspace.pid) return
    const startTime = capturePidIdentity(workspace.pid, { ...common })
    if (!startTime) {
      options.logger.warn({ workspaceId: workspace.id, pid: workspace.pid }, "Could not capture process identity for orphan tracking")
      return
    }
    const entries = read(options.registryPath).filter((entry) => entry.workspaceId !== workspace.id)
    entries.push({
      workspaceId: workspace.id,
      pid: workspace.pid,
      startTime,
      folder: workspace.path,
      launchedAt: Date.now(),
    })
    try {
      write(options.registryPath, entries)
    } catch (error) {
      options.logger.warn({ workspaceId: workspace.id, error }, "Failed to persist workspace process for orphan tracking")
    }
  }

  const forget = (workspaceId: string) => {
    const entries = read(options.registryPath).filter((entry) => entry.workspaceId !== workspaceId)
    if (entries.length === read(options.registryPath).length) return
    try {
      write(options.registryPath, entries)
    } catch {
      // A stale entry only causes a harmless probe-and-skip at the next start.
    }
  }

  const unsubscribeStarted = () => {
    options.eventBus.off("workspace.started", onStarted)
  }
  const unsubscribeStopped = () => {
    options.eventBus.off("workspace.stopped", onStopped)
  }
  const onStarted = (event: unknown) => {
    if (event && typeof event === "object" && (event as { type?: string }).type === "workspace.started") {
      record((event as { workspace: WorkspaceDescriptor }).workspace)
    }
  }
  const onStopped = (event: unknown) => {
    if (event && typeof event === "object" && (event as { type?: string }).type === "workspace.stopped") {
      forget((event as { workspaceId: string }).workspaceId)
    }
  }
  options.eventBus.on("workspace.started", onStarted)
  options.eventBus.on("workspace.stopped", onStopped)

  const sweep = () => {
    const entries = read(options.registryPath)
    if (entries.length === 0) return
    const result = sweepOrphanProcesses(entries, common)
    if (result.terminated.length > 0) {
      options.logger.warn(
        { terminated: result.terminated.length, failed: result.failed.length },
        "Terminated orphaned workspace processes from a previous run",
      )
    }
    if (result.failed.length > 0) {
      options.logger.warn({ failed: result.failed }, "Some orphaned workspace processes could not be terminated")
    }
    const remaining = entries.filter((entry) => !result.terminated.includes(entry.workspaceId))
    try {
      write(options.registryPath, remaining)
    } catch {
      // Best-effort: the sweep is advisory, never fatal.
    }
  }

  return {
    sweep,
    stop() {
      unsubscribeStarted()
      unsubscribeStopped()
    },
  }
}
