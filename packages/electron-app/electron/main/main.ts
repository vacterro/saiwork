import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, session, shell, WebContentsView } from "electron"
import http from "node:http"
import https from "node:https"
import { existsSync, mkdirSync, rmSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
import { createApplicationMenu } from "./menu"
import { ClientStateManager } from "./client-state"
import { setupClientStateIPC } from "./client-state-ipc"
import { ClientStateLifecycle } from "./client-state-lifecycle"
import { readyCliUrl, shouldRecreateMainWindow } from "./window-recovery"
import { ClientStateNavigationController } from "./client-state-navigation"
import { setupCliIPC } from "./ipc"
import { SessionPaneWindowManager } from "./session-pane-window-manager"
import { installProcessGuards } from "./main-process-guard"
import { configureMediaPermissionHandlers, isAllowedRendererOrigin } from "./permissions"
import { resolveConfiguredRendererOrigins } from "./renderer-origin"
import { CliProcessManager } from "./process-manager"
import {
  clampWindowBounds,
  createDeferredWindowStateRestorer,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  installWindowZoomInput,
  restoreWindowState,
  WindowStateTracker,
} from "./window-state"

const mainFilename = fileURLToPath(import.meta.url)
const mainDirname = dirname(mainFilename)

const isMac = process.platform === "darwin"

// Register before any window/lifecycle code: suppresses Electron's native
// main-process error dialog and survives benign WebContents teardown races
// ("Object has been destroyed" from Electron's own emit during
// render-process-gone), so a stray teardown throw cannot kill the app.
installProcessGuards()

/**
 * Portable mode: keep every byte SAIWORK writes next to the executable.
 *
 * electron-builder's `portable` target exports PORTABLE_EXECUTABLE_DIR, and a
 * `saiwork-data` folder placed beside any build opts in manually -- so the same
 * binary works both installed and carried on a stick without a flag.
 *
 * Runs before any other path setup: once `userData` has been read, moving it
 * would split state across two locations.
 */
function configurePortableStoragePaths(): boolean {
  // Priority: explicit override, then the portable launcher's own directory,
  // then a `saiwork-data` folder the user dropped next to the executable.
  const explicit = process.env.SAIWORK_DATA_DIR?.trim()
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR?.trim()
  const besideExecutable = join(dirname(process.execPath), "saiwork-data")

  const target =
    explicit ||
    (portableDir ? join(portableDir, "saiwork-data") : null) ||
    (existsSync(besideExecutable) ? besideExecutable : null)

  if (!target) {
    return false
  }

  try {
    const sessionDataPath = join(target, "session-data")
    mkdirSync(target, { recursive: true })
    mkdirSync(sessionDataPath, { recursive: true })

    app.setName("SAIWORK")
    app.setPath("userData", target)
    app.setPath("sessionData", sessionDataPath)
    console.info("[electron-startup] portable storage", target)
    return true
  } catch (error) {
    console.warn("[electron-startup] failed to configure portable storage paths", error)
    return false
  }
}

const isPortableRun = configurePortableStoragePaths()

function configureDevStoragePaths() {
  if (isPortableRun) {
    return
  }

  if (app.isPackaged) {
    return
  }

  const appName = "SaiWork"

  try {
    app.setName(appName)

    const userDataPath = join(app.getPath("appData"), appName)
    const sessionDataPath = join(userDataPath, "session-data")

    mkdirSync(userDataPath, { recursive: true })
    mkdirSync(sessionDataPath, { recursive: true })

    app.setPath("userData", userDataPath)
    app.setPath("sessionData", sessionDataPath)
  } catch (error) {
    console.warn("[cli] failed to configure dev storage paths", error)
  }
}

configureDevStoragePaths()

function configurePackagedStoragePaths() {
  if (!app.isPackaged || isPortableRun) {
    return
  }

  try {
    const sessionDataPath = join(app.getPath("userData"), "session-data-v2")
    mkdirSync(sessionDataPath, { recursive: true })
    app.setPath("sessionData", sessionDataPath)
  } catch (error) {
    console.warn("[electron-startup] failed to configure packaged session data path", error)
  }
}

configurePackagedStoragePaths()

function cleanupPackagedChromiumStorage() {
  if (!app.isPackaged) {
    return
  }

  const roots = [app.getPath("sessionData"), app.getPath("userData"), join(app.getPath("userData"), "session-data")]
  const names = ["Service Worker", "QuotaManager", "QuotaManager-journal"]

  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name)
      if (!existsSync(candidate)) {
        continue
      }

      try {
        rmSync(candidate, { recursive: true, force: true })
        console.info("[electron-startup] removed stale Chromium storage", candidate)
      } catch (error) {
        console.warn("[electron-startup] failed to remove stale Chromium storage", candidate, error)
      }
    }
  }
}

