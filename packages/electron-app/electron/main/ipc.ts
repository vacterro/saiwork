import { BrowserWindow, Notification, dialog, ipcMain, powerSaveBlocker, screen, type OpenDialogOptions } from "electron"
import fs from "fs"
import { requestMicrophoneAccess } from "./permissions"
import type { CliProcessManager, CliStatus } from "./process-manager"

let wakeLockId: number | null = null
let cliIPCRegistered = false

interface CliIPCOptions {
  getMainWindow(): BrowserWindow | null
  openRemoteWindow(payload: { id: string; name: string; baseUrl: string; skipTlsVerify: boolean }): Promise<void>
}

interface DialogOpenRequest {
  mode: "directory" | "file"
  title?: string
  defaultPath?: string
  filters?: Array<{ name?: string; extensions: string[] }>
  multiple?: boolean
}

interface DialogOpenResult {
  canceled: boolean
  paths: string[]
}

export function setupCliIPC(cliManager: CliProcessManager, options: CliIPCOptions) {
  if (cliIPCRegistered) return
  cliIPCRegistered = true

  const sendToMain = (channel: string, payload: unknown) => {
    const mainWindow = options.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  cliManager.on("status", (status: CliStatus) => {
    sendToMain("cli:status", status)
  })

  cliManager.on("ready", (status: CliStatus) => {
    sendToMain("cli:ready", status)
  })

  cliManager.on("error", (error: Error) => {
    sendToMain("cli:error", { message: error.message })
  })

  ipcMain.handle("cli:getStatus", async () => cliManager.getStatus())

  ipcMain.handle("cli:restart", async () => {
    const devMode = process.env.NODE_ENV === "development"
    return cliManager.restart({ dev: devMode })
  })

  ipcMain.handle("dialog:open", async (_, request: DialogOpenRequest): Promise<DialogOpenResult> => {
    const properties: OpenDialogOptions["properties"] =
      request.mode === "directory" ? ["openDirectory", "createDirectory"] : ["openFile"]
    if (request.mode === "file" && request.multiple) {
      properties.push("multiSelections")
    }

    const filters = request.filters?.map((filter) => ({
      name: filter.name ?? "Files",
      extensions: filter.extensions,
    }))

    const mainWindow = options.getMainWindow()
    const windowTarget = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const dialogOptions: OpenDialogOptions = {
      title: request.title,
      defaultPath: request.defaultPath,
      properties,
      filters,
    }
    const result = windowTarget
      ? await dialog.showOpenDialog(windowTarget, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)

    return { canceled: result.canceled, paths: result.filePaths }
  })

  ipcMain.handle("filesystem:getDirectoryPaths", async (_event, paths: unknown): Promise<string[]> => {
    if (!Array.isArray(paths)) {
      return []
    }

    const directories = paths.filter((value): value is string => {
      if (typeof value !== "string" || value.trim().length === 0) {
        return false
      }
      try {
        return fs.statSync(value).isDirectory()
      } catch {
        return false
      }
    })
    return directories
  })

  ipcMain.handle("power:setWakeLock", async (_event, enabled: boolean): Promise<{ enabled: boolean }> => {
    const next = Boolean(enabled)
    if (next) {
      if (wakeLockId !== null && powerSaveBlocker.isStarted(wakeLockId)) {
        return { enabled: true }
      }
      try {
        wakeLockId = powerSaveBlocker.start("prevent-app-suspension")
      } catch {
        wakeLockId = null
        return { enabled: false }
      }
      return { enabled: true }
    }

    if (wakeLockId !== null) {
      try {
        if (powerSaveBlocker.isStarted(wakeLockId)) {
          powerSaveBlocker.stop(wakeLockId)
        }
      } finally {
        wakeLockId = null
      }
    }
    return { enabled: false }
  })

  ipcMain.handle(
    "media:requestMicrophoneAccess",
    async (): Promise<{ granted: boolean }> => ({ granted: await requestMicrophoneAccess() }),
  )

  ipcMain.handle(
    "remote:openWindow",
    async (
      _event,
      payload: { id: string; name: string; baseUrl: string; skipTlsVerify: boolean },
    ): Promise<{ ok: boolean }> => {
      await options.openRemoteWindow(payload)
      return { ok: true }
    },
  )

  ipcMain.handle(
    "window:get-work-area",
    (event): { x: number; y: number; width: number; height: number } => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return screen.getPrimaryDisplay().workArea
      return screen.getDisplayMatching(win.getBounds()).workArea
    },
  )

  // The app menu bar (File/Edit/View/Window) is a settings toggle; hiding it
  // removes the application menu entirely, showing it restores the template.
  ipcMain.handle("app:set-menu-visible", (_event, visible: boolean): { ok: boolean } => {
    const mainWindow = options.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
    const setter = (mainWindow as BrowserWindow & {
      __saiworkSetMenuVisible?: (visible: boolean) => void
    }).__saiworkSetMenuVisible
    setter?.(Boolean(visible))
    return { ok: true }
  })

  ipcMain.handle(
    "window:snap-to-bounds",
    (event, bounds: { x: number; y: number; width: number; height: number }): { ok: boolean } => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return { ok: false }
      win.setBounds(bounds)
      return { ok: true }
    },
  )

  ipcMain.handle(
    "notifications:show",
    async (_event, payload: { title?: unknown; body?: unknown }): Promise<{ ok: boolean; reason?: string }> => {
      if (!Notification.isSupported()) {
        return { ok: false, reason: "unsupported" }
      }

      const title = typeof payload?.title === "string" ? payload.title : "SaiWork"
      const body = typeof payload?.body === "string" ? payload.body : ""
      try {
        const notification = new Notification({ title, body })
        notification.show()
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  )

}
