import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import net, { type Server, type Socket } from "node:net"

const FREEBUFF_LIFETIME_HANDSHAKE_TIMEOUT_MS = 5_000
const FREEBUFF_LIFETIME_HEARTBEAT_INTERVAL_MS = 1_000
const MAX_HANDSHAKE_BYTES = 1_024

export interface FreebuffShellLifetime {
  readonly port: number
  readonly token: string
  /** Drop the current child connection while leaving the listener reusable. */
  disconnectClients(): void
  /** Close the listener and every child connection. Idempotent. */
  close(): Promise<void>
}

export interface FreebuffShellLifetimeOptions {
  /** Test-only deterministic secret. Production always uses 256 random bits. */
  token?: string
  handshakeTimeoutMs?: number
  heartbeatIntervalMs?: number
  onFailure?: (error: Error) => void
}

/**
 * Desktop-compatible authenticated parent-lifetime channel.
 *
 * The orchestrator receives `token` once on stdin, connects back over loopback,
 * and proves possession with the same two-challenge HMAC exchange used by
 * FreeBuff Desktop. Closing this channel is the graceful shutdown signal that
 * lets the orchestrator release hosted session slots before the process exits.
 */
export function createFreebuffShellLifetimeServer(
  options: FreebuffShellLifetimeOptions = {},
): Promise<FreebuffShellLifetime> {
  const token = options.token ?? randomBytes(32).toString("base64url")
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? FREEBUFF_LIFETIME_HANDSHAKE_TIMEOUT_MS
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? FREEBUFF_LIFETIME_HEARTBEAT_INTERVAL_MS
  const sockets = new Set<Socket>()
  const server = net.createServer((socket) => authenticateSocket(socket))
  let settled = false
  let closing = false
  let closePromise: Promise<void> | null = null

  function authenticateSocket(socket: Socket): void {
    const challenge = randomBytes(32).toString("base64url")
    let input = ""
    let heartbeat: ReturnType<typeof setInterval> | null = null
    const handshakeTimeout = setTimeout(() => socket.destroy(), handshakeTimeoutMs)
    handshakeTimeout.unref?.()
    sockets.add(socket)
    socket.setEncoding("utf8")
    socket.on("error", () => {})
    socket.write(`${challenge}\n`)

    const cleanup = () => {
      clearTimeout(handshakeTimeout)
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      sockets.delete(socket)
    }
    socket.once("close", cleanup)
    socket.on("data", (chunk: string) => {
      input += chunk
      if (input.length > MAX_HANDSHAKE_BYTES) {
        socket.destroy()
        return
      }
      const newline = input.indexOf("\n")
      if (newline < 0) return
      const [clientChallenge, proof, extra] = input.slice(0, newline).split(":")
      if (!clientChallenge || !proof || extra !== undefined) {
        socket.destroy()
        return
      }
      const received = Buffer.from(proof, "base64url")
      const expected = createHmac("sha256", token)
        .update(`client:${challenge}:${clientChallenge}`)
        .digest()
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        socket.destroy()
        return
      }

      clearTimeout(handshakeTimeout)
      socket.removeAllListeners("data")
      const response = createHmac("sha256", token)
        .update(`server:${challenge}:${clientChallenge}`)
        .digest("base64url")
      socket.write(`${response}\n`)
      heartbeat = setInterval(() => {
        try {
          if (!socket.destroyed) socket.write("ping\n")
        } catch {
          socket.destroy()
        }
      }, heartbeatIntervalMs)
      heartbeat.unref?.()
    })
  }

  const disconnectClients = () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    disconnectClients()
    closePromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error)
        else resolve()
      })
    })
    return closePromise
  }

  return new Promise((resolve, reject) => {
    server.on("error", (cause) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      if (!settled) {
        settled = true
        disconnectClients()
        reject(error)
      } else if (!closing) {
        options.onFailure?.(error)
      }
    })
    server.listen(0, "127.0.0.1", () => {
      if (settled) return
      const address = server.address()
      if (!address || typeof address === "string") {
        settled = true
        void close().finally(() => reject(new Error("Could not resolve the FreeBuff shell lifetime port")))
        return
      }
      settled = true
      resolve({ port: address.port, token, disconnectClients, close })
    })
  })
}