cleanupPackagedChromiumStorage()

const clientStateManager = new ClientStateManager(app.getPath("userData"))
const cliManager = new CliProcessManager()
let mainWindow: BrowserWindow | null = null
let currentCliUrl: string | null = null
let pendingCliUrl: string | null = null
let pendingBootstrapToken: string | null = null
let showingLoadingScreen = false
let preloadingView: WebContentsView | null = null
let mainNavigationController: ClientStateNavigationController | null = null
const remoteWindowOrigins = new Map<number, Set<string>>()
const insecureWindowOrigins = new Map<number, Set<string>>()
const clientStateLifecycle = new ClientStateLifecycle({
  app,
  clientStateManager,
  cliManager,
  getMainWindow: () => mainWindow,
  getAllWindows: () => BrowserWindow.getAllWindows(),
  getAllowedRendererOrigins,
  isTrustedRendererOrigin: isAllowedRendererOrigin,
})
const bindClientStateWindow = setupClientStateIPC(
  ipcMain,
  clientStateManager,
  () => mainWindow,
  getAllowedRendererOrigins,
)
const sessionPaneWindows = new SessionPaneWindowManager({
  createWindow: (options) => new BrowserWindow(options),
  getMainWindow: () => mainWindow,
  getBaseUrl: () => currentCliUrl || readyCliUrl(cliManager.getStatus())
    || process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL || null,
  getIconPath,
  getPreloadPath,
  prepareWindow: (window) => setupNavigationGuards(window),
  setAllowedOrigin: setWindowAllowedOrigin,
  clearAllowedOrigin: clearWindowAllowedOrigin,
  spellcheck: !isMac,
  reportLoadError: (error) => {
    if (!isIgnorableNavigationError(error)) console.error("[cli] failed to load session pane window:", error)
  },
})

if (isMac) {
  app.commandLine.appendSwitch("disable-spell-checking")
}

// Optional external debugging: set SAIWORK_DEBUG_PORT to attach a CDP client
// (e.g. playwright) to the real Electron renderer. Off by default; the browser
// tab and the Electron window are not the same surface, so a hang that only
// reproduces in the window needs a window-level view. The switch must be set
// before the app is ready.
if (process.env.SAIWORK_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.SAIWORK_DEBUG_PORT)
}

function getIconPath() {
  if (app.isPackaged) {
    // On Windows an .ico lets the OS pick a native-size frame so the titlebar
    // and taskbar keep the icon's hard (aliased) edges instead of a smoothed
    // downscale of the PNG. The .ico is shipped via extraResources.
    if (process.platform === "win32") {
      return join(process.resourcesPath, "icon.ico")
    }
    return join(process.resourcesPath, "icon.png")
  }

  if (process.platform === "win32") {
    return join(mainDirname, "../resources/icon.ico")
  }
  return join(mainDirname, "../resources/icon.png")
}

type LoadingTarget =
  | { type: "url"; source: string }
  | { type: "file"; source: string }

function resolveDevLoadingUrl(): string | null {
  if (app.isPackaged) {
    return null
  }
  const devBase = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
  if (!devBase) {
    return null
  }

  try {
    const normalized = devBase.endsWith("/") ? devBase : `${devBase}/`
    return new URL("loading.html", normalized).toString()
  } catch (error) {
    console.warn("[cli] failed to construct dev loading URL", devBase, error)
    return null
  }
}

function resolveLoadingTarget(): LoadingTarget {
  const devUrl = resolveDevLoadingUrl()
  if (devUrl) {
    return { type: "url", source: devUrl }
  }
  const filePath = resolveLoadingFilePath()
  return { type: "file", source: filePath }
}

