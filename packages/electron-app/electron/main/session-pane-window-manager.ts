import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMainInvokeEvent,
  WebContents,
} from "electron"

export interface SessionPaneWindowPayload {
  ownerInstanceId: string
  paneId: string
  instanceId: string
  sessionId: string
}

export interface SessionPaneWindowResult {
  ok: boolean
  reason?: "invalid-payload" | "unauthorized" | "unavailable" | "load-failed"
}

export type SessionPaneWindowNotice = SessionPaneWindowPayload & {
  state: "detached" | "recover"
}

interface IPCRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
}

interface SessionPaneWindowManagerOptions {
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow
  getMainWindow(): BrowserWindow | null
  getBaseUrl(): string | null
  getIconPath(): string
  getPreloadPath(): string
  prepareWindow(window: BrowserWindow): void
  setAllowedOrigin(window: BrowserWindow, url: string): void
  clearAllowedOrigin(window: BrowserWindow): void
  spellcheck: boolean
  reportLoadError(error: unknown): void
}

interface WindowEntry {
  payload: SessionPaneWindowPayload
  window: BrowserWindow
  loaded: boolean
  ready: Promise<SessionPaneWindowResult>
}

function isPayload(value: unknown): value is SessionPaneWindowPayload {
  if (!value || typeof value !== "object") return false
  const payload = value as Record<string, unknown>
  return [payload.ownerInstanceId, payload.paneId, payload.instanceId, payload.sessionId]
    .every((part) => typeof part === "string" && part.length > 0)
}

function entryKey(payload: SessionPaneWindowPayload): string {
  return JSON.stringify([payload.ownerInstanceId, payload.paneId])
}

function samePayload(left: SessionPaneWindowPayload, right: SessionPaneWindowPayload): boolean {
  return left.ownerInstanceId === right.ownerInstanceId
    && left.paneId === right.paneId
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId
}

export class SessionPaneWindowManager {
  private readonly windows = new Map<string, WindowEntry>()
  private readonly pendingRecovery = new Map<string, SessionPaneWindowPayload>()
  private ownerRenderer: WebContents | null = null
  private ipcRegistered = false

  constructor(private readonly options: SessionPaneWindowManagerOptions) {}

