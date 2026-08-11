import type { EventBus } from "../events/bus"
import type { WorkspaceManager } from "../workspaces/manager"
import type { Logger } from "../logger"
import type { PluginOutboundEvent } from "./channel"

export interface PluginInboundEvent {
  type: string
  properties?: Record<string, unknown>
}

interface HandlerDeps {
  workspaceManager: WorkspaceManager
  eventBus: EventBus
  logger: Logger
}

export function handlePluginEvent(workspaceId: string, event: PluginInboundEvent, deps: HandlerDeps) {
  switch (event.type) {
    case "saiwork.pong":
      deps.logger.debug({ workspaceId, properties: event.properties }, "Plugin pong received")
      return

    case "saiwork.googleError": {
      // Forwarded by the plugin from a google_* provider session error. The
      // message is already normalized and sanitized by the classifier; do not
      // log the raw properties (they could carry credentials).
      const code = typeof event.properties?.code === "string" ? event.properties.code : "UNKNOWN_PROVIDER_ERROR"
      deps.logger.warn({ workspaceId, code }, "Google provider error surfaced by plugin")
      deps.eventBus.publish({
        type: "saiwork.googleError",
        workspaceId,
        properties: { code, ...event.properties },
      } as never)
      return
    }

    default:
      deps.logger.debug({ workspaceId, eventType: event.type }, "Unhandled plugin event")
  }
}

export function buildPingEvent(): PluginOutboundEvent {

  return {
    type: "saiwork.ping",
    properties: {
      ts: Date.now(),
    },
  }
}
