import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import os from "os"
import path from "path"
import { createLogger } from "../logger"

const log = createLogger({ component: "saipen-core" })

/**
 * SAIPEN Core protocol injection.
 *
 * SAIWORK does not ship a copy of the protocol. It points OpenCode at the live
 * `saipen/` install so that edits made in the maintained repository take effect
 * on the next session with no rebuild here -- a vendored copy would silently
 * drift and there would be no signal when it did.
 *
 * The kernel is delivered through OpenCode's `instructions` config field, which
 * takes file paths and loads them into every session's system context.
 */

export const SAIPEN_HOME_ENV = "SAIPEN_HOME"

/**
 * BOOT.md is the cold-start kernel and STYLE.md is the voice contract that
 * BOOT.md step 1 requires before any output. Both are needed for a conformant
 * start; the rest of the protocol is loaded on demand by the agent itself.
 */
export const DEFAULT_SAIPEN_FILES = ["BOOT.md", "STYLE.md"] as const

export interface SaipenSettings {
  enabled?: boolean
  home?: string
  /** File names relative to the resolved protocol dir. */
  files?: string[]
  /** Extra absolute paths appended verbatim. */
  extraInstructions?: string[]
}

export interface SaipenResolveOptions {
  /**
   * Workspace folder being opened. A project already running the protocol
   * records its own `saipen_home` in `.saipen/STATE.md`, which is a better
   * answer than anything configured globally.
   */
  workspaceFolder?: string
}