function resolveLoadingFilePath() {
  const candidates = [
    join(app.getAppPath(), "dist/renderer/loading.html"),
    join(process.resourcesPath, "dist/renderer/loading.html"),
    join(mainDirname, "../dist/renderer/loading.html"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return join(app.getAppPath(), "dist/renderer/loading.html")
}

async function loadLoadingScreen(window: BrowserWindow): Promise<boolean> {
  const target = resolveLoadingTarget()
  try {
    await (target.type === "url" ? window.loadURL(target.source) : window.loadFile(target.source))
    return true
  } catch (error) {
    if (isIgnorableNavigationError(error)) {
      return false
    }
    console.error("[cli] failed to load loading screen:", error)
    return false
  }
}

function isIgnorableNavigationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : ""
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : ""
  return code === "ERR_ABORTED" || code === "ERR_FAILED" || message.includes("ERR_ABORTED") || message.includes("ERR_FAILED")
}

function getAllowedRendererOrigins(window?: BrowserWindow | null): string[] {
  const origins = new Set<string>()
  if (window) {
    for (const origin of remoteWindowOrigins.get(window.id) ?? []) {
      origins.add(origin)
    }
  }
  for (const origin of resolveConfiguredRendererOrigins(currentCliUrl, app.isPackaged, [
    process.env.VITE_DEV_SERVER_URL,
    process.env.ELECTRON_RENDERER_URL,
  ])) {
    origins.add(origin)
  }
  return Array.from(origins)
}

export type NavigationTargetClassification = "internal" | "externalAllowed" | "blocked"
export { classifyNavigationTarget } from "./navigation-policy"
import { classifyNavigationTarget } from "./navigation-policy"

function shouldOpenExternally(url: string, window?: BrowserWindow | null): boolean {
  const classification = classifyNavigationTarget(url, getAllowedRendererOrigins(window))
  return classification === "externalAllowed"
}

function setupNavigationGuards(window: BrowserWindow, navigationController?: ClientStateNavigationController) {
  const handleExternal = (url: string) => {
    shell.openExternal(url).catch((error) => console.error("[cli] failed to open external URL", url, error))
  }

  // ALL raw window.open calls are denied: an internal target navigates the
  // existing surface, an external target opens the OS browser only, and a
  // blocked scheme launches nothing. Chromium never invents an unmanaged
  // BrowserWindow behind SAIWORK's back.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const classification = classifyNavigationTarget(url, getAllowedRendererOrigins(window))
    if (classification === "externalAllowed") {
      handleExternal(url)
    }
    return { action: "deny" }
  })

  window.webContents.on("will-navigate", (event, url) => {
    const classification = classifyNavigationTarget(url, getAllowedRendererOrigins(window))
    if (classification === "blocked") {
      event.preventDefault()
      return
    }
    if (classification === "externalAllowed") {
      event.preventDefault()
      handleExternal(url)
    } else if (navigationController) {
      event.preventDefault()
      void navigationController.navigate((target) => target.loadURL(url)).catch((error) => {
        if (!isIgnorableNavigationError(error)) {
          console.error("[client-state] trusted renderer navigation failed", error)
        }
      })
    }
  })

  window.webContents.on("will-redirect", (event, url) => {
    const classification = classifyNavigationTarget(url, getAllowedRendererOrigins(window))
    if (classification === "externalAllowed") {
      event.preventDefault()
      handleExternal(url)
    } else if (classification === "blocked") {
      event.preventDefault()
    }
  })
}

function setWindowAllowedOrigin(window: BrowserWindow, url: string) {
  try {
    const origin = new URL(url).origin
    remoteWindowOrigins.set(window.id, new Set([origin]))
  } catch (error) {
    console.warn("[cli] failed to store allowed origin", url, error)
  }
}

function stageWindowAllowedOrigin(window: BrowserWindow, url: string): () => void {
  const previous = remoteWindowOrigins.get(window.id)
  try {
    const origins = new Set(previous)
    origins.add(new URL(url).origin)
    remoteWindowOrigins.set(window.id, origins)
  } catch (error) {
    console.warn("[cli] failed to stage allowed origin", url, error)
  }
  return () => {
    if (previous) remoteWindowOrigins.set(window.id, previous)
    else remoteWindowOrigins.delete(window.id)
  }
}

