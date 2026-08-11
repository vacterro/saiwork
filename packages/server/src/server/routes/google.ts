import type { FastifyInstance } from "fastify"
import { z } from "zod"

import type { SettingsService } from "../../settings/service"
import { resolveGoogleExecution } from "../../google/adapter"
import { classifyGoogleError } from "../../google/errors"
import { googleModelsFor } from "../../google/models"
import { googleProviderStatus } from "../../google/providers"
import { ANTIGRAVITY_PROVIDER_ID, GEMINI_API_PROVIDER_ID, GOOGLE_PROVIDER_IDS } from "../../google/types"
import type { Logger } from "../../logger"

interface RouteDeps {
  settings: SettingsService
  logger: Logger
}

const ProviderIdSchema = z.enum([GEMINI_API_PROVIDER_ID, ANTIGRAVITY_PROVIDER_ID])

const ClassifySchema = z.object({
  providerId: ProviderIdSchema,
  message: z.string().optional(),
  status: z.number().int().optional(),
  body: z.unknown().optional(),
})

const ResolveSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  allowProviderFallback: z.boolean().optional(),
})

const SettingsPatchSchema = z.object({
  allowProviderFallback: z.boolean().optional(),
  antigravityAcknowledged: z.boolean().optional(),
})

interface GoogleUiSettings {
  allowProviderFallback?: boolean
  antigravityAcknowledged?: boolean
}

function readUiGoogleSettings(deps: RouteDeps): GoogleUiSettings {
  const doc = deps.settings.getOwner("config", "ui") as Record<string, unknown> | undefined
  const settings = doc?.settings && typeof doc.settings === "object" ? doc.settings as Record<string, unknown> : {}
  return {
    allowProviderFallback: settings.allowProviderFallback === true,
    antigravityAcknowledged: settings.antigravityAcknowledged === true,
  }
}

export function registerGoogleRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/google/providers", async () => {
    const ui = readUiGoogleSettings(deps)
    const providers = googleProviderStatus().map((provider) => ({
      ...provider,
      modelCount: googleModelsFor(provider.id).length,
    }))
    return {
      providers,
      allowProviderFallback: ui.allowProviderFallback ?? false,
      antigravityAcknowledged: ui.antigravityAcknowledged ?? false,
    }
  })

  app.get("/api/google/models", async (request) => {
    const query = request.query as { providerId?: string }
    const providerId = query.providerId
    if (providerId && GOOGLE_PROVIDER_IDS.includes(providerId as (typeof GOOGLE_PROVIDER_IDS)[number])) {
      return { providerId, models: googleModelsFor(providerId as (typeof GOOGLE_PROVIDER_IDS)[number]) }
    }
    return { models: googleModelsFor(GEMINI_API_PROVIDER_ID).concat(googleModelsFor(ANTIGRAVITY_PROVIDER_ID)) }
  })

  app.post<{ Body: unknown }>("/api/google/classify-error", async (request, reply) => {
    const parsed = ClassifySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" })
    const normalized = classifyGoogleError(parsed.data.providerId, {
      status: parsed.data.status,
      message: parsed.data.message,
      body: parsed.data.body,
    })
    return normalized
  })

  app.post<{ Body: unknown }>("/api/google/resolve", async (request, reply) => {
    const parsed = ResolveSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" })
    const ui = readUiGoogleSettings(deps)
    try {
      const resolution = resolveGoogleExecution(parsed.data.providerId, parsed.data.modelId, {
        allowProviderFallback: parsed.data.allowProviderFallback ?? ui.allowProviderFallback ?? false,
      })
      return { resolution }
    } catch (error) {
      if (error instanceof Error && error.name === "ProviderFallbackBlockedError") {
        return reply.code(409).send({ error: error.message })
      }
      throw error
    }
  })

  app.post<{ Body: unknown }>("/api/google/settings", async (request, reply) => {
    const parsed = SettingsPatchSchema.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" })
    const current = readUiGoogleSettings(deps)
    const settingsPatch: Record<string, boolean> = {}
    if (parsed.data.allowProviderFallback !== undefined) {
      settingsPatch.allowProviderFallback = parsed.data.allowProviderFallback
    }
    if (parsed.data.antigravityAcknowledged !== undefined) {
      settingsPatch.antigravityAcknowledged = parsed.data.antigravityAcknowledged
    }
    const updated = deps.settings.mergePatchOwner("config", "ui", { settings: { ...current, ...settingsPatch } })
    const settings = updated?.settings && typeof updated.settings === "object" ? updated.settings as Record<string, unknown> : {}
    return {
      allowProviderFallback: settings.allowProviderFallback === true,
      antigravityAcknowledged: settings.antigravityAcknowledged === true,
    }
  })
}
