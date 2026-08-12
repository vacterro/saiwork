import { createHash } from "crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import os from "os"
import path from "path"
import { createLogger } from "../logger"
import { parseStateScalars, readStateScalar } from "./state"
import { parseBoardSections } from "./board"
import {
  canonicalExistingPath,
  hasParentPathSegment,
  pathEntryExists,
  resolvePathWithin,
} from "./path-security"

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
  /** `extraInstructions` entries rejected for violating the absolute-file contract. */
  rejected: string[]
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

function resolveExistingContainedPath(root: string, candidate: string): string | null {
  return pathEntryExists(candidate) ? resolvePathWithin(root, candidate) : null
}

function resolveProjectSaipenDir(workspaceFolder: string): string | null {
  return resolveExistingContainedPath(workspaceFolder, path.join(workspaceFolder, ".saipen"))
}

function resolveConfiguredProtocolFile(protocolDir: string, configuredFile: string): string | null {
  const file = configuredFile.trim()
  if (
    !file
    || path.isAbsolute(file)
    || path.win32.isAbsolute(file)
    || path.posix.isAbsolute(file)
    || hasParentPathSegment(file)
  ) {
    return null
  }
  return resolvePathWithin(protocolDir, path.resolve(protocolDir, file))
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
 * through the canonical STATE scalar parser: frontmatter-scoped and
 * first-match, so a stray `saipen_home:` inside the body can never shadow the
 * real one.
 */
export function readSaipenHomeFromProjectState(workspaceFolder?: string): string | null {
  if (!workspaceFolder) return null
  const saipenDir = resolveProjectSaipenDir(workspaceFolder)
  if (!saipenDir) return null
  const statePath = resolveExistingContainedPath(saipenDir, path.join(saipenDir, "STATE.md"))
  if (!statePath) return null

  try {
    const raw = readFileSync(statePath, "utf8")
    const value = readStateScalar(raw, "saipen_home")
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
    return { enabled: false, home: null, protocolDir: null, instructions: [], missing: [], rejected: [], error: null }
  }

  const homes = candidateSaipenHomes(settings?.home, options.workspaceFolder)
  let home: string | null = null
  let protocolDir: string | null = null

  for (const candidate of homes) {
    if (!isDirectory(candidate)) continue
    const resolved = resolveProtocolDir(candidate)
    const canonical = resolved ? canonicalExistingPath(resolved) : null
    if (canonical) {
      home = candidate
      protocolDir = canonical
      break
    }
  }

  if (!protocolDir) {
    const error =
      homes.length > 0
        ? `SAIPEN protocol not found. Looked for BOOT.md under: ${homes.join(", ")}`
        : "SAIPEN protocol not found and no saipen home is configured."
    return { enabled: true, home: null, protocolDir: null, instructions: [], missing: [], rejected: [], error }
  }

  const requested = settings?.files?.length ? settings.files : [...DEFAULT_SAIPEN_FILES]
  const instructions: string[] = []
  const missing: string[] = []
  const rejected: string[] = []

  for (const configuredFile of requested) {
    const file = configuredFile.trim()
    const absolute = resolveConfiguredProtocolFile(protocolDir, file)
    if (absolute && pathEntryExists(absolute) && !isDirectory(absolute)) {
      instructions.push(toInstructionPath(absolute))
    } else {
      missing.push(path.isAbsolute(file) || path.win32.isAbsolute(file)
        ? path.normalize(file)
        : path.resolve(protocolDir, file))
    }
  }

  // extraInstructions CONTRACT: every entry is an absolute path under win32 OR
  // posix semantics, canonicalized, and a regular readable FILE -- never a
  // directory, never a cwd-dependent relative value. Rejected entries are
  // surfaced explicitly, not silently skipped.
  for (const extra of settings?.extraInstructions ?? []) {
    const trimmed = extra?.trim()
    if (!trimmed) continue
    const absoluteUnderWin32 = path.win32.isAbsolute(trimmed)
    const absoluteUnderPosix = path.posix.isAbsolute(trimmed)
    if (!absoluteUnderWin32 && !absoluteUnderPosix) {
      rejected.push(trimmed)
      continue
    }
    // Existence and the regular-file check happen on the HOST: a value that is
    // absolute only in the other platform's semantics resolves through the
    // host's drive/root rules and is rejected when no such file exists.
    const host = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(trimmed)
    const canonical = canonicalExistingPath(host)
    if (!canonical || isDirectory(canonical)) {
      rejected.push(trimmed)
      continue
    }
    const value = toInstructionPath(canonical)
    if (!instructions.includes(value)) instructions.push(value)
  }

  if (missing.length > 0) {
    log.warn({ missing }, "SAIPEN instruction files missing")
  }
  if (rejected.length > 0) {
    log.warn({ rejected }, "SAIPEN extraInstructions entries rejected (absolute file required)")
  }

  return { enabled: true, home, protocolDir, instructions, missing, rejected, error: null }
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
  /** Content digest per instruction path AT LAUNCH. OpenCode reads
   *  `OPENCODE_CONFIG_CONTENT` once and never re-reads it, so a same-path
   *  content change is drift that only a restart can pick up. */
  instructionDigests: Record<string, string>
  /** When the workspace was launched, for reporting. */
  launchedAt: number
}

/** SHA-256 content digests for the given instruction paths ("" when unreadable). */
export function instructionDigests(paths: string[]): Record<string, string> {
  const digests: Record<string, string> = {}
  for (const entry of paths) {
    try {
      digests[entry] = createHash("sha256").update(readFileSync(entry)).digest("hex")
    } catch {
      digests[entry] = ""
    }
  }
  return digests
}

/**
 * Whether the running workspace would have to restart to match the settings.
 *
 * Compares what is configured now against what was injected at launch. Order is
 * significant in the instruction list -- SAIPEN Core goes first on purpose --
 * so this is a sequence comparison, not a set comparison. On top of the list
 * comparison, the CONTENT of each instruction file is hashed: an in-flight
 * OpenCode process never re-reads the files it was launched with, so a
 * same-path content drift (e.g. an upstream protocol edit) also requires a
 * restart to take effect.
 */
export function saipenRestartRequired(
  configured: { enabled: boolean; instructions: string[] },
  launched: SaipenLaunchState | null,
): boolean {
  if (!launched) return false
  if (configured.enabled !== launched.enabled) return true
  if (configured.instructions.length !== launched.instructions.length) return true
  const listChanged = configured.instructions.some((entry, index) => entry !== launched.instructions[index])
  if (listChanged) return true
  const current = instructionDigests(configured.instructions)
  return configured.instructions.some((entry) => current[entry] !== launched.instructionDigests[entry])
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
  const saipenDir = resolveProjectSaipenDir(workspaceFolder)
  if (!saipenDir) return null
  const statePath = resolveExistingContainedPath(saipenDir, path.join(saipenDir, "STATE.md"))
  const boardPath = resolveExistingContainedPath(saipenDir, path.join(saipenDir, "BOARD.md"))
  if (!statePath || !boardPath) return null

  try {
    const state = readFileSync(statePath, "utf8")
    const board = readFileSync(boardPath, "utf8")
    const counts = { todoCount: 0, doingCount: 0, blockedCount: 0 }

    // Section-aware, via the one canonical BOARD parser: a ticket counts toward
    // the section it sits under, never toward its checkbox state. For the
    // Goal-Mode counts an already-checked `[x]` ticket under TODO is NOT open
    // work: the agent finished it but did not move it to DONE, so it must not
    // keep auto-continuing against a board with nothing actionable left.
    for (const section of parseBoardSections(board)) {
      if (section.title === "TODO") counts.todoCount += section.tickets.filter((ticket) => !ticket.checked).length
      if (section.title === "DOING") counts.doingCount += section.tickets.length
      if (section.title === "BLOCKED") counts.blockedCount += section.tickets.length
    }

    return {
      phase: readStateScalar(state, "phase"),
      nextAction: readStateScalar(state, "next_action"),
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
  const saipenDir = resolveProjectSaipenDir(workspaceFolder)
  const current = saipenDir
    ? resolveExistingContainedPath(saipenDir, path.join(saipenDir, "extensions", "subs"))
    : null
  if (current && isDirectory(current)) return current
  const legacy = path.join(workspaceFolder, "extensions", "subs")
  const safeLegacy = resolveExistingContainedPath(workspaceFolder, legacy)
  return safeLegacy && isDirectory(safeLegacy) ? safeLegacy : null
}

function readManifestNames(subsDir: string): string[] {
  const manifestPath = resolveExistingContainedPath(subsDir, path.join(subsDir, "MANIFEST.md"))
  if (!manifestPath) {
    try {
      return readdirSync(subsDir)
        .filter((name) => {
          if (name === "TEMPLATE" || name.startsWith("_")) return false
          const candidate = resolveExistingContainedPath(subsDir, path.join(subsDir, name))
          return candidate !== null && isDirectory(candidate)
        })
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
  const statePath = resolveExistingContainedPath(subsDir, path.join(subsDir, name, "STATE.md"))
  const missing = {
    phase: null,
    task: null,
    agent: null,
    updated: null,
    nextAction: null,
    blocker: null,
    roleRevision: null,
  }
  if (!statePath) {
    return { ...missing, lifecycle: "missing", issues: [`Missing STATE.md for ${name}`] }
  }

  try {
    const raw = readFileSync(statePath, "utf8")
    const parsed = parseStateScalars(raw)
    const state = {
      phase: parsed.values.get("phase") || null,
      task: parsed.values.get("task") || null,
      agent: parsed.values.get("agent") || null,
      updated: parsed.values.get("updated") || null,
      nextAction: parsed.values.get("next_action") || null,
      blocker: parsed.values.get("blocker") || null,
      roleRevision: parsed.values.get("role_revision") || null,
    }
    const issues: string[] = [...parsed.issues]
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
  const outboxPath = resolveExistingContainedPath(subsDir, path.join(subsDir, name, "kitchen", "OUTBOX.md"))
  const counts = emptyPackageCounts()
  if (!outboxPath) {
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