function clearWindowAllowedOrigin(window: BrowserWindow) {
  remoteWindowOrigins.delete(window.id)
}

function addWindowInsecureOrigin(window: BrowserWindow, url: string) {
  try {
    const origin = new URL(url).origin
    insecureWindowOrigins.set(window.id, new Set([origin]))
  } catch (error) {
    console.warn("[cli] failed to store insecure origin", url, error)
  }
}

function clearWindowInsecureOrigin(window: BrowserWindow) {
  insecureWindowOrigins.delete(window.id)
}

function isInsecureOriginAllowed(url: string) {
  try {
    const targetOrigin = new URL(url).origin
    for (const origins of insecureWindowOrigins.values()) {
      if (origins.has(targetOrigin)) {
        return true
      }
    }
  } catch {
    return false
  }

  return false
}

let cachedPreloadPath: string | null = null
function getPreloadPath() {
  if (cachedPreloadPath && existsSync(cachedPreloadPath)) {
    return cachedPreloadPath
  }

  const candidates = [
    join(process.resourcesPath, "preload/index.js"),
    join(mainDirname, "../preload/index.js"),
    join(mainDirname, "../preload/index.cjs"),
    join(mainDirname, "../../preload/index.cjs"),
    join(mainDirname, "../../electron/preload/index.cjs"),
    join(app.getAppPath(), "preload/index.cjs"),
    join(app.getAppPath(), "electron/preload/index.cjs"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedPreloadPath = candidate
      return candidate
    }
  }

  return join(mainDirname, "../preload/index.js")
}

function destroyPreloadingView(target?: WebContentsView | null) {
  const view = target ?? preloadingView
  if (!view) {
    return
  }

  try {
    const contents = view.webContents as any
    contents?.destroy?.()
  } catch (error) {
    console.warn("[cli] failed to destroy preloading view", error)
  }

  if (!target || view === preloadingView) {
    preloadingView = null
  }
}

