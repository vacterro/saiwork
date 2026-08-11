export {}

import type { LoggerControls } from "../lib/logger"

declare global {
  interface ElectronDialogFilter {
    name?: string
    extensions: string[]
  }

  interface ElectronDialogOptions {
    mode: "directory" | "file"
    title?: string
    defaultPath?: string
    filters?: ElectronDialogFilter[]
    multiple?: boolean
  }

  interface ElectronDialogResult {
    canceled?: boolean
    paths?: string[]
    path?: string | null
  }

  interface ElectronClientStateLoadResult {
    isPrimary: boolean
    restoreEnabled: boolean
    snapshot: unknown | null
  }

  interface ElectronAPI {
    onCliStatus?: (callback: (data: unknown) => void) => () => void
    onCliError?: (callback: (data: unknown) => void) => () => void
    getCliStatus?: () => Promise<unknown>
    restartCli?: () => Promise<unknown>
    openDialog?: (options: ElectronDialogOptions) => Promise<ElectronDialogResult>
    getDirectoryPaths?: (paths: string[]) => Promise<string[]>
    getPathForFile?: (file: File) => string | null
    requestMicrophoneAccess?: () => Promise<{ granted: boolean }>
    setWakeLock?: (enabled: boolean) => Promise<{ enabled: boolean }>
    claimClientStateAccess?: (accessToken: string) => Promise<boolean>
    loadClientState?: (accessToken: string) => Promise<ElectronClientStateLoadResult>
    saveClientState?: (accessToken: string, snapshot: unknown) => Promise<boolean>
    setClientStateRestoreEnabled?: (accessToken: string, enabled: boolean) => Promise<boolean>
    clearClientState?: (accessToken: string) => Promise<boolean>

    showNotification?: (payload: { title: string; body: string }) => Promise<{ ok: boolean; reason?: string }>
    openRemoteWindow?: (payload: {
      id: string
      name: string
      baseUrl: string
      entryUrl?: string
      proxySessionId?: string
      skipTlsVerify: boolean
    }) => Promise<{ ok: boolean }>

    getWorkArea?: () => Promise<{ x: number; y: number; width: number; height: number }>
    snapWindowToBounds?: (bounds: { x: number; y: number; width: number; height: number }) => Promise<{ ok: boolean }>
    openSessionPane?: (payload: { ownerInstanceId: string; paneId: string; instanceId: string; sessionId: string }) => Promise<{ ok: boolean }>
    reattachSessionPane?: (payload: { ownerInstanceId: string; paneId: string; instanceId: string; sessionId: string }) => Promise<{ ok: boolean }>
    onSessionPaneState?: (callback: (payload: { ownerInstanceId: string; paneId: string; instanceId: string; sessionId: string; state: "detached" | "recover" }) => void) => () => void
    sessionPaneOwnerReady?: () => Promise<{ ok: boolean }>
    sessionPaneOwnerAck?: (payload: { ownerInstanceId: string; paneId: string; instanceId: string; sessionId: string }) => Promise<{ ok: boolean }>
    setMenuVisible?: (visible: boolean) => Promise<{ ok: boolean }>
  }

  interface File {
    path?: string
  }

  interface FileSystemEntry {
    isDirectory: boolean
    isFile: boolean
  }

  interface DataTransferItem {
    webkitGetAsEntry?: () => FileSystemEntry | null
  }

  interface TauriBridge {
    core?: {
      invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    }
  }

  interface Window {
      __SAIWORK_API_BASE__?: string
      __SAIWORK_EVENTS_URL__?: string
       __SAIWORK_RUNTIME_HOST__?: "electron" | "tauri" | "web"
       __SAIWORK_WINDOW_CONTEXT__?: "local" | "local-session" | "remote"
       __SAIWORK_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__?: () => Promise<void>
       electronAPI?: ElectronAPI
      __TAURI__?: TauriBridge
      saiworkLogger?: LoggerControls
   }
 }
