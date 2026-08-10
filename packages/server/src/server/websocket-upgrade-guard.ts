import type { Socket } from "net"

const claimedUpgradeSockets = new WeakSet<Socket>()

export function claimWebSocketUpgrade(socket: Socket): void {
  claimedUpgradeSockets.add(socket)
}

export function isWebSocketUpgradeClaimed(socket: Socket): boolean {
  return claimedUpgradeSockets.has(socket)
}

export function resolveUiDevWebSocketTarget(requestUrl: string | undefined, uiDevServerUrl: string): URL | null {
  if (!requestUrl?.startsWith("/") || requestUrl.startsWith("//") || requestUrl.startsWith("/\\")) return null
  const baseUrl = new URL(uiDevServerUrl)
  const targetUrl = new URL(requestUrl, baseUrl)
  return targetUrl.origin === baseUrl.origin ? targetUrl : null
}

export function guardWebSocketUpgrade(socket: Socket, onError: (error: Error) => void): void {
  socket.on("error", onError)
  setImmediate(() => {
    if (!claimedUpgradeSockets.has(socket) && !socket.destroyed) {
      socket.destroy()
    }
  })
}
