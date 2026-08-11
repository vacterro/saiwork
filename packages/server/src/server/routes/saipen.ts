import { FastifyInstance } from "fastify"
import { z } from "zod"
import { createHash, randomUUID } from "crypto"
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, rmSync } from "fs"
import path from "path"
import type { SettingsService } from "../../settings/service"
import {
  readSaipenProjectState,
  readSaipenSubStates,
  resolveSaipenCore,
  saipenRestartRequired,
  type SaipenSettings,
} from "../../saipen/core"
import { parseBoardSections } from "../../saipen/board"
import {
  canonicalExistingPath,
  pathEntryExists,
  pathsEqual,
  resolvePathWithin,
} from "../../saipen/path-security"
import { truncateUtf8 } from "../../saipen/utf8"
import type { SaipenStatusResponse, SaipenViewResponse } from "../../api-types"

const StatusQuerySchema = z.object({
  folder: z.string().min(1).optional(),
})

/** Cap the LOG tail so a huge journal cannot blow up the panel. */
const LOG_TAIL_LINES = 200
const LOG_TAIL_BYTES = 64 * 1024
/** Cap each kitchen plan file so the panel stays bounded. */
const PLAN_FILE_BYTES = 32 * 1024
const PLAN_FILE_LIMIT = 10
/** Cap a write so an accidental paste cannot clobber a project file. */
const MAX_WRITE_BYTES = 256 * 1024

const WriteBodySchema = z.object({
  folder: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string(),
  /** SHA-256 of the file bytes the client last read; mismatch is a 409. */
  expectedRevision: z.string().min(1),
})

/** Serializes writes per `.saipen` root so two SAIWORK writes cannot race. */
const saipenWriteQueues = new Map<string, Promise<void>>()
const EMPTY_FILE_REVISION = createHash("sha256").update(Buffer.alloc(0)).digest("hex")

function withSaipenWriteQueue<T>(saipenDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = saipenWriteQueues.get(saipenDir) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  const settled = next.then(() => undefined, () => undefined)
  saipenWriteQueues.set(saipenDir, settled)
  void settled.then(() => {
    if (saipenWriteQueues.get(saipenDir) === settled) saipenWriteQueues.delete(saipenDir)
  })
  return next
}

/** Diagnostic used by focused lifecycle tests. */
export function getSaipenWriteQueueSize(): number {
  return saipenWriteQueues.size
}

function fileRevision(filePath: string | null): string {
  if (!filePath || !pathEntryExists(filePath)) return EMPTY_FILE_REVISION
  const bytes = readFileSync(filePath)
  return createHash("sha256").update(bytes).digest("hex")
}

function readFileSnapshot(filePath: string | null): { content: string | null; revision: string } {
  if (!filePath) return { content: null, revision: EMPTY_FILE_REVISION }
  try {
    const bytes = readFileSync(filePath)
    return {
      content: bytes.toString("utf8"),
      revision: createHash("sha256").update(bytes).digest("hex"),
    }
  } catch {
    return { content: null, revision: EMPTY_FILE_REVISION }
  }
}

interface RouteDeps {
  settings: SettingsService
  /** Supplies the launch-time state of a running workspace. */
  getSaipenLaunchState?: (folder: string) => import("../../saipen/core").SaipenLaunchState | null
  /** Registry gate for every workspace-scoped SAIPEN request. */
  workspaceManager: { list: () => import("../../api-types").WorkspaceDescriptor[] }
}

/**
 * Accepts only a canonical path to a real registered workspace. Resolving to
 * the same folder is insufficient: aliases and traversal spellings are denied.
 */
function resolveAllowedSaipenFolder(folder: string | undefined, manager: RouteDeps["workspaceManager"]): string | null {
  if (!folder || !path.isAbsolute(folder)) return null
  if (folder.replace(/\\/g, "/").split("/").some((segment) => segment === "." || segment === "..")) return null
  const canonical = canonicalExistingPath(folder)
  if (!canonical || !pathsEqual(folder, canonical)) return null
  return manager.list().some((workspace) => {
    const registeredPath = canonicalExistingPath(workspace.path)
    return registeredPath !== null && pathsEqual(registeredPath, canonical)
  }) ? canonical : null
}

