import fs from "fs"
import { promises as fsp } from "fs"
import path from "path"
import type { WorktreeMap } from "../api-types"
import { atomicWriteFile } from "../atomic-write"
import { resolveRepoRoot } from "./git-worktrees"
import type { LogLike } from "./git-worktrees"

const DEFAULT_MAP: WorktreeMap = {
  version: 1,
  defaultWorktreeSlug: "root",
  parentSessionWorktreeSlug: {},
}

export class WorktreeMapCorruptionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = "WorktreeMapCorruptionError"
  }
}

function getMapPath(repoRoot: string): string {
  return path.join(repoRoot, ".saiwork", "worktreeMap.json")
}

function getGitExcludePath(repoRoot: string): string {
  return path.join(repoRoot, ".git", "info", "exclude")
}

/** Per-repo serialized read-modify-write lock. */
const mapLocks = new Map<string, Promise<unknown>>()

function withRepoLock<T>(repoRoot: string, operation: () => Promise<T>): Promise<T> {
  const previous = mapLocks.get(repoRoot) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(operation)
  const tail = run.then(() => undefined, () => undefined)
  mapLocks.set(repoRoot, tail)
  return run.finally(() => {
    if (mapLocks.get(repoRoot) === tail) mapLocks.delete(repoRoot)
  })
}

/**
 * Validate a worktree map completely. A wrong version, a missing/empty
 * default slug, a non-plain parent mapping, or any invalid session id or
 * worktree slug rejects the whole map; entries are never silently dropped.
 */
export function validateWorktreeMap(value: unknown): value is WorktreeMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.version !== 1) return false
  if (typeof record.defaultWorktreeSlug !== "string" || record.defaultWorktreeSlug.trim() === "") return false
  const mapping = record.parentSessionWorktreeSlug
  if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) return false
  for (const [sessionId, slug] of Object.entries(mapping as Record<string, unknown>)) {
    if (typeof sessionId !== "string" || sessionId.trim() === "") return false
    if (typeof slug !== "string" || slug.trim() === "") return false
  }
  return true
}

async function ensureGitExclude(repoRoot: string, logger?: LogLike): Promise<void> {
  const excludePath = getGitExcludePath(repoRoot)
  try {
    await fsp.mkdir(path.dirname(excludePath), { recursive: true })
  } catch {
    return
  }

  const entries = [
    ".saiwork/background_processes/",
    ".saiwork/worktrees/",
    ".saiwork/worktreeMap.json",
  ]

  let existing = ""
  try {
    existing = await fsp.readFile(excludePath, "utf-8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      logger?.debug?.({ err: error, excludePath }, "Failed to read .git/info/exclude")
      return
    }
    existing = ""
  }

  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  const missing = entries.filter((e) => !lines.has(e))
  if (missing.length === 0) {
    return
  }

  const header = existing.includes("# saiwork") ? "" : (existing.trim() ? "\n" : "") + "# saiwork\n"
  const suffix = missing.map((e) => `${e}\n`).join("")
  await fsp.writeFile(excludePath, `${existing}${header}${suffix}`, "utf-8")
}

export async function ensureSaiworkGitExclude(workspaceFolder: string, logger?: LogLike): Promise<void> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  if (!isGitRepo) {
    return
  }
  await ensureGitExclude(repoRoot, logger)
}

export async function readWorktreeMap(workspaceFolder: string, logger?: LogLike): Promise<WorktreeMap> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  const filePath = getMapPath(repoRoot)
  let raw: string
  try {
    raw = await fsp.readFile(filePath, "utf-8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      if (isGitRepo) {
        // Best-effort ignore setup on first use.
        await ensureGitExclude(repoRoot, logger).catch(() => undefined)
      }
      return cloneMap(DEFAULT_MAP)
    }
    throw new WorktreeMapCorruptionError(`Worktree map is unreadable at ${filePath}`, error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new WorktreeMapCorruptionError(`Worktree map is corrupt (invalid JSON) at ${filePath}`, error)
  }
  if (!validateWorktreeMap(parsed)) {
    throw new WorktreeMapCorruptionError(`Worktree map has an invalid structure at ${filePath}`)
  }
  return cloneMap(parsed)
}

export async function writeWorktreeMap(workspaceFolder: string, next: WorktreeMap, logger?: LogLike): Promise<void> {
  const { repoRoot, isGitRepo } = await resolveRepoRoot(workspaceFolder, logger)
  const filePath = getMapPath(repoRoot)
  await fsp.mkdir(path.dirname(filePath), { recursive: true })

  if (isGitRepo) {
    await ensureGitExclude(repoRoot, logger).catch(() => undefined)
  }

  // Validate the incoming map before persisting anything.
  if (!validateWorktreeMap(next)) {
    throw new WorktreeMapCorruptionError("Refusing to persist an invalid worktree map")
  }

  if (Object.keys(next.parentSessionWorktreeSlug).length === 0) {
    await deleteWorktreeMap(workspaceFolder, logger)
    return
  }

  await withRepoLock(repoRoot, async () => {
    // Never silently overwrite a corrupt existing map with a believable empty one.
    if (fs.existsSync(filePath)) {
      let raw: string
      try {
        raw = await fsp.readFile(filePath, "utf-8")
      } catch (error) {
        throw new WorktreeMapCorruptionError(`Worktree map is unreadable at ${filePath}`, error)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new WorktreeMapCorruptionError(`Worktree map is corrupt (invalid JSON) at ${filePath}; refusing to overwrite`, error)
      }
      if (!validateWorktreeMap(parsed)) {
        throw new WorktreeMapCorruptionError(`Worktree map has an invalid structure at ${filePath}; refusing to overwrite`)
      }
    }
    await atomicWriteFile(filePath, JSON.stringify(next, null, 2))
  })
}

export async function deleteWorktreeMap(workspaceFolder: string, logger?: LogLike): Promise<void> {
  const { repoRoot } = await resolveRepoRoot(workspaceFolder, logger)
  const filePath = getMapPath(repoRoot)
  await withRepoLock(repoRoot, async () => {
    try {
      await fsp.rm(filePath, { force: true })
    } catch (error) {
      logger?.warn?.({ err: error, filePath }, "Failed to delete worktree map")
      throw error
    }
  })
}

export function worktreeMapExists(repoRoot: string): boolean {
  try {
    return fs.existsSync(getMapPath(repoRoot))
  } catch {
    return false
  }
}

function cloneMap(map: WorktreeMap): WorktreeMap {
  return {
    version: map.version,
    defaultWorktreeSlug: map.defaultWorktreeSlug,
    parentSessionWorktreeSlug: { ...map.parentSessionWorktreeSlug },
  }
}
