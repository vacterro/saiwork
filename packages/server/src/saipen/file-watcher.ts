import { createHash } from "crypto"
import { readdirSync, readFileSync, realpathSync, type FSWatcher, watch } from "fs"
import path from "path"
import type { WorkspaceEventPayload } from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import { pathEntryExists, resolvePathWithin } from "./path-security"

/**
 * Live SAIPEN change stream.
 *
 * Watches each registered workspace's `.saipen/` for the files the embedded
 * SAIPENVIEW renders (STATE/BOARD/LOG plus `kitchen/*.md`) and publishes a
 * debounced, workspace-scoped `saipen.changed` event so mounted panels can
 * refresh the affected slice instead of poll.
 *
 * Ownership follows the workspace lifecycle: the initial sweep covers workspaces
 * already running, and `workspace.started` / `workspace.created` attach watchers
 * while `workspace.stopped` detaches them. A workspace that loses its detached
 * owner still has the server as the single writer of truth, so the stream keeps
 * working no matter which window started it.
 */

export const SAIPEN_CHANGED_EVENT = "saipen.changed" as const

/** Coalesces a burst of fs events into one sweep. */
const DEBOUNCE_MS = 300
/**
 * Reliability backstop: fs.watch can miss rapid successive renames on Windows,
 * so re-sweep gently. Four small files per workspace every few seconds is not
 * aggressive polling -- it is a bounded guard against a dropped event.
 */
const SELF_HEAL_MS = 10_000

/** Files whose raw bytes the panel renders directly. */
const STATE_FILES = ["STATE.md", "BOARD.md", "LOG.md"] as const

export interface SaipenFileWatcherDeps {
  eventBus: EventBus
  logger: Logger
}

export interface SaipenWorkspaceHandle {
  id: string
  folder: string
}

interface FolderWatch {
  ids: Set<string>
  folder: string
  saipenDir: string
  /** relativePath -> SHA-256 of last observed bytes; "" means absent. */
  revisions: Map<string, string>
  watchersByTarget: Map<string, FSWatcher>
  timer: NodeJS.Timeout | null
  healTimer: NodeJS.Timeout | null
  /** The first sweep only records a baseline; nothing to diff against yet. */
  seeded: boolean
}

function canonicalFolder(folder: string): string | null {
  try {
    return path.normalize(realpathSync(folder))
  } catch {
    try {
      return path.normalize(path.resolve(folder))
    } catch {
      return null
    }
  }
}

function fileRevision(filePath: string | null): string {
  try {
    if (!filePath) return ""
    return createHash("sha256").update(readFileSync(filePath)).digest("hex")
  } catch {
    return ""
  }
}

export class SaipenFileWatcher {
  private readonly logger: Logger
  private readonly byFolder = new Map<string, FolderWatch>()
  private readonly folderById = new Map<string, string>()
  private stopEvents?: () => void

  constructor(private readonly deps: SaipenFileWatcherDeps) {
    this.logger = deps.logger
  }

  start(listWorkspaces: () => SaipenWorkspaceHandle[]): void {
    if (this.stopEvents) return
    for (const handle of listWorkspaces()) this.observe(handle)
    this.stopEvents = this.deps.eventBus.onEvent((event) => this.handleEvent(event))
  }

  stop(): void {
    this.stopEvents?.()
    this.stopEvents = undefined
    for (const entry of Array.from(this.byFolder.values())) this.teardown(entry)
    this.byFolder.clear()
    this.folderById.clear()
  }

  private handleEvent(event: WorkspaceEventPayload): void {
    if (event.type === "workspace.started" || event.type === "workspace.created") {
      this.observe({ id: event.workspace.id, folder: event.workspace.path })
      return
    }
    if (event.type === "workspace.stopped") {
      this.forget(event.workspaceId)
    }
  }

  private observe(handle: SaipenWorkspaceHandle): void {
    const folder = canonicalFolder(handle.folder)
    if (!folder) return
    const previousFolder = this.folderById.get(handle.id)
    if (previousFolder && previousFolder !== folder) this.forget(handle.id)
    const existing = this.byFolder.get(folder)
    if (existing) {
      existing.ids.add(handle.id)
      this.folderById.set(handle.id, folder)
      return
    }
    const entry: FolderWatch = {
      ids: new Set([handle.id]),
      folder,
      saipenDir: path.join(folder, ".saipen"),
      revisions: new Map(),
      watchersByTarget: new Map(),
      timer: null,
      healTimer: null,
      seeded: false,
    }
    this.byFolder.set(folder, entry)
    this.folderById.set(handle.id, folder)
    this.reconcileWatchers(entry)
    // Seed the revision baseline synchronously so changes that happen during the
    // attach window are still detected by the next event sweep, not swallowed as
    // an "initial" diff.
    this.sweep(entry)
    this.healTimer(entry)
  }

  private forget(id: string): void {
    const folder = this.folderById.get(id)
    if (!folder) return
    this.folderById.delete(id)
    const entry = this.byFolder.get(folder)
    if (!entry) return
    entry.ids.delete(id)
    if (entry.ids.size > 0) return
    this.teardown(entry)
    this.byFolder.delete(folder)
  }

