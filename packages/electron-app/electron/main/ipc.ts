import { BrowserWindow, Notification, dialog, ipcMain, powerSaveBlocker, screen, type OpenDialogOptions } from "electron"
import fs from "fs"
import { requestMicrophoneAccess } from "./permissions"
import type { CliProcessManager, CliStatus } from "./process-manager"

let wakeLockId: number | null = null

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

export function setupCliIPC(mainWindow: BrowserWindow, cliManager: CliProcessManager) {
  cliManager.on("status", (status: CliStatus) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:status", status)
    }
  })

  cliManager.on("ready", (status: CliStatus) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:ready", status)
    }
  })

  cliManager.on("error", (error: Error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:error", { message: error.message })
    }
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

    const windowTarget = mainWindow.isDestroyed() ? undefined : mainWindow
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
      const opener = (mainWindow as BrowserWindow & {
        __saiworkOpenRemoteWindow?: (payload: {
          id: string
          name: string
          baseUrl: string
          skipTlsVerify: boolean
        }) => Promise<void>
      }).__saiworkOpenRemoteWindow
      if (!opener) {
        throw new Error("Remote window opening is not available")
      }
      await opener(payload)
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

  ipcMain.handle(
    "window:open-session-pane",
    async (
      _event,
      payload: { instanceId: string; sessionId: string },
    ): Promise<{ ok: boolean }> => {
      const opener = (mainWindow as BrowserWindow & {
        __saiworkOpenSessionPane?: (payload: { instanceId: string; sessionId: string }) => Promise<void>
      }).__saiworkOpenSessionPane
      if (!opener) {
        throw new Error("Session pane opening is not available")
      }
      await opener(payload)
      return { ok: true }
    },
  )

  // The app menu bar (File/Edit/View/Window) is a settings toggle; hiding it
  // removes the application menu entirely, showing it restores the template.
  ipcMain.handle("app:set-menu-visible", (_event, visible: boolean): { ok: boolean } => {
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

  // A detached session-pane window asks the main window to re-insert its pane.
  // The main window's renderer owns the pane store, so the request is forwarded
  // to it as a one-way event rather than being handled here.
  ipcMain.handle(
    "window:reattach-session-pane",
    (_event, payload: { instanceId: string; sessionId: string }): { ok: boolean } => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { ok: false }
      }
      mainWindow.webContents.send("saipen:reattach-pane", payload)
      return { ok: true }
    },
  )
}
