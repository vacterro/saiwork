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
  /** Git-pull the protocol home periodically. Off by default. */
  autoUpdate?: boolean
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

/**
 * What a running workspace actually launched with.
 *
 * Injection happens once, when the workspace starts: the instruction list is
 * baked into `OPENCODE_CONFIG_CONTENT` and the OpenCode process never re-reads
 * it. So the settings answer "what would a new workspace get", which is a
 * different question from "what is this session running with" the moment the
 * user changes anything.
 */
export interface SaipenLaunchState {
  enabled: boolean
  protocolDir: string | null
  instructions: string[]
  /** When the workspace was launched, for reporting. */
  launchedAt: number
}

/**
 * Whether the running workspace would have to restart to match the settings.
 *
 * Compares what is configured now against what was injected at launch. Order is
 * significant in the instruction list -- SAIPEN Core goes first on purpose --
 * so this is a sequence comparison, not a set comparison.
 */
export function saipenRestartRequired(
  configured: { enabled: boolean; instructions: string[] },
  launched: SaipenLaunchState | null,
): boolean {
  if (!launched) return false
  if (configured.enabled !== launched.enabled) return true
  if (configured.instructions.length !== launched.instructions.length) return true
  return configured.instructions.some((entry, index) => entry !== launched.instructions[index])
}

export interface SaipenSubState {
  name: string
  phase: string | null
  task: string | null
  agent: string | null
  updated: string | null
  nextAction: string | null
  lifecycle: SaipenSubLifecycle
  packageStatus: SaipenSubPackageStatus
  packageCounts: SaipenSubPackageCounts
  issues: string[]
}

export type SaipenSubLifecycle = "active" | "blocked" | "done" | "missing" | "malformed"
export type SaipenSubPackageStatus =
  | "none"
  | "ready"
  | "draft"
  | "blocked"
  | "reviewed"
  | "stale"
  | "missing"
  | "malformed"

export interface SaipenSubPackageCounts {
  ready: number
  draft: number
  blocked: number
  reviewed: number
  stale: number
}

export interface SaipenProjectState {
  phase: string | null
  nextAction: string | null
  todoCount: number
  doingCount: number
  blockedCount: number
}

/** Reads root project state used by Goal Mode Auto. */
export function readSaipenProjectState(workspaceFolder?: string): SaipenProjectState | null {
  if (!workspaceFolder) return null
  const statePath = path.join(workspaceFolder, ".saipen", "STATE.md")
  const boardPath = path.join(workspaceFolder, ".saipen", "BOARD.md")
  if (!existsSync(statePath) || !existsSync(boardPath)) return null

  try {
    const state = readFileSync(statePath, "utf8")
    const board = readFileSync(boardPath, "utf8")
    const counts = { todoCount: 0, doingCount: 0, blockedCount: 0 }
    let section: "TODO" | "DOING" | "BLOCKED" | null = null

    for (const line of board.split(/\r?\n/)) {
      const heading = line.match(/^## (TODO|DOING|BLOCKED)\s*$/)
      if (heading) {
        section = heading[1] as "TODO" | "DOING" | "BLOCKED"
        continue
      }
      if (line.startsWith("## ")) {
        section = null
        continue
      }
      if (!/^- \[(?: |\/)\] T-\d{3}\b/.test(line)) continue
      if (section === "TODO") counts.todoCount += 1
      if (section === "DOING") counts.doingCount += 1
      if (section === "BLOCKED") counts.blockedCount += 1
    }

    return {
      phase: readScalar(state, "phase"),
      nextAction: readScalar(state, "next_action"),
      ...counts,
    }
  } catch (error) {
    log.warn({ statePath, boardPath, error }, "Failed to read root saipen state")
    return null
  }
}

const VALID_SUB_PHASES = new Set([
  "INIT",
  "PLAN",
  "SCOUT",
  "BUILD",
  "VERIFY",
  "REVIEW",
  "SHIP",
  "DONE",
  "ADD",
  "HUNT",
  "MARKHUNT",
  "CLEAN",
  "BLOCKED",
  "TRANSLATE",
  "PREPARE",
  "VALIDATE",
])

const OUTBOX_STATUSES = new Set(["ready", "draft", "blocked", "reviewed", "stale"])
const FORBIDDEN_SUB_PHASES = new Set(["BUILD", "SHIP", "CLEAN", "TRANSLATE"])
const READY_PACKAGE_FIELDS = [
  "producer",
  "source_head",
  "source_tree_fingerprint",
  "role_revision",
  "coverage",
  "payload",
  "verified",
  "instructions",
] as const

function emptyPackageCounts(): SaipenSubPackageCounts {
  return { ready: 0, draft: 0, blocked: 0, reviewed: 0, stale: 0 }
}

function resolveSubsDir(workspaceFolder: string): string | null {
  const current = path.join(workspaceFolder, ".saipen", "extensions", "subs")
  if (isDirectory(current)) return current
  const legacy = path.join(workspaceFolder, "extensions", "subs")
  return isDirectory(legacy) ? legacy : null
}

function readManifestNames(subsDir: string): string[] {
  const manifestPath = path.join(subsDir, "MANIFEST.md")
  if (!existsSync(manifestPath)) {
    try {
      return readdirSync(subsDir)
        .filter((name) => name !== "TEMPLATE" && !name.startsWith("_") && isDirectory(path.join(subsDir, name)))
        .sort()
    } catch (error) {
      log.warn({ subsDir, error }, "Failed to list saipen subs")
      return []
    }
  }

  try {
    const names = new Set<string>()
    for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^-\s+([A-Za-z0-9][A-Za-z0-9_-]*)\s+--\s+/)
      if (match) names.add(match[1])
    }
    return [...names].sort()
  } catch (error) {
    log.warn({ manifestPath, error }, "Failed to read saipen sub manifest")
    return []
  }
}