function createWindow() {
  // Vintage Golden --background. There is no second palette to branch on.
  const backgroundColor = "#342012"
  const iconPath = getIconPath()
  const savedWindowState = clientStateManager.getWindowState()
  const restoredBounds = savedWindowState
    ? clampWindowBounds(
        savedWindowState.bounds,
        screen.getAllDisplays().map((display) => display.workArea),
      )
    : undefined

  const reconnectCliUrl = readyCliUrl(cliManager.getStatus())
  mainWindow = new BrowserWindow({
    width: restoredBounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: restoredBounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    useContentSize: true,
    ...(restoredBounds ? { x: restoredBounds.x, y: restoredBounds.y } : {}),
    minWidth: 320,
    minHeight: 600,
    backgroundColor,
    icon: iconPath,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      ...(savedWindowState ? { zoomFactor: savedWindowState.zoomFactor } : {}),
      spellcheck: !isMac,
      additionalArguments: ["--saiwork-window-context=local"],
    },
  })

  const window = mainWindow
  sessionPaneWindows.attachMainWindow(window)
  const navigationController = new ClientStateNavigationController(
    window,
    {
      clientStateManager,
      isTrustedOrigin: (url) => isAllowedRendererOrigin(url, getAllowedRendererOrigins(window)),
      reportFlushError: (error) => {
        console.warn("[client-state] renderer pre-navigation flush failed; continuing navigation", error)
      },
    },
  )
  mainNavigationController = navigationController

  let windowStateTracker: WindowStateTracker | null = null
  const restoreDeferredWindowState = clientStateManager.isPrimary
    ? null
    : createDeferredWindowStateRestorer(window)
  const initializeWindowState = () => {
    if (window.isDestroyed() || clientStateLifecycle.isShuttingDown || !clientStateManager.isPrimary) {
      restoreDeferredWindowState?.dispose()
      return
    }
    const readyWindowState = clientStateManager.getWindowState()
    const readyBounds = readyWindowState
      ? clampWindowBounds(
          readyWindowState.bounds,
          screen.getAllDisplays().map((display) => display.workArea),
        )
      : undefined
    const deferred = restoreDeferredWindowState?.restore(readyWindowState, readyBounds)
    if (!deferred) restoreWindowState(window, readyWindowState, readyBounds)
    const trackerInitialState = deferred ? deferred.initialState : readyWindowState
    windowStateTracker = new WindowStateTracker(window, clientStateManager, trackerInitialState)
    clientStateLifecycle.updateMainWindowTracker(window, windowStateTracker)
    if (deferred?.preserveCurrent) {
      void windowStateTracker.flush().catch((error) => {
        console.warn("[client-state] failed to persist pre-ownership window changes", error)
      })
    }
  }
  if (clientStateManager.isPrimary) initializeWindowState()
  else void clientStateManager.whenReady().then(initializeWindowState).catch((error) => {
    restoreDeferredWindowState?.dispose()
    console.warn("[client-state] failed to initialize window state", error)
  })
  installWindowZoomInput(window, (level) => {
    if (windowStateTracker) windowStateTracker.setZoomLevel(level)
    else window.webContents.setZoomLevel(level)
  })

  setupNavigationGuards(window, navigationController)

  if (isMac) {
    window.webContents.session.setSpellCheckerEnabled(false)
  }

  showingLoadingScreen = true
  currentCliUrl = null
  clearWindowAllowedOrigin(window)
  void loadLoadingScreen(window).then(() => {
    if (
      mainWindow === window
      && reconnectCliUrl
      && currentCliUrl !== reconnectCliUrl
      && pendingCliUrl !== reconnectCliUrl
    ) {
      startCliPreload(reconnectCliUrl)
    }
  })

  // DevTools stay shut unless asked for. Upstream popped a detached window on
  // every dev start, which steals focus and covers the app you are trying to
  // look at. The menu's toggle and F12 still open it on demand.
  if (process.env.NODE_ENV === "development" && process.env.SAIWORK_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" })
  }

  createApplicationMenu(window, {
    reload: () => {
      void navigationController.navigate((target) => target.webContents.reload())
    },
    forceReload: () => {
      void navigationController.navigate((target) => target.webContents.reloadIgnoringCache())
    },
  })
  // Settings toggle for the menu bar: hiding removes the application menu
  // (per-window setMenu(null) is what actually clears the bar on Windows),
  // showing rebuilds the real template.
  ;(window as BrowserWindow & { __saiworkSetMenuVisible?: (visible: boolean) => void }).__saiworkSetMenuVisible = (visible: boolean) => {
    if (visible) {
      window.setAutoHideMenuBar(false)
      window.setMenuBarVisibility(true)
      createApplicationMenu(window, {
        reload: () => {
          void navigationController.navigate((target) => target.webContents.reload())
        },
        forceReload: () => {
          void navigationController.navigate((target) => target.webContents.reloadIgnoringCache())
        },
      })
    } else {
      // Every Windows knob at once: without auto-hide the bar comes back on
      // Alt, without removeMenu the existing menu survives setApplicationMenu.
      window.setAutoHideMenuBar(true)
      window.setMenuBarVisibility(false)
      window.removeMenu()
      Menu.setApplicationMenu(null)
    }
  }
  bindClientStateWindow(window)
  clientStateLifecycle.attachMainWindow(window, windowStateTracker)

  window.on("closed", () => {
    destroyPreloadingView()
    clearWindowAllowedOrigin(window)
    clearWindowInsecureOrigin(window)
    mainWindow = null
    if (mainNavigationController === navigationController) mainNavigationController = null
    currentCliUrl = null
    pendingCliUrl = null
    showingLoadingScreen = false
    clientStateLifecycle.detachMainWindow(window)
  })

  if (pendingCliUrl) {
    const url = pendingCliUrl
    pendingCliUrl = null
    startCliPreload(url)
  }
}

function showLoadingScreen(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  if (showingLoadingScreen && !force) {
    return
  }

  const window = mainWindow
  const wasShowingLoadingScreen = showingLoadingScreen
  showingLoadingScreen = true
  destroyPreloadingView()
  pendingCliUrl = null
  void mainNavigationController?.navigate(async (target) => {
    if (!(await loadLoadingScreen(target))) {
      showingLoadingScreen = wasShowingLoadingScreen
      return
    }
    currentCliUrl = null
    clearWindowAllowedOrigin(target)
  })
}

function isBootstrapTokenUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname === "/auth/token" && parsed.hash.length > 1
  } catch {
    return false
  }
}

