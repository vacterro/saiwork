import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  probePosixProcesses,
  probeWindowsProcesses,
  sameProcess,
  signalPosixProcesses,
  signalWindowsProcesses,
  type GuardedSignalRequest,
  type ProcessIdentity,
  type ProcessSnapshot,
} from "./process-identity"

/**
 * Orphaned-workspace process cleanup.
 *
 * SAIWORK spawns one `opencode serve` per workspace. If the SAIWORK server is
 * killed hard (crash, task manager, power loss) those processes survive with no
 * owner. Each spawn is recorded here (workspaceId + pid + process start time);
 * on the next server start a sweep verifies the recorded pid still refers to
 * the SAME process (identity match, so a recycled pid is never touched) and
 * terminates it. Workspaces that stop cleanly are forgotten, so a non-empty
 * registry at startup is exactly the set of orphans.
 */

export interface OrphanEntry {
  workspaceId: string
  pid: number
  /** Immutable process identity captured at spawn (start time). */
  startTime: string
  folder: string
  launchedAt: number
}

type SpawnCommand = typeof spawnSync

export const ORPHAN_REGISTRY_FILE = "workspace-pids.json"

export function orphanRegistryPath(baseDir = path.join(os.homedir(), ".config", "saiwork")): string {
  return path.join(baseDir, ORPHAN_REGISTRY_FILE)
}

export function readOrphanRegistry(registryPath: string): OrphanEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isOrphanEntry)
  } catch {
    return []
  }
}

export function writeOrphanRegistry(registryPath: string, entries: OrphanEntry[]): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  fs.writeFileSync(registryPath, JSON.stringify(entries, null, 2))
}

function isOrphanEntry(value: unknown): value is OrphanEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  return typeof entry.workspaceId === "string" &&
    typeof entry.pid === "number" && Number.isInteger(entry.pid) && entry.pid > 0 &&
    typeof entry.startTime === "string" && entry.startTime.length > 0 &&
    typeof entry.folder === "string" &&
    typeof entry.launchedAt === "number"
}

export interface OrphanProbe {
  (spawnCommand: SpawnCommand, timeoutMs: number): ProcessSnapshot
}

export interface OrphanSignal {
  (spawnCommand: SpawnCommand, request: GuardedSignalRequest, timeoutMs: number): { ok: boolean; signalSent: boolean; error?: string }
}

export interface OrphanSweepOptions {
  platform?: NodeJS.Platform
  spawnCommand?: SpawnCommand
  timeoutMs?: number
  probe?: OrphanProbe
  signal?: OrphanSignal
}

export interface OrphanSweepResult {
  terminated: string[]
  failed: Array<{ workspaceId: string; error: string }>
}

/** Capture the immutable start-time identity of a freshly spawned pid. */
export function capturePidIdentity(
  pid: number,
  options: { platform?: NodeJS.Platform; spawnCommand?: SpawnCommand; timeoutMs?: number; probe?: OrphanProbe } = {},
): string | null {
  const platform = options.platform ?? process.platform
  const spawnCommand = options.spawnCommand ?? spawnSync
  const timeoutMs = options.timeoutMs ?? 10_000
  const probe = options.probe ?? (platform === "win32" ? probeWindowsProcesses : probePosixProcesses)
  const snapshot = probe(spawnCommand, timeoutMs)
  if (!snapshot.ok) return null
  const identity = snapshot.processes.get(pid)
  return identity ? identity.startTime : null
}

/**
 * Terminate recorded orphan processes whose identity still matches the current
 * process table. A pid whose start time differs (recycled) is left alone.
 * Returns the workspace ids that were signalled and any that failed.
 */
export function sweepOrphanProcesses(
  entries: OrphanEntry[],
  options: OrphanSweepOptions = {},
): OrphanSweepResult {
  const platform = options.platform ?? process.platform
  const spawnCommand = options.spawnCommand ?? spawnSync
  const timeoutMs = options.timeoutMs ?? 10_000
  const probe = options.probe ?? (platform === "win32" ? probeWindowsProcesses : probePosixProcesses)
  const nativeSignal = options.signal ?? (
    platform === "win32"
      ? (cmd: SpawnCommand, request: GuardedSignalRequest, ms: number) => signalWindowsProcesses(cmd, request, ms)
      : (cmd: SpawnCommand, request: GuardedSignalRequest, ms: number) => signalPosixProcesses(cmd, request, ms, platform)
  )
  const signal: OrphanSignal = (cmd, request, ms) => {
    const result = nativeSignal(cmd, request, ms) as { ok?: boolean; signalSent?: boolean; error?: string }
    return { ok: Boolean(result.ok), signalSent: Boolean(result.signalSent), ...(result.error ? { error: result.error } : {}) }
  }

  if (entries.length === 0) return { terminated: [], failed: [] }
  const snapshot = probe(spawnCommand, timeoutMs)
  if (!snapshot.ok) {
    return {
      terminated: [],
      failed: entries.map((entry) => ({ workspaceId: entry.workspaceId, error: snapshot.error })),
    }
  }

  const terminated: string[] = []
  const failed: Array<{ workspaceId: string; error: string }> = []
  for (const entry of entries) {
    const current = snapshot.processes.get(entry.pid)
    if (!current) continue
    if (!sameProcess(toIdentity(entry, current), current)) continue
    const request: GuardedSignalRequest = {
      leader: current,
      groupId: current.groupId,
      members: [current],
      signal: "SIGTERM",
      allowLeaderlessGroup: true,
    }
    const result = signal(spawnCommand, request, timeoutMs)
    if (result.ok && result.signalSent) {
      terminated.push(entry.workspaceId)
    } else {
      failed.push({ workspaceId: entry.workspaceId, error: result.error ?? "signal not sent" })
    }
  }
  return { terminated, failed }
}

function toIdentity(entry: OrphanEntry, current: ProcessIdentity): ProcessIdentity {
  return { pid: entry.pid, parentPid: current.parentPid, groupId: current.groupId, startTime: entry.startTime }
}