  attachMainWindow(window: BrowserWindow): void {
    if (this.ownerRenderer !== window.webContents) this.ownerRenderer = null
    const disconnectRenderer = () => {
      if (this.ownerRenderer === window.webContents) this.ownerRenderer = null
    }
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) disconnectRenderer()
    })
    window.webContents.on("render-process-gone", disconnectRenderer)
    window.webContents.on("destroyed", disconnectRenderer)
  }

  registerIPC(ipcMain: IPCRegistrar): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true

    ipcMain.handle("window:open-session-pane", (event, payload: unknown) => {
      if (!this.isMainRenderer(event)) return { ok: false, reason: "unauthorized" }
      this.ownerRenderer = event.sender
      return this.open(payload)
    })
    ipcMain.handle("window:reattach-session-pane", (event, payload: unknown) => {
      return this.reattach(payload, event.sender, this.isMainRenderer(event))
    })
    ipcMain.handle("window:session-pane-owner-ready", (event) => {
      if (!this.isMainRenderer(event)) return { ok: false, reason: "unauthorized" }
      this.ownerRenderer = event.sender
      for (const entry of this.windows.values()) {
        if (entry.loaded && !entry.window.isDestroyed()) {
          this.sendNotice(event.sender, entry.payload, "detached")
        }
      }
      for (const payload of this.pendingRecovery.values()) {
        this.sendNotice(event.sender, payload, "recover")
      }
      return { ok: true }
    })
    ipcMain.handle("window:session-pane-owner-ack", (event, value: unknown) => {
      if (!this.isMainRenderer(event) || !isPayload(value)) return { ok: false, reason: "unauthorized" }
      const key = entryKey(value)
      const pending = this.pendingRecovery.get(key)
      if (pending && samePayload(pending, value)) this.pendingRecovery.delete(key)
      return { ok: true }
    })
  }

  async open(value: unknown): Promise<SessionPaneWindowResult> {
    if (!isPayload(value)) return { ok: false, reason: "invalid-payload" }
    const payload = value
    const key = entryKey(payload)
    const existing = this.windows.get(key)
    if (existing && !existing.window.isDestroyed()) {
      if (!samePayload(existing.payload, payload)) return { ok: false, reason: "invalid-payload" }
      const result = await existing.ready
      if (result.ok && !existing.window.isDestroyed()) this.focus(existing.window)
      return result
    }
    if (existing) this.windows.delete(key)

    const baseUrl = this.options.getBaseUrl()
    if (!baseUrl) return { ok: false, reason: "unavailable" }

    let targetUrl: URL
    try {
      targetUrl = new URL(baseUrl)
    } catch {
      return { ok: false, reason: "unavailable" }
    }
    targetUrl.searchParams.set("ownerInstance", payload.ownerInstanceId)
    targetUrl.searchParams.set("pane", payload.paneId)
    targetUrl.searchParams.set("instance", payload.instanceId)
    targetUrl.searchParams.set("session", payload.sessionId)

    const window = this.options.createWindow({
      width: 1200,
      height: 800,
      minWidth: 320,
      minHeight: 400,
      backgroundColor: "#342012",
      icon: this.options.getIconPath(),
      webPreferences: {
        preload: this.options.getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: this.options.spellcheck,
        additionalArguments: ["--saiwork-window-context=local-session"],
      },
    })
    this.options.setAllowedOrigin(window, targetUrl.toString())
    this.options.prepareWindow(window)

    const entry: WindowEntry = {
      payload,
      window,
      loaded: false,
      ready: Promise.resolve({ ok: false, reason: "load-failed" }),
    }
    this.windows.set(key, entry)

    window.on("closed", () => {
      this.options.clearAllowedOrigin(window)
      this.recoverEntry(key, entry)
    })
    window.webContents.on("render-process-gone", () => {
      const shouldClose = this.windows.get(key) === entry
      this.recoverEntry(key, entry)
      if (shouldClose && !window.isDestroyed()) window.destroy()
    })

    entry.ready = this.loadEntry(key, entry, targetUrl.toString())
    return entry.ready
  }

  reattach(value: unknown, sender?: WebContents, ownerAuthorized = false): SessionPaneWindowResult {
    if (!isPayload(value)) return { ok: false, reason: "invalid-payload" }
    const key = entryKey(value)
    const entry = this.windows.get(key)
    if (!entry || entry.window.isDestroyed() || !samePayload(entry.payload, value)) {
      return { ok: false, reason: "unavailable" }
    }
    if (sender && sender !== entry.window.webContents && !ownerAuthorized) {
      return { ok: false, reason: "unauthorized" }
    }

    const mainWindow = this.options.getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, reason: "unavailable" }

    entry.window.close()
    return entry.window.isDestroyed() ? { ok: true } : { ok: false, reason: "unavailable" }
  }

  private async loadEntry(key: string, entry: WindowEntry, url: string): Promise<SessionPaneWindowResult> {
    try {
      await entry.window.loadURL(url)
      if (entry.window.isDestroyed() || this.windows.get(key) !== entry) {
        return { ok: false, reason: "load-failed" }
      }
      entry.loaded = true
      this.pendingRecovery.delete(key)
      return { ok: true }
    } catch (error) {
      if (this.windows.get(key) === entry) this.windows.delete(key)
      if (!entry.window.isDestroyed()) entry.window.destroy()
      this.options.reportLoadError(error)
      return { ok: false, reason: "load-failed" }
    }
  }

  private recoverEntry(key: string, entry: WindowEntry): void {
    if (this.windows.get(key) !== entry) return
    this.windows.delete(key)
    if (entry.loaded) this.sendRecovery(entry.payload)
  }

  private sendRecovery(payload: SessionPaneWindowPayload): void {
    this.pendingRecovery.set(entryKey(payload), payload)
    const mainWindow = this.options.getMainWindow()
    if (
      mainWindow
      && !mainWindow.isDestroyed()
      && this.ownerRenderer === mainWindow.webContents
      && !this.ownerRenderer.isDestroyed()
    ) {
      this.sendNotice(this.ownerRenderer, payload, "recover")
      return
    }
  }

  private sendNotice(renderer: WebContents, payload: SessionPaneWindowPayload, state: SessionPaneWindowNotice["state"]): void {
    renderer.send("saipen:session-pane-state", { ...payload, state } satisfies SessionPaneWindowNotice)
  }

  private isMainRenderer(event: IpcMainInvokeEvent): boolean {
    const mainWindow = this.options.getMainWindow()
    return Boolean(
      mainWindow
      && !mainWindow.isDestroyed()
      && event.sender === mainWindow.webContents
      && event.senderFrame === mainWindow.webContents.mainFrame,
    )
  }

  private focus(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
