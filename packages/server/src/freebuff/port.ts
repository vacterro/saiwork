import { createServer, type Server } from "node:net"

/**
 * Reserve a free loopback TCP port for a spawned FreeBuff orchestrator.
 *
 * The port is bound, immediately released, and handed back to the caller;
 * there is a small race window between release and the engine binding it, which
 * is acceptable for a local single-tenant engine. Callers retry readiness on
 * failure rather than trusting the port to stay free.
 */
export async function findFreePort(
  overrides: {
    host?: string
    bind?: () => Promise<number | null>
  } = {},
): Promise<number> {
  const host = overrides.host ?? "127.0.0.1"
  const bind = overrides.bind ?? bindEphemeralPort

  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await bind()
    if (port !== null && port >= 1024 && port <= 65_535) {
      return port
    }
  }
  // Preferred range exhausted; accept any port the binder offers.
  const port = await bind()
  if (port !== null && port > 0 && port <= 65_535) {
    return port
  }
  throw new Error("Unable to reserve a loopback port for the FreeBuff engine")
}

function bindEphemeralPort(): Promise<number | null> {
  return new Promise((resolve) => {
    const server: Server = createServer()
    server.once("error", () => resolve(null))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => resolve(null))
      }
    })
  })
}
