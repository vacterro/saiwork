import { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SettingsService } from "../../settings/service"
import { readSaipenSubStates, resolveSaipenCore, type SaipenSettings } from "../../saipen/core"
import type { SaipenStatusResponse } from "../../api-types"

const StatusQuerySchema = z.object({
  folder: z.string().min(1).optional(),
})

interface RouteDeps {
  settings: SettingsService
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

    const response: SaipenStatusResponse = {
      enabled: resolution.enabled,
      home: resolution.home,
      protocolDir: resolution.protocolDir,
      instructions: resolution.instructions,
      missing: resolution.missing,
      error: resolution.error,
      subs: readSaipenSubStates(folder),
    }
    return response
  })
}
