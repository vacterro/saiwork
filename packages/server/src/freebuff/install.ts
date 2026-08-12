import { existsSync, readFileSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { FreebuffAuthState, FreebuffUser } from "./types"

/**
 * Locate the bundled FreeBuff desktop engine on disk.
 *
 * SAIWORK embeds the official FreeBuff orchestrator as its FreeBuff engine
 * rather than calling codebuff.com directly: the backend rejects non-official
 * clients in free mode (`free_mode_cli_required`), while the desktop engine is
 * the sanctioned client and reuses the account already logged in via
 * `~/.config/freebuff-desktop/state.json`.
 *
 * Resolution order for the install root:
 *   1. SAIWORK_FREEBUFF_HOME - directory whose `resources/...` layout matches
 *      the desktop install (used when FreeBuff lives elsewhere).
 *   2. Standard desktop install locations per platform.
 */

const DESKTOP_INSTALL_CANDIDATES = (): string[] => {
  const home = os.homedir()
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
  const candidates: string[] = []
  switch (process.platform) {
    case "win32":
      candidates.push(
        path.join(localAppData, "Programs", "@codebufffreebuff-desktop"),
        path.join(localAppData, "@codebufffreebuff-desktop"),
      )
      break
    case "darwin":
      candidates.push(
        path.join(appData, "Freebuff.app", "Contents", "Resources"),
        "/Applications/Freebuff.app/Contents/Resources",
      )
      break
    default:
      candidates.push(
        path.join(appData, "freebuff"),
        "/opt/freebuff",
        "/usr/lib/freebuff",
      )
  }
  return candidates
}

/**
 * FreeBuff updates may rename the app directory (the scoped npm-style folder
 * has changed before). Fall back to scanning common app roots for any folder
 * that carries the `resources/orchestrator/orchestrator.js` layout, so a
 * renamed install is still found.
 */
function scanDesktopInstallRoots(): string[] {
  const home = os.homedir()
  const roots: string[] = []
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    roots.push(path.join(localAppData, "Programs"), localAppData)
  } else if (process.platform === "darwin") {
    roots.push("/Applications")
  } else {
    roots.push("/opt", "/usr/lib")
  }
  const found: string[] = []
  for (const root of roots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!/codebuff|freebuff/i.test(entry.name)) continue
        found.push(path.join(root, entry.name))
      }
    } catch {
      // A missing root is not fatal; other roots are still scanned.
    }
  }
  return found
}

const STATE_FILE_CANDIDATES = (): string[] => {
  const home = os.homedir()
  return [
    process.env.SAIWORK_FREEBUFF_STATE,
    path.join(home, ".config", "freebuff-desktop", "state.json"),
  ].filter((entry): entry is string => Boolean(entry))
}

export interface FreebuffInstall {
  root: string
  bunPath: string
  orchestratorPath: string
  /** Account already signed in for this FreeBuff install, if any. */
  auth: FreebuffAuthState | null
}

interface RawStateFile {
  authSessions?: Record<string, { token?: unknown; user?: unknown } | undefined>
  authToken?: unknown
  authUser?: unknown
}

interface RawUser {
  id?: unknown
  email?: unknown
  name?: unknown
}

function parseUser(value: unknown): FreebuffUser | null {
  if (typeof value !== "object" || value === null) return null
  const raw = value as RawUser
  const id = typeof raw.id === "string" ? raw.id : ""
  if (!id) return null
  return {
    id,
    ...(typeof raw.email === "string" ? { email: raw.email } : {}),
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
  }
}

function parseAuthState(raw: unknown): FreebuffAuthState | null {
  if (typeof raw !== "object" || raw === null) return null
  const file = raw as RawStateFile
  if (file.authSessions) {
    for (const session of Object.values(file.authSessions)) {
      const token = typeof session?.token === "string" ? session.token : ""
      if (!token) continue
      return { token, user: parseUser(session?.user) }
    }
  }
  const legacyToken = typeof file.authToken === "string" ? file.authToken : ""
  if (!legacyToken) return null
  return { token: legacyToken, user: parseUser(file.authUser) }
}

export function readFreebuffAuth(overrides: { readFile?: (filePath: string) => string } = {}): FreebuffAuthState | null {
  const read = overrides.readFile ?? ((filePath) => readFileSync(filePath, "utf8"))
  for (const candidate of STATE_FILE_CANDIDATES()) {
    if (!candidate) continue
    try {
      if (!existsSync(candidate)) continue
      return parseAuthState(JSON.parse(read(candidate)))
    } catch {
      // Corrupt state file on one candidate is not fatal; try the next.
      continue
    }
  }
  return null
}

export function locateFreebuffInstall(
  overrides: {
    home?: string
    exists?: (filePath: string) => boolean
  } = {},
): FreebuffInstall | null {
  const exists = overrides.exists ?? existsSync
  const candidates = overrides.home
    ? [overrides.home]
    : [...DESKTOP_INSTALL_CANDIDATES(), ...scanDesktopInstallRoots()]

  for (const root of candidates) {
    // Windows/macOS/Linux share the `resources/{bun,orchestrator}` layout of
    // the desktop app. A user-supplied home may point straight at `resources`.
    const resources = /(?:resources)?[\\/]$/.test(root) ? root : path.join(root, "resources")
    const bunPath = path.join(resources, "bun", process.platform === "win32" ? "bun.exe" : "bun")
    const orchestratorPath = path.join(resources, "orchestrator", "orchestrator.js")
    try {
      if (exists(bunPath) && exists(orchestratorPath)) {
        return {
          root,
          bunPath,
          orchestratorPath,
          auth: readFreebuffAuth(),
        }
      }
    } catch {
      continue
    }
  }
  return null
}
