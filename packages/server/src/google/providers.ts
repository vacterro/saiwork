import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { getString } from "../usage/shared"
import {
  ANTIGRAVITY_PROVIDER_ID,
  GEMINI_API_PROVIDER_ID,
  type GoogleProviderId,
  type GoogleProviderInfo,
  type GoogleProviderStatus,
} from "./types"

/**
 * Capability detection for the two independent Google providers.
 *
 * Gemini API (API key) and Antigravity (Google OAuth subscription) never share
 * an auth state. Detection only answers "is this provider usable right now";
 * it never reads OAuth tokens into memory beyond a boolean validity probe and
 * never logs credentials.
 */

const GEMINI_KEY_ENV_VARS = ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const

interface AntigravityAccountFile {
  accounts?: Array<{ accessToken?: unknown; access_token?: unknown; refreshToken?: unknown; refresh_token?: unknown }>
  active?: { accessToken?: unknown; access_token?: unknown; refreshToken?: unknown; refresh_token?: unknown } | null
}

export interface GoogleDetectionOverrides {
  env?: NodeJS.ProcessEnv
  exists?: (filePath: string) => boolean
  readFile?: (filePath: string) => string
  /** Home dir used for the Antigravity and plugin lookup paths. */
  home?: string
  /** OpenCode data dir (auth.json / plugins) lookup root. */
  opencodeDataHome?: string
  opencodeConfigHome?: string
}

interface DetectionDeps {
  env: NodeJS.ProcessEnv
  exists: (filePath: string) => boolean
  readFile: (filePath: string) => string
  home: string
  opencodeDataHome: string
  opencodeConfigHome: string
}

function resolveDeps(overrides: GoogleDetectionOverrides = {}): DetectionDeps {
  const home = overrides.home ?? os.homedir()
  const xdgDataHome = getString(process.env.XDG_DATA_HOME) ?? ""
  const dataHome = overrides.opencodeDataHome ??
    (xdgDataHome ? path.join(xdgDataHome, "opencode") :
      path.join(home, ".local", "share", "opencode"))
  const configHome = overrides.opencodeConfigHome ??
    path.join(home, ".config", "opencode")
  return {
    env: overrides.env ?? process.env,
    exists: overrides.exists ?? existsSync,
    readFile: overrides.readFile ?? ((filePath) => readFileSync(filePath, "utf8")),
    home,
    opencodeDataHome: dataHome,
    opencodeConfigHome: configHome,
  }
}

/** Resolve the Gemini API key for spawn env injection. Never logged. */
export function resolveGeminiApiKey(overrides: GoogleDetectionOverrides = {}): string | null {
  const deps = resolveDeps(overrides)
  for (const name of GEMINI_KEY_ENV_VARS) {
    const value = getString(deps.env[name])
    if (value) return value
  }
  // OpenCode auth.json under the data home: `google` as either an api entry
  // ({type:"api", key}) or a plain string. Read from the same paths OpenCode
  // uses so detection and execution agree on one source of truth.
  const authPath = path.join(deps.opencodeDataHome, "auth.json")
  try {
    if (!deps.exists(authPath)) return null
    const raw = JSON.parse(deps.readFile(authPath)) as Record<string, unknown>
    const google = raw.google
    if (typeof google === "string" && google.trim()) return google.trim()
    if (google && typeof google === "object") {
      const entry = google as Record<string, unknown>
      if (entry.type === "api") return getString(entry.key)
      return getString(entry.key) ?? getString(entry.token)
    }
  } catch {
    return null
  }
  return null
}

export interface AntigravityDetection {
  /** True when an OpenCode runtime that can host a Google OAuth adapter exists. */
  opencodeAvailable: boolean
  /** True when an Antigravity adapter is installed (community plugin). */
  adapterInstalled: boolean
  /** True when an active Antigravity OAuth session is present. */
  sessionAvailable: boolean
}

export function detectAntigravity(overrides: GoogleDetectionOverrides = {}): AntigravityDetection {
  const deps = resolveDeps(overrides)
  const opencodeAvailable = deps.env.OPENCODE_BINARY_PATH !== undefined ||
    existsAny(deps, [
      path.join(deps.opencodeDataHome, "bin", "opencode"),
      path.join(deps.opencodeDataHome, "bin", "opencode.exe"),
    ]) || envCommandOnPath(deps, "opencode")

  const adapterInstalled = existsAny(deps, [
    path.join(deps.opencodeConfigHome, "plugins", "opencode-antigravity-auth"),
    path.join(deps.opencodeDataHome, "plugins", "opencode-antigravity-auth"),
    path.join(deps.home, ".gemini", "antigravity"),
  ])

  const sessionAvailable = readAntigravityAccessToken(deps) !== null

  return { opencodeAvailable, adapterInstalled, sessionAvailable }
}

