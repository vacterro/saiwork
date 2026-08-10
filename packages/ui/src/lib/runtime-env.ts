import { getLogger } from "./logger"

export type HostRuntime = "electron" | "tauri" | "web"
export type PlatformKind = "desktop" | "mobile"
export type WindowContextKind = "local" | "local-session" | "remote"

export interface RuntimeEnvironment {
  host: HostRuntime
  platform: PlatformKind
  windowContext: WindowContextKind
}

declare global {
  interface TauriCoreModule {
    invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  }

  interface Window {
    __SAIWORK_WINDOW_CONTEXT__?: WindowContextKind
    electronAPI?: ElectronAPI
    __TAURI__?: {
      core?: TauriCoreModule
    }
  }
}

function detectWindowContext(): WindowContextKind {
  if (typeof window === "undefined") {
    return "remote"
  }

  if (window.__SAIWORK_WINDOW_CONTEXT__ === "remote") {
    return "remote"
  }

  if (window.__SAIWORK_WINDOW_CONTEXT__ === "local-session") {
    return "local-session"
  }

  if (window.__SAIWORK_WINDOW_CONTEXT__ === "local") {
    return "local"
  }

  const win = window as Window & { electronAPI?: unknown }
  if (typeof win.electronAPI !== "undefined" || typeof win.__TAURI__ !== "undefined") {
    return "local"
  }

  if (typeof navigator !== "undefined" && /tauri/i.test(navigator.userAgent)) {
    return "local"
  }

  return "remote"
}

function detectHost(): HostRuntime {
  if (typeof window === "undefined") {
    return "web"
  }

  const explicitHost = window.__SAIWORK_RUNTIME_HOST__
  if (explicitHost) {
    return explicitHost
  }

  const win = window as Window & { electronAPI?: unknown }
  if (typeof win.electronAPI !== "undefined") {
    return "electron"
  }

  if (typeof win.__TAURI__ !== "undefined") {
    return "tauri"
  }

  if (typeof navigator !== "undefined" && /tauri/i.test(navigator.userAgent)) {
    return "tauri"
  }

  return "web"
}

function detectPlatform(): PlatformKind {
  if (typeof navigator === "undefined") {
    return "desktop"
  }

  const uaData = (navigator as any).userAgentData
  if (uaData?.mobile) {
    return "mobile"
  }

  const ua = navigator.userAgent.toLowerCase()
  if (/android|iphone|ipad|ipod|blackberry|mini|windows phone|mobile|silk/.test(ua)) {
    return "mobile"
  }

  return "desktop"
}

const log = getLogger("actions")

let cachedEnv: RuntimeEnvironment | null = null

export function detectRuntimeEnvironment(): RuntimeEnvironment {
  if (cachedEnv) {
    return cachedEnv
  }
  cachedEnv = {
    host: detectHost(),
    platform: detectPlatform(),
    windowContext: detectWindowContext(),
  }
  if (typeof window !== "undefined") {
    log.info(`[runtime] host=${cachedEnv.host} platform=${cachedEnv.platform} context=${cachedEnv.windowContext}`)
  }
  return cachedEnv
}

export const runtimeEnv = detectRuntimeEnvironment()

export const isElectronHost = () => detectHost() === "electron"
export const isTauriHost = () => detectHost() === "tauri"
export const isWebHost = () => detectHost() === "web"
export const isDesktopHost = () => isElectronHost() || isTauriHost()
export const isMobilePlatform = () => detectPlatform() === "mobile"
export const isLocalWindow = () => detectWindowContext() === "local"
export const isSessionPaneWindow = () => detectWindowContext() === "local-session"
export const isRemoteWindow = () => detectWindowContext() === "remote"
export const canUseNativeDialogs = () => isDesktopHost() && isLocalWindow()
export const canOpenRemoteWindows = () => isDesktopHost() && isLocalWindow()
export const canRestartCli = () => isDesktopHost() && isLocalWindow()
export const canUseDesktopFolderDrop = () => isDesktopHost() && isLocalWindow()

export interface SessionPaneRoute {
  instanceId: string | null
  sessionId: string | null
}

/** Reads the `?instance=&session=` route a detached pane window was opened with. */
export function readSessionPaneRoute(): SessionPaneRoute {
  if (typeof window === "undefined") return { instanceId: null, sessionId: null }
  const params = new URLSearchParams(window.location.search)
  return {
    instanceId: params.get("instance"),
    sessionId: params.get("session"),
  }
}