interface ResolvedSaipenDirectory {
  path: string
  exists: boolean
}

function resolveSaipenDirectory(workspaceFolder: string): ResolvedSaipenDirectory | null {
  const candidate = path.join(workspaceFolder, ".saipen")
  if (!pathEntryExists(candidate)) return { path: candidate, exists: false }
  const resolved = resolvePathWithin(workspaceFolder, candidate)
  return resolved ? { path: resolved, exists: true } : null
}

class UnsafeSaipenPathError extends Error {}

function resolveReadableSaipenPath(saipenDir: string, relativePath: string): string | null {
  const candidate = path.join(saipenDir, ...relativePath.split("/"))
  if (!pathEntryExists(candidate)) return null
  const resolved = resolvePathWithin(saipenDir, candidate)
  if (!resolved) throw new UnsafeSaipenPathError(relativePath)
  return resolved
}

const EMPTY_VIEW: SaipenViewResponse = {
  state: null,
  board: null,
  boardSections: [],
  log: null,
  logTruncated: false,
  plans: [],
  revisions: {},
  missing: true,
}

/**
 * Read-only status for the SAIPEN Core injection.
 *
 * The UI needs to be able to say, in text, which protocol files a session will
 * actually receive -- "state changes are visible or they did not happen".
 * Resolution runs per request rather than being cached, because the answer
 * depends on files on disk that the user edits outside SAIWORK.
 */