interface ParsedSubState {
  phase: string | null
  task: string | null
  agent: string | null
  updated: string | null
  nextAction: string | null
  blocker: string | null
  roleRevision: string | null
  lifecycle: SaipenSubLifecycle
  issues: string[]
}

function readSubState(subsDir: string, name: string): ParsedSubState {
  const statePath = path.join(subsDir, name, "STATE.md")
  const missing = {
    phase: null,
    task: null,
    agent: null,
    updated: null,
    nextAction: null,
    blocker: null,
    roleRevision: null,
  }
  if (!existsSync(statePath)) {
    return { ...missing, lifecycle: "missing", issues: [`Missing STATE.md for ${name}`] }
  }

  try {
    const raw = readFileSync(statePath, "utf8")
    const state = {
      phase: readScalar(raw, "phase"),
      task: readScalar(raw, "task"),
      agent: readScalar(raw, "agent"),
      updated: readScalar(raw, "updated"),
      nextAction: readScalar(raw, "next_action"),
      blocker: readScalar(raw, "blocker"),
      roleRevision: readScalar(raw, "role_revision"),
    }
    const issues: string[] = []
    if (!state.phase || !VALID_SUB_PHASES.has(state.phase)) issues.push("Missing or invalid phase")
    if (state.phase && FORBIDDEN_SUB_PHASES.has(state.phase)) issues.push(`Forbidden subSaipen phase ${state.phase}`)
    if (!state.task) issues.push("Missing task")
    if (!state.agent || state.agent !== name) issues.push(`Agent must be ${name}`)
    if (!state.updated || Number.isNaN(Date.parse(state.updated))) issues.push("Missing or invalid updated timestamp")
    if (!state.nextAction) issues.push("Missing next_action")
    if (!state.blocker) issues.push("Missing blocker")

    const lifecycle: SaipenSubLifecycle = issues.length > 0
      ? "malformed"
      : state.phase === "BLOCKED" || state.blocker !== "none"
        ? "blocked"
        : state.phase === "DONE"
          ? "done"
          : "active"
    return { ...state, lifecycle, issues }
  } catch (error) {
    log.warn({ statePath, error }, "Failed to read sub STATE.md")
    return { ...missing, lifecycle: "malformed", issues: [`Unreadable STATE.md for ${name}`] }
  }
}

