import { FastifyInstance } from "fastify"
import { z } from "zod"
import { createHash } from "crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, rmSync, realpathSync } from "fs"
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

function withSaipenWriteQueue<T>(saipenDir: string, operation: () => Promise<T>): Promise<T> {
  const previous = saipenWriteQueues.get(saipenDir) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  saipenWriteQueues.set(saipenDir, next.then(() => undefined, () => undefined))
  return next
}

function fileRevision(filePath: string): string {
  if (!existsSync(filePath)) return ""
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

interface RouteDeps {
  settings: SettingsService
  /** Supplies the launch-time state of a running workspace. */
  getSaipenLaunchState?: (folder: string) => import("../../saipen/core").SaipenLaunchState | null
  /** Optional registry gate: when present, `folder` must be a registered workspace. */
  workspaceManager?: { list: () => import("../../api-types").WorkspaceDescriptor[] }
}

function normalizeFolderPath(folder: string): string {
  return path.normalize(folder).replace(/[\\/]+$/, "")
}

/** Resolves the folder to its canonical path and proves it is on disk. */
function canonicalFolderPath(folder: string): string | null {
  try {
    return realpathSync(folder)
  } catch {
    return null
  }
}

/**
 * Proves a caller-supplied `.saipen` folder is a real, registered SAIWORK
 * workspace. The canonicalized path must match a registered workspace path;
 * a symlink/junction that escapes the registry is rejected because the two
 * resolve to different canonical paths.
 */
function resolveAllowedSaipenFolder(folder: string | undefined, manager: RouteDeps["workspaceManager"]): string | null {
  if (!folder) return null
  if (!manager) return folder
  const canonical = canonicalFolderPath(folder)
  if (!canonical) return null
  const registered = manager.list()
  return registered.some((workspace) => {
    const registeredPath = canonicalFolderPath(workspace.path)
    return registeredPath !== null && normalizeFolderPath(registeredPath) === normalizeFolderPath(canonical)
  }) ? folder : null
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
    const folder = query.success ? query.data.folder : undefined
    const allowed = resolveAllowedSaipenFolder(folder, deps.workspaceManager)
    if (folder && !allowed) return reply.code(403).send({ error: "unknown workspace" })
    const serverConfig = deps.settings.getOwner("config", "server") as { saipen?: SaipenSettings } | undefined
    const resolution = resolveSaipenCore(serverConfig?.saipen, { workspaceFolder: allowed ?? undefined })

    // Configured is what a NEW workspace would get; effective is what the one
    // already running actually launched with. Reporting only the first is how
    // the bar could claim "Core loaded" for a session that has none.
    const launched = folder ? (deps.getSaipenLaunchState?.(folder) ?? null) : null

    const response: SaipenStatusResponse = {
      enabled: resolution.enabled,
      home: resolution.home,
      protocolDir: resolution.protocolDir,
      instructions: resolution.instructions,
      missing: resolution.missing,
      error: resolution.error,
      project: readSaipenProjectState(folder),
      subs: readSaipenSubStates(folder),
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
    const folder = query.success ? query.data.folder : undefined
    const allowed = resolveAllowedSaipenFolder(folder, deps.workspaceManager)
    if (folder && !allowed) {
      reply.code(403).send({ error: "unknown workspace" })
      return { state: null, board: null, boardSections: [], log: null, logTruncated: false, plans: [], revisions: {}, missing: true }
    }
    if (!allowed) return {
      state: null, board: null, boardSections: [], log: null, logTruncated: false, plans: [], revisions: {}, missing: true,
    }

    const saipenDir = path.join(allowed, ".saipen")
    if (!existsSync(path.join(saipenDir, "STATE.md")) && !existsSync(path.join(saipenDir, "BOARD.md"))) {
      return {
        state: null, board: null, boardSections: [], log: null, logTruncated: false, plans: [], revisions: {}, missing: true,
      }
    }

    const read = (name: string): string | null => {
      const file = path.join(saipenDir, name)
      if (!existsSync(file)) return null
      try {
        return readFileSync(file, "utf8")
      } catch {
        return null
      }
    }

    const logPath = path.join(saipenDir, "LOG.md")
    let log: string | null = null
    let logTruncated = false
    if (existsSync(logPath)) {
      try {
        const full = readFileSync(logPath, "utf8")
        const lines = full.split(/\r?\n/)
        const tail = lines.slice(-LOG_TAIL_LINES)
        let text = tail.join("\n")
        if (Buffer.byteLength(text, "utf8") > LOG_TAIL_BYTES) {
          text = text.slice(-LOG_TAIL_BYTES)
          text = text.slice(text.indexOf("\n") + 1)
        }
        log = text
        logTruncated = lines.length > LOG_TAIL_LINES || Buffer.byteLength(full, "utf8") > LOG_TAIL_BYTES
      } catch {
        log = null
      }
    }

    return {
      state: read("STATE.md"),
      board: read("BOARD.md"),
      boardSections: parseBoardSections(read("BOARD.md")),
      log,
      logTruncated,
      plans: readKitchenPlans(saipenDir),
      revisions: {
        "STATE.md": fileRevision(path.join(saipenDir, "STATE.md")),
        "BOARD.md": fileRevision(path.join(saipenDir, "BOARD.md")),
        "LOG.md": fileRevision(path.join(saipenDir, "LOG.md")),
      },
      missing: false,
    }
  })

  app.put("/api/saipen/file", async (request, reply) => {
    const body = WriteBodySchema.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: "invalid body" })
    const { folder, relativePath, content, expectedRevision } = body.data

    const allowed = resolveAllowedSaipenFolder(folder, deps.workspaceManager)
    if (!allowed) return reply.code(403).send({ error: "unknown workspace" })

    const saipenDir = path.join(allowed, ".saipen")
    const target = resolveSaipenWritablePath(saipenDir, relativePath)
    if (!target) return reply.code(403).send({ error: "path not allowlisted" })
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return reply.code(413).send({ error: "content too large" })
    }

    return withSaipenWriteQueue(saipenDir, async () => {
      const currentRevision = fileRevision(target)
      if (expectedRevision !== currentRevision) {
        // The file changed after the client last read it. Never overwrite a
        // newer version: the client must reload and resolve the conflict.
        return reply.code(409).send({
          error: "SAIPEN file changed externally; your draft was NOT written",
          currentRevision,
        })
      }
      try {
        mkdirSync(path.dirname(target), { recursive: true })
        // Same-directory temp file + rename: readers never see a half-written
        // file, and on Windows rename is the atomic replace primitive.
        const tempPath = `${target}.saiwork-tmp`
        writeFileSync(tempPath, content, "utf8")
        try {
          renameSync(tempPath, target)
        } catch (error) {
          try { rmSync(tempPath, { force: true }) } catch { /* ignore */ }
          throw error
        }
        return { ok: true, revision: fileRevision(target) }
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
  const allowed: Array<{ name: string; dir: string }> = [
    { name: "STATE.md", dir: saipenDir },
    { name: "BOARD.md", dir: saipenDir },
  ]
  for (const entry of allowed) {
    if (relativePath !== entry.name) continue
    const resolved = path.resolve(entry.dir, entry.name)
    return resolved.startsWith(saipenDir + path.sep) ? resolved : null
  }
  const planMatch = relativePath.match(/^kitchen\/([A-Za-z0-9._-]+\.md)$/)
  if (planMatch) {
    const kitchenDir = path.join(saipenDir, "kitchen")
    const resolved = path.resolve(kitchenDir, planMatch[1])
    return resolved.startsWith(kitchenDir + path.sep) ? resolved : null
  }
  return null
}

function readKitchenPlans(saipenDir: string): { name: string; content: string }[] {
  const kitchenDir = path.join(saipenDir, "kitchen")
  if (!existsSync(kitchenDir)) return []
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
  return names.flatMap((name): { name: string; content: string }[] => {
    const file = path.join(kitchenDir, name)
    try {
      const raw = readFileSync(file, "utf8")
      const content = Buffer.byteLength(raw, "utf8") > PLAN_FILE_BYTES ? raw.slice(0, PLAN_FILE_BYTES) : raw
      return [{ name, content }]
    } catch {
      return []
    }
  })
}
