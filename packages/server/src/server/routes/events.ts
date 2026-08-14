import { FastifyInstance } from "fastify"
import { z } from "zod"
import { EventBus } from "../../events/bus"
import { WorkspaceEventPayload } from "../../api-types"
import type { ClientConnectionManager } from "../../clients/connection-manager"
import { Logger } from "../../logger"
import { sanitizeLogValue } from "../../log-sanitize"

interface RouteDeps {
  eventBus: EventBus
  registerClient: (cleanup: () => void) => () => void
  logger: Logger
  connectionManager: ClientConnectionManager
}

let nextClientId = 0

const ConnectionQuerySchema = z.object({
  clientId: z.string().trim().min(1),
  connectionId: z.string().trim().min(1),
})

const PongBodySchema = ConnectionQuerySchema.extend({
  pingTs: z.number().optional(),
})

const MAX_PENDING_EVENTS = 64

export interface BackpressuredSenderOptions {
  writeFrame: (payload: unknown) => boolean
  onOverflow: () => void
  onTrace?: (event: WorkspaceEventPayload) => void
  maxPending?: number
}

/**
 * Bounded per-client SSE sender. A slow client (write() returning false)
 * switches the sender into backpressure: new events are coalesced into a tiny
 * backlog (newest per type) and the writer is told to stop until drain. A
 * client that stays too far behind trips the overflow and is disconnected, so
 * server memory stays bounded. Events are invalidation hints, not durable
 * state; order is preserved across types and within a type only the newest
 * state is retained while backlogged.
 */
export function createBackpressuredSender(options: BackpressuredSenderOptions) {
  const maxPending = options.maxPending ?? MAX_PENDING_EVENTS
  let closed = false
  let backpressured = false
  let pending: WorkspaceEventPayload[] = []

  return {
    get pendingCount(): number {
      return pending.length
    },
    get isBackpressured(): boolean {
      return backpressured
    },
    send(event: WorkspaceEventPayload): void {
      if (closed) return
      options.onTrace?.(event)
      if (backpressured) {
        if (pending.length >= maxPending) {
          // Overflow is terminal: the client is disconnected and re-syncs
          // authoritatively, so no further events are accepted.
          options.onOverflow()
          closed = true
          pending = []
          backpressured = false
          return
        }
        const index = pending.findIndex((entry) => entry.type === event.type)
        if (index >= 0) pending[index] = event
        else pending.push(event)
        return
      }
      if (!options.writeFrame(event)) {
        backpressured = true
        pending = [event]
      }
    },
    /** Flush the backlog after the underlying writer drains. */
    flush(): void {
      if (closed || !backpressured) return
      while (pending.length > 0) {
        const next = pending.shift()!
        if (!options.writeFrame(next)) return
      }
      backpressured = false
    },
    close(): void {
      closed = true
      pending = []
      backpressured = false
    },
  }
}

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/events", (request, reply) => {
    const clientId = ++nextClientId
    const connection = ConnectionQuerySchema.parse(request.query ?? {})
    deps.logger.debug({ clientId }, "SSE client connected")

    const origin = request.headers.origin ?? "*"
    reply.raw.setHeader("Access-Control-Allow-Origin", origin)
    reply.raw.setHeader("Access-Control-Allow-Credentials", "true")
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.flushHeaders?.()
    reply.hijack()

    let closed = false

    const writeFrame = (payload: unknown): boolean => {
      return reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const sender = createBackpressuredSender({
      writeFrame,
      onOverflow: () => {
        deps.logger.warn({ clientId }, "SSE client too slow; disconnecting to force authoritative re-sync")
        close()
      },
      onTrace: (event) => {
        deps.logger.debug({ clientId, type: event.type }, "SSE event dispatched")
        if (deps.logger.isLevelEnabled("trace")) {
          deps.logger.trace({ clientId, event: sanitizeLogValue(event) }, "SSE event payload")
        }
      },
    })

    const send = (event: WorkspaceEventPayload) => sender.send(event)

    const unsubscribe = deps.eventBus.onEvent(send)
    reply.raw.on("drain", () => sender.flush())
    const heartbeat = setInterval(() => {
      if (closed || sender.isBackpressured) return
      const ping = { ts: Date.now() }
      reply.raw.write(`event: saiwork.client.ping\ndata: ${JSON.stringify(ping)}\n\n`)
    }, 15000)

    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      sender.close()
      unsubscribe()
      reply.raw.end?.()
      deps.logger.debug({ clientId }, "SSE client disconnected")
    }

    const unregister = deps.registerClient(close)
    const unregisterConnection = deps.connectionManager.register({
      ...connection,
      close,
    })

    const handleClose = () => {
      close()
      unregister()
      unregisterConnection()
    }

    request.raw.on("close", handleClose)
    request.raw.on("error", handleClose)
  })

  app.post("/api/client-connections/pong", (request, reply) => {
    const body = PongBodySchema.parse(request.body ?? {})
    if (!deps.connectionManager.pong(body)) {
      reply.code(404).send({ error: "Client connection not found" })
      return
    }
    reply.code(204).send()
  })
}
