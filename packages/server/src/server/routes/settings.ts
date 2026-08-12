import { FastifyInstance } from "fastify"
import { z } from "zod"
import { probeBinaryVersion } from "../../workspaces/spawn"
import type { SettingsService } from "../../settings/service"
import { SettingsStorageError } from "../../settings/yaml-doc-store"
import type { Logger } from "../../logger"
import { sanitizeConfigDoc, sanitizeConfigOwner } from "../../settings/public-config"

interface RouteDeps {
  settings: SettingsService
  logger: Logger
}

const ValidateBinarySchema = z.object({
  path: z.string(),
})

function validateBinaryPath(binaryPath: string): Promise<{ valid: boolean; version?: string; error?: string }> {
  return probeBinaryVersion(binaryPath)
}

export function enforceSpeechCredentialPairing(body: unknown, currentSpeech?: unknown): unknown {
  if (!body || typeof body !== "object") return body
  const patch = { ...(body as Record<string, unknown>) }
  const speech = patch.speech
  if (!speech || typeof speech !== "object") return patch
  const speechPatch = { ...(speech as Record<string, unknown>) }
  const cur = (currentSpeech && typeof currentSpeech === "object") ? currentSpeech as Record<string, unknown> : {}
  const curSpeech = (cur.speech && typeof cur.speech === "object") ? cur.speech as Record<string, unknown> : cur

  if ("baseUrl" in speechPatch && !("apiKey" in speechPatch)) {
    if ((speechPatch.baseUrl ?? "") !== (curSpeech.baseUrl ?? "")) {
      speechPatch.apiKey = null
    }
  }
  for (const dir of ["stt", "tts"] as const) {
    if (dir in speechPatch) {
      const dirPatch = { ...(speechPatch[dir] as Record<string, unknown>) }
      if ("baseUrl" in dirPatch && !("apiKey" in dirPatch)) {
        const curDir = (curSpeech[dir] && typeof curSpeech[dir] === "object") ? curSpeech[dir] as Record<string, unknown> : {}
        if ((dirPatch.baseUrl ?? "") !== (curDir.baseUrl ?? "")) {
          dirPatch.apiKey = null
        }
        speechPatch[dir] = dirPatch
      }
    }
  }
  patch.speech = speechPatch
  return patch
}

export function registerSettingsRoutes(app: FastifyInstance, deps: RouteDeps) {
  // A storage failure (corrupt/unreadable source or failed durable write) is a
  // server error, not a bad request: the body was fine, the disk lied.
  const storageStatus = (error: unknown): number =>
    error instanceof SettingsStorageError ? 500 : 400
  const storageError = (error: unknown): { error: string } => ({
    error: error instanceof SettingsStorageError && error.code === "load_failure"
      ? `settings storage is unavailable: ${error.message}`
      : error instanceof Error
        ? error.message
        : "Invalid patch",
  })

  // Full-document access
  app.get("/api/storage/config", async (request, reply) => {
    try {
      return sanitizeConfigDoc(deps.settings.getDoc("config"))
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })
  app.patch("/api/storage/config", async (request, reply) => {
    try {
      let body = request.body ?? {}
      if (body && typeof body === "object" && "server" in body) {
        const bodyObj = { ...(body as Record<string, unknown>) }
        const serverPatch = bodyObj.server
        if (serverPatch && typeof serverPatch === "object") {
          const currentServer = deps.settings.getOwner("config", "server")
          bodyObj.server = enforceSpeechCredentialPairing(serverPatch, currentServer)
        }
        body = bodyObj
      }
      return sanitizeConfigDoc(deps.settings.mergePatchDoc("config", body))
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })

  app.get<{ Params: { owner: string } }>("/api/storage/config/:owner", async (request, reply) => {
    try {
      return sanitizeConfigOwner(request.params.owner, deps.settings.getOwner("config", request.params.owner))
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })

  app.patch<{ Params: { owner: string } }>("/api/storage/config/:owner", async (request, reply) => {
    try {
      const currentOwner = request.params.owner === "server"
        ? deps.settings.getOwner("config", "server")
        : undefined
      const processed = request.params.owner === "server"
        ? enforceSpeechCredentialPairing(request.body ?? {}, currentOwner)
        : request.body ?? {}
      return sanitizeConfigOwner(
        request.params.owner,
        deps.settings.mergePatchOwner("config", request.params.owner, processed),
      )
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })

  app.get("/api/storage/state", async (request, reply) => {
    try {
      return deps.settings.getDoc("state")
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })
  app.patch("/api/storage/state", async (request, reply) => {
    try {
      return deps.settings.mergePatchDoc("state", request.body ?? {})
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })

  app.get<{ Params: { owner: string } }>("/api/storage/state/:owner", async (request, reply) => {
    try {
      return deps.settings.getOwner("state", request.params.owner)
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })

  app.patch<{ Params: { owner: string } }>("/api/storage/state/:owner", async (request, reply) => {
    try {
      return deps.settings.mergePatchOwner("state", request.params.owner, request.body ?? {})
    } catch (error) {
      reply.code(storageStatus(error))
      return storageError(error)
    }
  })

  // Binary validation helper (used by UI when adding binaries)
  app.post("/api/storage/binaries/validate", async (request, reply) => {
    try {
      const body = ValidateBinarySchema.parse(request.body ?? {})
      return await validateBinaryPath(body.path)
    } catch (error) {
      deps.logger.warn({ err: error }, "Failed to validate binary")
      reply.code(400)
      return { valid: false, error: error instanceof Error ? error.message : "Invalid request" }
    }
  })
}
