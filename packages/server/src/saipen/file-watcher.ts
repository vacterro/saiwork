import { createHash } from "crypto"
import { existsSync, readdirSync, readFileSync, realpathSync, type FSWatcher, watch } from "fs"
import path from "path"
import type { WorkspaceEventPayload } from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"

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
  id: string
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

function fileRevision(filePath: string): string {
  try {
    if (!existsSync(filePath)) return ""
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
      const folder = this.folderById.get(event.workspaceId)
      if (folder) this.forget(folder)
    }
  }

  private observe(handle: SaipenWorkspaceHandle): void {
    const folder = canonicalFolder(handle.folder)
    if (!folder) return
    const existing = this.byFolder.get(folder)
    if (existing) {
      if (!this.folderById.has(handle.id)) this.folderById.set(handle.id, folder)
      return
    }
    const entry: FolderWatch = {
      id: handle.id,
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

  private forget(folder: string): void {
    const entry = this.byFolder.get(folder)
    if (!entry) return
    this.teardown(entry)
    this.byFolder.delete(folder)
    if (this.folderById.get(entry.id) === folder) this.folderById.delete(entry.id)
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
    const saipenExists = existsSync(entry.saipenDir)
    const kitchenDir = path.join(entry.saipenDir, "kitchen")
    const desired = saipenExists
      ? [entry.saipenDir, ...(existsSync(kitchenDir) ? [kitchenDir] : [])]
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
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
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
    this.reconcileWatchers(entry)
    const initial = !entry.seeded
    entry.seeded = true
    const changed: string[] = []

    const update = (relativePath: string, file: string): void => {
      const current = fileRevision(file)
      const previous = entry.revisions.get(relativePath)
      if (previous === current) return
      entry.revisions.set(relativePath, current)
      changed.push(relativePath)
    }

    for (const name of STATE_FILES) {
      update(name, path.join(entry.saipenDir, name))
    }

    const kitchenDir = path.join(entry.saipenDir, "kitchen")
    let kitchenNames: string[] = []
    try {
      if (existsSync(kitchenDir)) {
        kitchenNames = readdirSync(kitchenDir).filter((name) => name.endsWith(".md")).sort()
      }
    } catch (error) {
      this.logger.warn({ folder: entry.folder, error }, "Failed to list SAIPEN kitchen plans")
    }
    for (const name of kitchenNames) {
      update(`kitchen/${name}`, path.join(kitchenDir, name))
    }
    for (const relativePath of Array.from(entry.revisions.keys())) {
      if (!relativePath.startsWith("kitchen/")) continue
      if (kitchenNames.includes(relativePath.slice("kitchen/".length))) continue
      update(relativePath, path.join(kitchenDir, relativePath.slice("kitchen/".length)))
    }

    if (changed.length > 0 && !initial) {
      this.deps.eventBus.publish({ type: SAIPEN_CHANGED_EVENT, folder: entry.folder, files: changed })
    }
  }
}