export interface SaipenResolution {
  enabled: boolean
  /** The install root, e.g. `V:\...\_SAIPEN`. */
  home: string | null
  /** Where BOOT.md actually lives -- `<home>/saipen` or `<home>`. */
  protocolDir: string | null
  /** Absolute, forward-slashed paths handed to OpenCode. */
  instructions: string[]
  /** Requested files that are not on disk. Surfaced, never silently dropped. */
  missing: string[]
  /** Set when the protocol could not be resolved at all. */
  error: string | null
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * BOOT.md step 2: `<home>/saipen/BOOT.md` wins, then `<home>/BOOT.md`.
 * Anything else is non-conformant and resolves to null rather than guessing.
 */
export function resolveProtocolDir(home: string): string | null {
  const nested = path.join(home, "saipen")
  if (existsSync(path.join(nested, "BOOT.md"))) {
    return nested
  }
  if (existsSync(path.join(home, "BOOT.md"))) {
    return home
  }
  return null
}

/**
 * Ordered candidates for the install root. The first one that actually holds a
 * BOOT.md wins -- existence of the directory alone is not enough, because an
 * empty leftover folder would otherwise shadow a working install.
 */
export function candidateSaipenHomes(configured?: string, workspaceFolder?: string): string[] {
  const candidates: string[] = []
  const push = (value: string | undefined | null) => {
    if (!value) return
    const trimmed = value.trim()
    if (!trimmed) return
    const resolved = path.resolve(trimmed)
    if (!candidates.includes(resolved)) candidates.push(resolved)
  }

  push(readSaipenHomeFromProjectState(workspaceFolder))
  push(configured)
  push(process.env[SAIPEN_HOME_ENV])
  push(path.join(os.homedir(), "saipen"))
  push(path.join(os.homedir(), ".saipen"))

  return candidates
}

/**
 * Reads `saipen_home:` out of `<folder>/.saipen/STATE.md`'s frontmatter.
 *
 * The value is written by the protocol itself, so a project that has ever been
 * worked on with saipen tells us exactly which install it belongs to. Parsed
 * with a line scan rather than a YAML dependency: the field is a single scalar
 * and STATE.md is authored by a tool, not by hand.
 */
export function readSaipenHomeFromProjectState(workspaceFolder?: string): string | null {
  if (!workspaceFolder) return null
  const statePath = path.join(workspaceFolder, ".saipen", "STATE.md")
  if (!existsSync(statePath)) return null

  try {
    const raw = readFileSync(statePath, "utf8")
    const match = raw.match(/^saipen_home:\s*(.+)$/m)
    if (!match) return null
    // Strips the surrounding quotes STATE.md uses for Windows paths.
    const value = match[1].trim().replace(/^["']|["']$/g, "")
    if (!value) return null
    // STATE.md escapes backslashes for YAML; undo that before resolving.
    return value.replace(/\\\\/g, "\\")
  } catch (error) {
    log.warn({ statePath, error }, "Failed to read saipen_home from project STATE.md")
    return null
  }
}

export function resolveSaipenCore(
  settings: SaipenSettings | undefined,
  options: SaipenResolveOptions = {},
): SaipenResolution {
  const enabled = settings?.enabled ?? true
  if (!enabled) {
    return { enabled: false, home: null, protocolDir: null, instructions: [], missing: [], error: null }
  }

  const homes = candidateSaipenHomes(settings?.home, options.workspaceFolder)
  let home: string | null = null
  let protocolDir: string | null = null

  for (const candidate of homes) {
    if (!isDirectory(candidate)) continue
    const resolved = resolveProtocolDir(candidate)
    if (resolved) {
      home = candidate
      protocolDir = resolved
      break
    }
  }

  if (!protocolDir) {
    const error =
      homes.length > 0
        ? `SAIPEN protocol not found. Looked for BOOT.md under: ${homes.join(", ")}`
        : "SAIPEN protocol not found and no saipen home is configured."
    return { enabled: true, home: null, protocolDir: null, instructions: [], missing: [], error }
  }

  const requested = settings?.files?.length ? settings.files : [...DEFAULT_SAIPEN_FILES]
  const instructions: string[] = []
  const missing: string[] = []

  for (const file of requested) {
    const absolute = path.resolve(protocolDir, file)
    if (existsSync(absolute)) {
      instructions.push(toInstructionPath(absolute))
    } else {
      missing.push(absolute)
    }
  }

  for (const extra of settings?.extraInstructions ?? []) {
    const trimmed = extra?.trim()
    if (!trimmed) continue
    const absolute = path.resolve(trimmed)
    if (existsSync(absolute)) {
      const value = toInstructionPath(absolute)
      if (!instructions.includes(value)) instructions.push(value)
    } else {
      missing.push(absolute)
    }
  }

  if (missing.length > 0) {
    log.warn({ missing }, "SAIPEN instruction files missing")
  }

  return { enabled: true, home, protocolDir, instructions, missing, error: null }
}

/**
 * OpenCode reads these on every platform; backslashes survive JSON but trip up
 * the WSL relay in spawn.ts, so paths are normalised to forward slashes.
 */
function toInstructionPath(absolute: string): string {
  return absolute.replace(/\\/g, "/")
}

export interface SaipenSubState {
  name: string
  phase: string | null
  task: string | null
  agent: string | null
  updated: string | null
  nextAction: string | null
}

/**
 * Reads the state of each sub-agent (`saiwiki`, `saitranslate`, `saihunt`, ...)
 * from `<folder>/.saipen/extensions/subs/<name>/STATE.md`.
 *
 * This is the honest answer to "is the wiki fresh, are the docs translated":
 * the sub writes its own phase and `updated` timestamp there, so the panel
 * reports what the protocol recorded rather than re-deriving a verdict.
 */
export function readSaipenSubStates(workspaceFolder?: string): SaipenSubState[] {
  if (!workspaceFolder) return []
  const subsDir = path.join(workspaceFolder, ".saipen", "extensions", "subs")
  if (!isDirectory(subsDir)) return []

  let names: string[]
  try {
    names = readdirSync(subsDir)
  } catch (error) {
    log.warn({ subsDir, error }, "Failed to list saipen subs")
    return []
  }

  const states: SaipenSubState[] = []
  for (const name of names.sort()) {
    // `_shared` holds common role text, not a sub with its own state.
    if (name.startsWith("_")) continue
    const statePath = path.join(subsDir, name, "STATE.md")
    if (!existsSync(statePath)) continue

    try {
      const raw = readFileSync(statePath, "utf8")
      states.push({
        name,
        phase: readScalar(raw, "phase"),
        task: readScalar(raw, "task"),
        agent: readScalar(raw, "agent"),
        updated: readScalar(raw, "updated"),
        nextAction: readScalar(raw, "next_action"),
      })
    } catch (error) {
      log.warn({ statePath, error }, "Failed to read sub STATE.md")
    }
  }

  return states
}

function readScalar(raw: string, field: string): string | null {
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))
  if (!match) return null
  const value = match[1].trim().replace(/^["']|["']$/g, "")
  return value.length > 0 ? value : null
}