export function registerSaipenRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/saipen/status", async (request, reply) => {
    const query = StatusQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.code(400).send({ error: "invalid query" })
    const folder = query.success ? query.data.folder : undefined
    const allowed = resolveAllowedSaipenFolder(folder, deps.workspaceManager)
    if (folder && !allowed) return reply.code(403).send({ error: "unknown workspace" })
    const saipenDirectory = allowed ? resolveSaipenDirectory(allowed) : null
    if (allowed && !saipenDirectory) return reply.code(403).send({ error: "unsafe .saipen path" })
    if (saipenDirectory?.exists) {
      try {
        resolveReadableSaipenPath(saipenDirectory.path, "STATE.md")
        resolveReadableSaipenPath(saipenDirectory.path, "BOARD.md")
      } catch (error) {
        if (error instanceof UnsafeSaipenPathError) return reply.code(403).send({ error: "unsafe .saipen path" })
        throw error
      }
    }
    const serverConfig = deps.settings.getOwner("config", "server") as { saipen?: SaipenSettings } | undefined
    const resolution = resolveSaipenCore(serverConfig?.saipen, { workspaceFolder: allowed ?? undefined })

    // Configured is what a NEW workspace would get; effective is what the one
    // already running actually launched with. Reporting only the first is how
    // the bar could claim "Core loaded" for a session that has none.
    const launched = allowed ? (deps.getSaipenLaunchState?.(allowed) ?? null) : null

    const response: SaipenStatusResponse = {
      enabled: resolution.enabled,
      home: resolution.home,
      protocolDir: resolution.protocolDir,
      instructions: resolution.instructions,
      missing: resolution.missing,
      error: resolution.error,
      project: readSaipenProjectState(allowed ?? undefined),
      subs: readSaipenSubStates(allowed ?? undefined),
      effective: launched
        ? {
            enabled: launched.enabled,
            protocolDir: launched.protocolDir,
            instructions: launched.instructions,
            launchedAt: launched.launchedAt,
          }
        : null,
      restartRequired: saipenRestartRequired(
        { enabled: resolution.enabled, instructions: resolution.instructions },
        launched,
      ),
    }
    return response
  })

  app.get("/api/saipen/view", async (request, reply): Promise<SaipenViewResponse> => {
    const query = StatusQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      reply.code(400).send({ error: "invalid query" })
      return EMPTY_VIEW
    }
    const folder = query.success ? query.data.folder : undefined
    const allowed = resolveAllowedSaipenFolder(folder, deps.workspaceManager)
    if (folder && !allowed) {
      reply.code(403).send({ error: "unknown workspace" })
      return EMPTY_VIEW
    }
    if (!allowed) return EMPTY_VIEW

    const saipenDirectory = resolveSaipenDirectory(allowed)
    if (!saipenDirectory) {
      reply.code(403).send({ error: "unsafe .saipen path" })
      return EMPTY_VIEW
    }
    if (!saipenDirectory.exists) return EMPTY_VIEW
    const saipenDir = saipenDirectory.path

    try {
      const statePath = resolveReadableSaipenPath(saipenDir, "STATE.md")
      const boardPath = resolveReadableSaipenPath(saipenDir, "BOARD.md")
      const logPath = resolveReadableSaipenPath(saipenDir, "LOG.md")

      let log: string | null = null
      let logTruncated = false
      const logSnapshot = readFileSnapshot(logPath)
      if (logSnapshot.content !== null) {
        try {
          const full = logSnapshot.content
          const lines = full.split(/\r?\n/)
          const tail = lines.slice(-LOG_TAIL_LINES)
          const lineTail = tail.join("\n")
          let text = truncateUtf8(lineTail, LOG_TAIL_BYTES, "tail")
          if (text !== lineTail) {
            const firstNewline = text.indexOf("\n")
            if (firstNewline >= 0) text = text.slice(firstNewline + 1)
          }
          log = text
          logTruncated = lines.length > LOG_TAIL_LINES || Buffer.byteLength(full, "utf8") > LOG_TAIL_BYTES
        } catch {
          log = null
        }
      }

      const stateSnapshot = readFileSnapshot(statePath)
      const boardSnapshot = readFileSnapshot(boardPath)
      const state = stateSnapshot.content
      const board = boardSnapshot.content
      const planSnapshots = readKitchenPlans(saipenDir)
      const plans = planSnapshots.map((plan) => ({ name: plan.name, content: plan.content, truncated: plan.truncated }))
      const revisions: Record<string, string> = {
        "STATE.md": stateSnapshot.revision,
        "BOARD.md": boardSnapshot.revision,
        "LOG.md": logSnapshot.revision,
      }
      for (const plan of planSnapshots) {
        const relativePath = `kitchen/${plan.name}`
        revisions[relativePath] = plan.revision
      }
      return {
        state,
        board,
        boardSections: parseBoardSections(board),
        log,
        logTruncated,
        plans,
        revisions,
        missing: false,
      }
    } catch (error) {
      if (!(error instanceof UnsafeSaipenPathError)) throw error
      reply.code(403).send({ error: "unsafe .saipen path" })
      return EMPTY_VIEW
    }
  })

  app.put("/api/saipen/file", async (request, reply) => {
    const body = WriteBodySchema.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: "invalid body" })
    const { folder, relativePath, content, expectedRevision } = body.data

    const allowed = resolveAllowedSaipenFolder(folder, deps.workspaceManager)
    if (!allowed) return reply.code(403).send({ error: "unknown workspace" })

    const saipenDirectory = resolveSaipenDirectory(allowed)
    if (!saipenDirectory?.exists) return reply.code(403).send({ error: "unsafe .saipen path" })
    const saipenDir = saipenDirectory.path
    const target = resolveSaipenWritablePath(saipenDir, relativePath)
    if (!target) return reply.code(403).send({ error: "path not allowlisted" })
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return reply.code(413).send({ error: "content too large" })
    }

    return withSaipenWriteQueue(saipenDir, async () => {
      let currentDirectory = resolveSaipenDirectory(allowed)
      if (!currentDirectory?.exists || !pathsEqual(currentDirectory.path, saipenDir)) {
        return reply.code(403).send({ error: "unsafe .saipen path" })
      }
      let currentTarget = resolveSaipenWritablePath(saipenDir, relativePath)
      if (!currentTarget) return reply.code(403).send({ error: "path not allowlisted" })
      const currentRevision = fileRevision(currentTarget)
      if (expectedRevision !== currentRevision) {
        // The file changed after the client last read it. Never overwrite a
        // newer version: the client must reload and resolve the conflict.
        return reply.code(409).send({
          error: "SAIPEN file changed externally; your draft was NOT written",
          currentRevision,
        })
      }
      try {
        mkdirSync(path.dirname(currentTarget), { recursive: true })
        currentDirectory = resolveSaipenDirectory(allowed)
        if (!currentDirectory?.exists || !pathsEqual(currentDirectory.path, saipenDir)) {
          return reply.code(403).send({ error: "unsafe .saipen path" })
        }
        currentTarget = resolveSaipenWritablePath(saipenDir, relativePath)
        if (!currentTarget) return reply.code(403).send({ error: "path not allowlisted" })
        // Same-directory temp file + rename: readers never see a half-written
        // file, and on Windows rename is the atomic replace primitive.
        const tempPath = path.join(path.dirname(currentTarget), `.${path.basename(currentTarget)}.${randomUUID()}.saiwork-tmp`)
        writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" })
        try {
          const replacementDirectory = resolveSaipenDirectory(allowed)
          if (!replacementDirectory?.exists || !pathsEqual(replacementDirectory.path, saipenDir)) {
            rmSync(tempPath, { force: true })
            return reply.code(403).send({ error: "unsafe .saipen path" })
          }
          const replacementTarget = resolveSaipenWritablePath(saipenDir, relativePath)
          if (!replacementTarget) {
            rmSync(tempPath, { force: true })
            return reply.code(403).send({ error: "path not allowlisted" })
          }
          if (
            !pathsEqual(replacementTarget, currentTarget)
            || fileRevision(replacementTarget) !== currentRevision
          ) {
            rmSync(tempPath, { force: true })
            return reply.code(409).send({
              error: "SAIPEN file changed externally; your draft was NOT written",
              currentRevision: replacementTarget ? fileRevision(replacementTarget) : "",
            })
          }
          renameSync(tempPath, currentTarget)
        } catch (error) {
          try { rmSync(tempPath, { force: true }) } catch { /* ignore */ }
          throw error
        }
        return { ok: true, revision: fileRevision(currentTarget) }
      } catch (error) {
        return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}

/**
 * Resolve a relative `.saipen` path against the allowlist and prove it stays
 * inside the directory. STATE/BOARD and kitchen plan files may be written;
 * LOG.md is read-only because it is a journal the agent appends to, and a
 * blind full-file overwrite could erase history. A traversal or an unknown
 * file is refused before anything touches disk.
 */
function resolveSaipenWritablePath(saipenDir: string, relativePath: string): string | null {
  if (relativePath === "STATE.md" || relativePath === "BOARD.md") {
    return resolvePathWithin(saipenDir, path.join(saipenDir, relativePath))
  }
  const planMatch = relativePath.match(/^kitchen\/([A-Za-z0-9._-]+\.md)$/)
  if (planMatch) {
    return resolvePathWithin(saipenDir, path.join(saipenDir, "kitchen", planMatch[1]))
  }
  return null
}

function readKitchenPlans(saipenDir: string): { name: string; content: string; truncated: boolean; revision: string }[] {
  const kitchenDir = resolveReadableSaipenPath(saipenDir, "kitchen")
  if (!kitchenDir) return []
  let names: string[]
  try {
    names = readdirSync(kitchenDir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, PLAN_FILE_LIMIT)
  } catch {
    return []
  }
  return names.flatMap((name): { name: string; content: string; truncated: boolean; revision: string }[] => {
    const file = resolveReadableSaipenPath(kitchenDir, name)
    if (!file) return []
    try {
      const bytes = readFileSync(file)
      const raw = bytes.toString("utf8")
      const content = truncateUtf8(raw, PLAN_FILE_BYTES, "head")
      const revision = createHash("sha256").update(bytes).digest("hex")
      return [{ name, content, truncated: content !== raw, revision }]
    } catch {
      return []
    }
  })
}
