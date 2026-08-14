import type { FastifyReply } from "fastify"
import type { Logger } from "../logger"
import { createBackpressuredSender } from "../server/routes/events"

export interface PluginOutboundEvent {
  type: string
  properties?: Record<string, unknown>
}

interface ClientConnection {
  workspaceId: string
  send: (event: PluginOutboundEvent) => void
  close: () => void
}

export interface PluginClientRegistration {
  /** Connection-scoped send: delivers to THIS client only. */
  send: (event: PluginOutboundEvent) => void
  close: () => void
}

export class PluginChannelManager {
  private readonly clients = new Set<ClientConnection>()

  constructor(private readonly logger: Logger) {}

  register(workspaceId: string, reply: FastifyReply): PluginClientRegistration {
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      this.clients.delete(connection)
      this.logger.debug({ workspaceId }, "Plugin SSE client disconnected")
    }

    // Every registration gets its own bounded backpressure sender (the same
    // semantics as the main /api/events SSE). write() returning false is
    // backpressure: new events queue in a tiny FIFO, and a client that stays
    // too far behind is disconnected instead of growing memory. raw.write()'s
    // return value is no longer ignored.
    const sender = createBackpressuredSender({
      writeFrame: (frame) => {
        if (closed) return true
        try {
          return reply.raw.write(frame)
        } catch {
          return true
        }
      },
      onOverflow: () => {
        this.logger.warn({ workspaceId }, "Plugin SSE client too slow; disconnecting")
        close()
        try {
          reply.raw.end?.()
        } catch {
          // The raw socket may already be gone.
        }
      },
    })

    const connection: ClientConnection = {
      workspaceId,
      send: (event) => sender.send({ frame: `data: ${JSON.stringify(event)}\n\n`, type: event.type }, event as never),
      close,
    }
    this.clients.add(connection)
    this.logger.debug({ workspaceId }, "Plugin SSE client connected")

    return { send: connection.send, close }
  }

  /** Deliver a shared plugin event to every client of one workspace. */
  send(workspaceId: string, event: PluginOutboundEvent) {
    for (const client of this.clients) {
      if (client.workspaceId !== workspaceId) continue
      client.send(event)
    }
  }

  broadcast(event: PluginOutboundEvent) {
    for (const client of this.clients) {
      client.send(event)
    }
  }
}