  private teardown(entry: FolderWatch): void {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.healTimer) clearTimeout(entry.healTimer)
    entry.timer = null
    entry.healTimer = null
    for (const target of Array.from(entry.watchersByTarget.keys())) {
      this.closeWatcher(entry, target)
    }
  }

  private closeWatcher(entry: FolderWatch, target: string): void {
    const watcher = entry.watchersByTarget.get(target)
    if (!watcher) return
    entry.watchersByTarget.delete(target)
    try {
      watcher.close()
    } catch (error) {
      this.logger.warn({ folder: entry.folder, target, error }, "Failed to close SAIPEN watcher")
    }
  }

  /**
   * Desired targets: the `.saipen` dir (plus its kitchen subdir) when it exists,
   * otherwise the workspace root so the `.saipen` directory appearing is caught.
   * Non-recursive everywhere, so project churn never floods the watcher.
   */
  private reconcileWatchers(entry: FolderWatch): void {
    const saipenDir = pathEntryExists(entry.saipenDir)
      ? resolvePathWithin(entry.folder, entry.saipenDir)
      : null
    const kitchenPath = saipenDir ? path.join(saipenDir, "kitchen") : null
    const kitchenDir = kitchenPath && pathEntryExists(kitchenPath)
      ? resolvePathWithin(saipenDir!, kitchenPath)
      : null
    const desired = saipenDir
      ? [saipenDir, ...(kitchenDir ? [kitchenDir] : [])]
      : [entry.folder]
    for (const target of Array.from(entry.watchersByTarget.keys())) {
      if (!desired.includes(target)) this.closeWatcher(entry, target)
    }
    for (const target of desired) {
      if (entry.watchersByTarget.has(target)) continue
      try {
        const watcher = watch(target, () => this.scheduleSweep(entry))
        watcher.on("error", (error) => {
          this.logger.warn({ folder: entry.folder, target, error }, "SAIPEN watcher error")
          this.closeWatcher(entry, target)
        })
        entry.watchersByTarget.set(target, watcher)
      } catch (error) {
        this.logger.warn({ folder: entry.folder, target, error }, "Failed to attach SAIPEN watcher")
      }
    }
  }

  private scheduleSweep(entry: FolderWatch): void {
    if (this.byFolder.get(entry.folder) !== entry) return
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (this.byFolder.get(entry.folder) !== entry) return
      this.sweep(entry)
    }, DEBOUNCE_MS)
  }

  private healTimer(entry: FolderWatch): void {
    entry.healTimer = setTimeout(() => {
      entry.healTimer = null
      if (!this.byFolder.has(entry.folder)) return
      this.sweep(entry)
      this.healTimer(entry)
    }, SELF_HEAL_MS)
  }

  private sweep(entry: FolderWatch): void {
    if (this.byFolder.get(entry.folder) !== entry) return
    this.reconcileWatchers(entry)
    const initial = !entry.seeded
    entry.seeded = true
    const changed: string[] = []

    const update = (relativePath: string, file: string | null): void => {
      const current = fileRevision(file)
      const previous = entry.revisions.get(relativePath)
      if (previous === current) return
      entry.revisions.set(relativePath, current)
      changed.push(relativePath)
    }

    const saipenDir = pathEntryExists(entry.saipenDir)
      ? resolvePathWithin(entry.folder, entry.saipenDir)
      : null
    for (const name of STATE_FILES) {
      const candidate = saipenDir ? path.join(saipenDir, name) : null
      const safeFile = candidate && pathEntryExists(candidate)
        ? resolvePathWithin(saipenDir!, candidate)
        : null
      update(name, safeFile)
    }

    const kitchenPath = saipenDir ? path.join(saipenDir, "kitchen") : null
    const kitchenDir = kitchenPath && pathEntryExists(kitchenPath)
      ? resolvePathWithin(saipenDir!, kitchenPath)
      : null
    let kitchenNames: string[] = []
    try {
      if (kitchenDir) {
        kitchenNames = readdirSync(kitchenDir).filter((name) => name.endsWith(".md")).sort()
      }
    } catch (error) {
      this.logger.warn({ folder: entry.folder, error }, "Failed to list SAIPEN kitchen plans")
    }
    for (const name of kitchenNames) {
      const candidate = path.join(kitchenDir!, name)
      update(`kitchen/${name}`, resolvePathWithin(kitchenDir!, candidate))
    }
    for (const relativePath of Array.from(entry.revisions.keys())) {
      if (!relativePath.startsWith("kitchen/")) continue
      if (kitchenNames.includes(relativePath.slice("kitchen/".length))) continue
      const candidate = kitchenDir
        ? path.join(kitchenDir, relativePath.slice("kitchen/".length))
        : null
      update(relativePath, candidate && pathEntryExists(candidate) ? resolvePathWithin(kitchenDir!, candidate) : null)
    }

    if (changed.length > 0 && !initial) {
      this.deps.eventBus.publish({ type: SAIPEN_CHANGED_EVENT, folder: entry.folder, files: changed })
    }
  }
}