function startCliPreload(url: string) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingCliUrl = url
    return
  }

  if (currentCliUrl === url && !showingLoadingScreen) {
    return
  }

  pendingCliUrl = url
  destroyPreloadingView()

  if (!showingLoadingScreen) {
    showLoadingScreen(true)
  }

  // Important: /auth/token#... is one-time. Preloading + swapping would load it twice,
  // consuming the token in the hidden view and then failing in the main window.
  if (isBootstrapTokenUrl(url)) {
    finalizeCliSwap(url)
    return
  }

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: !isMac,
    },
  })

  preloadingView = view

  view.webContents.once("did-finish-load", () => {
    if (preloadingView !== view) {
      destroyPreloadingView(view)
      return
    }
    finalizeCliSwap(url)
  })

  view.webContents.loadURL(url).catch((error) => {
    if (isIgnorableNavigationError(error)) {
      return
    }
    console.error("[cli] failed to preload CLI view:", error)
    if (preloadingView === view) {
      destroyPreloadingView(view)
    }
  })
}

function finalizeCliSwap(url: string) {
  destroyPreloadingView()

  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingCliUrl = url
    return
  }

  const navigate = async (target: BrowserWindow) => {
    const rollbackOrigin = stageWindowAllowedOrigin(target, url)
    try {
      await target.loadURL(url)
    } catch (error) {
      rollbackOrigin()
      throw error
    }
    showingLoadingScreen = false
    currentCliUrl = url
    setWindowAllowedOrigin(target, url)
    pendingCliUrl = null
  }
  void mainNavigationController?.navigate(navigate).then(() => {
    if (cliManager.getStatus().state !== "ready") showLoadingScreen()
  }).catch((error) => {
    if (!isIgnorableNavigationError(error)) console.error("[cli] failed to load CLI view:", error)
  })
}

function buildRemoteWindowTitle(name: string, baseUrl: string) {
  return `${name} - ${baseUrl}`
}

function lockWindowTitle(window: BrowserWindow, title: string) {
  window.setTitle(title)
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault()
    window.setTitle(title)
  })
}

function buildRemoteErrorHtml(name: string, baseUrl: string, message: string) {
  const escapedName = name.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char))
  const escapedUrl = baseUrl.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char))
  const escapedMessage = message.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char))
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${escapedName}</title><style>body{margin:0;background:#111827;color:#f9fafb;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}main{max-width:560px;width:100%;background:rgba(17,24,39,.88);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:28px;box-shadow:0 25px 60px rgba(0,0,0,.45)}h1{margin:0 0 10px;font-size:1.5rem}p{margin:0 0 10px;color:#cbd5e1;line-height:1.5}code{display:block;margin-top:16px;padding:12px 14px;border-radius:12px;background:#0f172a;color:#bfdbfe;overflow:auto}</style></head><body><main><h1>${escapedName}</h1><p>Could not connect to the remote server.</p><p>${escapedMessage}</p><code>${escapedUrl}</code></main></body></html>`
}