function readOutboxField(entry: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const lines = entry.split(/\r?\n/)
  const pattern = new RegExp(`^- \\*\\*${escaped}:\\*\\*\\s*(.*)$`)
  const index = lines.findIndex((line) => pattern.test(line))
  if (index < 0) return null
  const inline = lines[index].match(pattern)?.[1]?.trim()
  if (inline) return inline

  const nested: string[] = []
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor]
    if (/^- \*\*[^*]+:\*\*/.test(line) || /^##\s+/.test(line)) break
    if (line.trim()) nested.push(line.trim())
  }
  return nested.join("\n") || null
}

function readSubPackage(
  subsDir: string,
  name: string,
  state: ParsedSubState,
): { status: SaipenSubPackageStatus; counts: SaipenSubPackageCounts; issues: string[] } {
  const outboxPath = path.join(subsDir, name, "kitchen", "OUTBOX.md")
  const counts = emptyPackageCounts()
  if (!existsSync(outboxPath)) {
    return { status: "missing", counts, issues: [`Missing kitchen/OUTBOX.md for ${name}`] }
  }

  try {
    const raw = readFileSync(outboxPath, "utf8")
    const entryStarts = [...raw.matchAll(/^##\s+[A-Z][A-Z0-9_]*-\d+:\s+.+$/gm)]
    if (entryStarts.length === 0) {
      const status = /^- \*\*status:\*\*/m.test(raw) ? "malformed" : "none"
      const issues = status === "malformed" ? ["OUTBOX status has no valid package heading"] : []
      return { status, counts, issues }
    }
    const entries = entryStarts.map((entry, index) => {
      const start = entry.index ?? 0
      const end = entryStarts[index + 1]?.index ?? raw.length
      return raw.slice(start, end)
    })

    const issues: string[] = []
    for (const entry of entries) {
      const statusMatches = [...entry.matchAll(/^- \*\*status:\*\*\s*(\S+)\s*$/gm)]
      const declared = statusMatches.length === 1 ? statusMatches[0][1] : null
      if (!declared || !OUTBOX_STATUSES.has(declared)) {
        issues.push("OUTBOX entry has missing, duplicate, or invalid status")
        continue
      }

      let effective = declared as keyof SaipenSubPackageCounts
      if (declared === "ready") {
        const missingFields = READY_PACKAGE_FIELDS.filter((field) => !readOutboxField(entry, field))
        if (missingFields.length > 0 || !state.roleRevision) {
          issues.push(`Ready package is missing freshness evidence: ${missingFields.join(", ") || "STATE role_revision"}`)
          continue
        }
        const packageRoleRevision = readOutboxField(entry, "role_revision")
        if (packageRoleRevision !== state.roleRevision) effective = "stale"
      }
      counts[effective] += 1
    }

    if (issues.length > 0) return { status: "malformed", counts, issues }
    if (counts.stale > 0) return { status: "stale", counts, issues: [] }
    if (counts.blocked > 0) return { status: "blocked", counts, issues: [] }
    if (counts.ready > 0) return { status: "ready", counts, issues: [] }
    if (counts.draft > 0) return { status: "draft", counts, issues: [] }
    if (counts.reviewed > 0) return { status: "reviewed", counts, issues: [] }
    return { status: "none", counts, issues: [] }
  } catch (error) {
    log.warn({ outboxPath, error }, "Failed to read sub OUTBOX.md")
    return { status: "malformed", counts, issues: [`Unreadable kitchen/OUTBOX.md for ${name}`] }
  }
}

/** Reads every manifest-listed sub, including broken or incomplete instances. */
export function readSaipenSubStates(workspaceFolder?: string): SaipenSubState[] {
  if (!workspaceFolder) return []
  const subsDir = resolveSubsDir(workspaceFolder)
  if (!subsDir) return []

  const states: SaipenSubState[] = []
  for (const name of readManifestNames(subsDir)) {
    const state = readSubState(subsDir, name)
    const packageState = readSubPackage(subsDir, name, state)
    states.push({
      name,
      phase: state.phase,
      task: state.task,
      agent: state.agent,
      updated: state.updated,
      nextAction: state.nextAction,
      lifecycle: state.lifecycle,
      packageStatus: packageState.status,
      packageCounts: packageState.counts,
      issues: [...state.issues, ...packageState.issues],
    })
  }

  return states
}

function readScalar(raw: string, field: string): string | null {
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))
  if (!match) return null
  const value = match[1].trim().replace(/^["']|["']$/g, "")
  return value.length > 0 ? value : null
}
