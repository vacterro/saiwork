import { FastifyInstance } from "fastify"
import { z } from "zod"
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs"
import path from "path"
import type { SettingsService } from "../../settings/service"
import {
  readSaipenProjectState,
  readSaipenSubStates,
  resolveSaipenCore,
  saipenRestartRequired,
  type SaipenSettings,
} from "../../saipen/core"
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
})

interface RouteDeps {
  settings: SettingsService
  /** Supplies the launch-time state of a running workspace. */
  getSaipenLaunchState?: (folder: string) => import("../../saipen/core").SaipenLaunchState | null
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
  app.get("/api/saipen/status", async (request) => {
    const query = StatusQuerySchema.safeParse(request.query ?? {})
    const folder = query.success ? query.data.folder : undefined
    const serverConfig = deps.settings.getOwner("config", "server") as { saipen?: SaipenSettings } | undefined
    const resolution = resolveSaipenCore(serverConfig?.saipen, { workspaceFolder: folder })

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

  app.get("/api/saipen/view", async (request): Promise<SaipenViewResponse> => {
    const query = StatusQuerySchema.safeParse(request.query ?? {})
    const folder = query.success ? query.data.folder : undefined
    if (!folder) return { state: null, board: null, log: null, logTruncated: false, plans: [], missing: true }

    const saipenDir = path.join(folder, ".saipen")
    if (!existsSync(path.join(saipenDir, "STATE.md")) && !existsSync(path.join(saipenDir, "BOARD.md"))) {
      return { state: null, board: null, log: null, logTruncated: false, plans: [], missing: true }
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
      log,
      logTruncated,
      plans: readKitchenPlans(saipenDir),
      missing: false,
    }
  })

  app.put("/api/saipen/file", async (request, reply) => {
    const body = WriteBodySchema.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: "invalid body" })
    const { folder, relativePath, content } = body.data

    const saipenDir = path.join(folder, ".saipen")
    const target = resolveSaipenWritablePath(saipenDir, relativePath)
    if (!target) return reply.code(403).send({ error: "path not allowlisted" })
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return reply.code(413).send({ error: "content too large" })
    }
    try {
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, content, "utf8")
      return { ok: true }
    } catch (error) {
      return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * Resolve a relative `.saipen` path against the allowlist and prove it stays
 * inside the directory. Only the tracked files the panel shows may be written;
 * a traversal or an unknown file is refused before anything touches disk.
 */
function resolveSaipenWritablePath(saipenDir: string, relativePath: string): string | null {
  const allowed: Array<{ name: string; dir: string }> = [
    { name: "STATE.md", dir: saipenDir },
    { name: "BOARD.md", dir: saipenDir },
    { name: "LOG.md", dir: saipenDir },
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
