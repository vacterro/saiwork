/**
 * Optional periodic git pull of the SAIPEN protocol install.
 *
 * Off by default: the protocol lives at a user-managed path and a background
 * pull is a mutation nobody asked for. When `autoUpdate` is enabled the home
 * directory (when it is a git repo) is fast-forward pulled on a bounded
 * interval; failures are logged, never fatal.
 */

import { execFile } from "child_process"
import { existsSync } from "fs"
import path from "path"

export const DEFAULT_SAIPEN_AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface SaipenAutoUpdateOptions {
  home: string
  intervalMs?: number
  logger?: { info: (message: string) => void; warn: (message: string) => void }
}

/** Starts the pull loop; returns a stop function. */
export function startSaipenAutoUpdate(options: SaipenAutoUpdateOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_SAIPEN_AUTO_UPDATE_INTERVAL_MS

  const run = () => {
    const gitDir = path.join(options.home, ".git")
    if (!existsSync(gitDir)) {
      options.logger?.warn(`[saipen] auto-update skipped: ${options.home} is not a git repository`)
      return
    }
    execFile("git", ["-C", options.home, "pull", "--ff-only"], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        options.logger?.warn(`[saipen] auto-update failed: ${error.message}${stderr ? ` ${stderr.trim()}` : ""}`)
        return
      }
      options.logger?.info(`[saipen] protocol auto-updated: ${stdout.trim()}`)
    })
  }

  run()
  const timer = setInterval(run, intervalMs)
  if (typeof timer.unref === "function") timer.unref()
  return () => clearInterval(timer)
}