/** Returns a fresh (or stored) Antigravity OAuth access token, or null. */
export function readAntigravityAccessToken(deps: DetectionDeps): string | null {
  // OpenCode's antigravity-accounts.json (active account first).
  for (const candidate of [
    path.join(deps.opencodeConfigHome, "antigravity-accounts.json"),
    path.join(deps.opencodeDataHome, "antigravity-accounts.json"),
  ]) {
    try {
      if (!deps.exists(candidate)) continue
      const parsed = JSON.parse(deps.readFile(candidate)) as AntigravityAccountFile
      const account = parsed.active ?? parsed.accounts?.[0]
      const token = getString(account?.accessToken) ?? getString(account?.access_token)
      if (token) return token
    } catch {
      continue
    }
  }
  // The Antigravity IDE's own credential store.
  const geminiAccounts = path.join(deps.home, ".gemini", "google_accounts.json")
  try {
    if (deps.exists(geminiAccounts)) {
      const parsed = JSON.parse(deps.readFile(geminiAccounts)) as AntigravityAccountFile
      const token = getString(parsed.active?.accessToken) ?? getString(parsed.active?.access_token)
      if (token) return token
    }
  } catch {
    // fall through
  }
  // OpenCode's own google OAuth entry (oauth mode) in the same auth.json.
  const authPath = path.join(deps.opencodeDataHome, "auth.json")
  try {
    if (deps.exists(authPath)) {
      const raw = JSON.parse(deps.readFile(authPath)) as Record<string, unknown>
      const google = raw.google
      if (google && typeof google === "object") {
        const entry = google as Record<string, unknown>
        const token = getString(entry.accessToken) ?? getString(entry.access) ?? getString(entry.token)
        if (token) return token
      }
      const oauth = raw["google.oauth"]
      if (oauth && typeof oauth === "object") {
        const entry = oauth as Record<string, unknown>
        const token = getString(entry.accessToken) ?? getString(entry.access) ?? getString(entry.token)
        if (token) return token
      }
    }
  } catch {
    // fall through
  }
  return null
}

function geminiApiStatus(keyPresent: boolean): GoogleProviderStatus {
  return keyPresent ? "ready" : "not_configured"
}

function antigravityStatus(detection: AntigravityDetection): GoogleProviderStatus {
  if (!detection.opencodeAvailable) return "unavailable"
  if (!detection.adapterInstalled) return "plugin_missing"
  if (!detection.sessionAvailable) return "not_configured"
  return "ready"
}

export function googleProviderStatus(
  overrides: GoogleDetectionOverrides = {},
): GoogleProviderInfo[] {
  const deps = resolveDeps(overrides)
  const geminiKey = resolveGeminiApiKey({ ...overrides, env: deps.env })
  const antigravity = detectAntigravity({ ...overrides, env: deps.env })

  const geminiApi: GoogleProviderInfo = {
    id: GEMINI_API_PROVIDER_ID,
    name: "Gemini API",
    description: "Official Google Gemini Developer API. Billed to your Google AI Studio / Cloud project, not your AI Pro subscription.",
    experimental: false,
    status: geminiApiStatus(geminiKey !== null),
    detail: geminiKey !== null ? "API key detected (env or OpenCode auth)" : "No API key configured. Set GEMINI_API_KEY or connect the google provider in OpenCode.",
    modelCount: 0,
  }

  const antigravityInfo: GoogleProviderInfo = {
    id: ANTIGRAVITY_PROVIDER_ID,
    name: "Antigravity",
    description: "Google AI Pro / Antigravity subscription through a Google OAuth OpenCode adapter. Experimental.",
    experimental: true,
    status: antigravityStatus(antigravity),
    detail: antigravityDetail(antigravity),
    modelCount: 0,
  }

  return [geminiApi, antigravityInfo]
}

function antigravityDetail(detection: AntigravityDetection): string | null {
  if (!detection.opencodeAvailable) return "OpenCode runtime unavailable."
  if (!detection.adapterInstalled) return "Antigravity adapter not installed. Optional integration; SAIWORK keeps working without it."
  if (!detection.sessionAvailable) return "Antigravity OAuth session required. Sign in to Antigravity to enable this provider."
  return null
}

function existsAny(deps: DetectionDeps, candidates: string[]): boolean {
  for (const candidate of candidates) {
    try {
      if (deps.exists(candidate)) return true
    } catch {
      continue
    }
  }
  return false
}

function envCommandOnPath(deps: DetectionDeps, name: string): boolean {
  const pathValue = getString(deps.env.PATH) ?? ""
  return pathValue.split(path.delimiter).some((entry) => {
    try {
      return deps.exists(path.join(entry, process.platform === "win32" ? `${name}.exe` : name))
    } catch {
      return false
    }
  })
}

export function providerStatusLabel(status: GoogleProviderStatus): string {
  switch (status) {
    case "ready": return "ready"
    case "auth_required": return "auth_required"
    case "not_configured": return "not_configured"
    case "plugin_missing": return "plugin_missing"
    case "unavailable": return "unavailable"
  }
}

export type { GoogleProviderId }