async function openRemoteWindow(payload: { id: string; name: string; baseUrl: string; skipTlsVerify: boolean }) {
  const targetUrl = new URL(payload.baseUrl)
  const title = buildRemoteWindowTitle(payload.name, payload.baseUrl)
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 320,
    minHeight: 600,
    backgroundColor: "#342012",
    icon: getIconPath(),
    title,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: !isMac,
      additionalArguments: ["--saiwork-window-context=remote"],
    },
  })
  lockWindowTitle(window, title)

  setWindowAllowedOrigin(window, targetUrl.toString())
  if (payload.skipTlsVerify) {
    addWindowInsecureOrigin(window, targetUrl.toString())
  }

  setupNavigationGuards(window)
  window.on("closed", () => {
    clearWindowAllowedOrigin(window)
    clearWindowInsecureOrigin(window)
  })

  try {
    await window.loadURL(targetUrl.toString())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildRemoteErrorHtml(payload.name, payload.baseUrl, message))}`)
  }
}

let bootstrapExchangeInFlight = false

function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
  if (!raw) return null

  const first = raw.split(";")[0] ?? ""
  const index = first.indexOf("=")
  if (index < 0) return null

  const key = first.slice(0, index).trim()
  const value = first.slice(index + 1).trim()
  if (key !== name || !value) return null

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function exchangeBootstrapToken(baseUrl: string, token: string): Promise<boolean> {
  const sessionCookieName = cliManager.getAuthCookieName()
  const target = new URL("/api/auth/token", baseUrl)
  const body = JSON.stringify({ token })

  const transport = target.protocol === "https:" ? https : http

  const result = await new Promise<{ statusCode: number; setCookie: string | string[] | undefined }>((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume()
        resolve({ statusCode: res.statusCode ?? 0, setCookie: res.headers["set-cookie"] })
      },
    )

    req.on("error", reject)
    req.write(body)
    req.end()
  })

  if (result.statusCode !== 200) {
    return false
  }

  const sessionId = extractCookieValue(result.setCookie, sessionCookieName)
  if (!sessionId) {
    return false
  }

  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: sessionCookieName,
    value: sessionId,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
  })

  return true
}

async function startCli() {
  try {
    // In desktop dev workflows we always want the CLI to run in dev mode so it:
    // - uses plain HTTP
    // - proxies UI requests to the renderer dev server
    // Monaco's AMD assets are served from that dev server.
    const devMode = !app.isPackaged
    console.info("[cli] start requested (dev mode:", devMode, ")")
    await cliManager.start({ dev: devMode })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[cli] start failed:", message)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("cli:error", { message })
    }
  }
}

async function maybeExchangeAndNavigate(baseUrl: string) {
  if (bootstrapExchangeInFlight) {
    return
  }

  const token = pendingBootstrapToken
  if (!token) {
    startCliPreload(baseUrl)
    return
  }

  bootstrapExchangeInFlight = true

  try {
    const ok = await exchangeBootstrapToken(baseUrl, token)
    pendingBootstrapToken = null

    if (!ok) {
      startCliPreload(`${baseUrl}/login`)
      return
    }

    startCliPreload(baseUrl)
  } catch (error) {
    console.error("[cli] bootstrap token exchange failed:", error)
    pendingBootstrapToken = null
    startCliPreload(`${baseUrl}/login`)
  } finally {
    bootstrapExchangeInFlight = false
  }
}

cliManager.on("bootstrapToken", (token) => {
  pendingBootstrapToken = token

  const status = cliManager.getStatus()
  if (status.url) {
    void maybeExchangeAndNavigate(status.url)
  }
})

cliManager.on("ready", (status) => {
  if (!status.url) {
    return
  }

  void maybeExchangeAndNavigate(status.url)
})

cliManager.on("status", (status) => {
  if (status.state !== "ready") {
    showLoadingScreen()
  }
})

if (isMac) {
  app.on("web-contents-created", (_, contents) => {
    contents.session.setSpellCheckerEnabled(false)
  })
}

app.whenReady().then(() => {
  // Required for Windows notifications / taskbar grouping.
  // Keep in sync with desktop app identifier.
  try {
    app.setAppUserModelId("ai.saipen.saiwork.client")
  } catch {
    // ignore
  }

  setupCliIPC(cliManager, { getMainWindow: () => mainWindow, openRemoteWindow })
  sessionPaneWindows.registerIPC(ipcMain)
  startCli()

  if (isMac) {
    session.defaultSession.setSpellCheckerEnabled(false)
    configureMediaPermissionHandlers(getAllowedRendererOrigins)
    app.on("browser-window-created", (_, window) => {
      window.webContents.session.setSpellCheckerEnabled(false)
    })

    if (app.dock) {
      const dockIcon = nativeImage.createFromPath(getIconPath())
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon)
      }
    }
  }

  createWindow()

  app.on("certificate-error", (event, _webContents, url, error, _certificate, callback) => {
    if (isInsecureOriginAllowed(url)) {
      event.preventDefault()
      console.warn("[cli] allowing insecure remote certificate for", url, error)
      callback(true)
      return
    }
    callback(false)
  })

  app.on("activate", () => {
    // Recreate the main window even when detached session windows survive:
    // otherwise closing the main surface while a detached pane stays open
    // leaves the user with no way back to it. T-083.
    if (shouldRecreateMainWindow(mainWindow)) {
      createWindow()
    }
  })
})

clientStateLifecycle.registerAppEvents()
