const { contextBridge, ipcRenderer, webUtils } = require("electron")

function resolveWindowContext() {
  const prefix = "--saiwork-window-context="
  const arg = process.argv.find((value) => typeof value === "string" && value.startsWith(prefix))
  const context = arg ? arg.slice(prefix.length) : "local"
  // Preserve "local-session" so the renderer knows it is a detached session
  // pane window; anything else collapses to the local/remote split.
  return context === "local-session" || context === "remote" ? context : "local"
}

function resolveRuntimeHost(windowContext) {
  return "electron"
}

const windowContext = resolveWindowContext()

const localElectronAPI = {
  onCliStatus: (callback) => {
    ipcRenderer.on("cli:status", (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners("cli:status")
  },
  onCliError: (callback) => {
    ipcRenderer.on("cli:error", (_, data) => callback(data))
    return () => ipcRenderer.removeAllListeners("cli:error")
  },
  getCliStatus: () => ipcRenderer.invoke("cli:getStatus"),
  restartCli: () => ipcRenderer.invoke("cli:restart"),
  openDialog: (options) => ipcRenderer.invoke("dialog:open", options),
  getDirectoryPaths: (paths) => ipcRenderer.invoke("filesystem:getDirectoryPaths", paths),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },
  requestMicrophoneAccess: () => ipcRenderer.invoke("media:requestMicrophoneAccess"),
  setWakeLock: (enabled) => ipcRenderer.invoke("power:setWakeLock", Boolean(enabled)),
  showNotification: (payload) => ipcRenderer.invoke("notifications:show", payload),
  openRemoteWindow: (payload) => ipcRenderer.invoke("remote:openWindow", payload),
  getWorkArea: () => ipcRenderer.invoke("window:get-work-area"),
  snapWindowToBounds: (bounds) => ipcRenderer.invoke("window:snap-to-bounds", bounds),
  openSessionPane: (payload) => ipcRenderer.invoke("window:open-session-pane", payload),
  reattachSessionPane: (payload) => ipcRenderer.invoke("window:reattach-session-pane", payload),
  sessionPaneOwnerReady: () => ipcRenderer.invoke("window:session-pane-owner-ready"),
  sessionPaneOwnerAck: (payload) => ipcRenderer.invoke("window:session-pane-owner-ack", payload),
  onSessionPaneState: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on("saipen:session-pane-state", listener)
    return () => ipcRenderer.removeListener("saipen:session-pane-state", listener)
  },
  setMenuVisible: (visible) => ipcRenderer.invoke("app:set-menu-visible", Boolean(visible)),
  claimClientStateAccess: (token) => ipcRenderer.invoke("client-state:claimAccess", token),
  loadClientState: (token) => ipcRenderer.invoke("client-state:load", token),
  saveClientState: (token, snapshot) => ipcRenderer.invoke("client-state:save", token, snapshot),
  setClientStateRestoreEnabled: (token, enabled) =>
    ipcRenderer.invoke("client-state:setRestoreEnabled", token, Boolean(enabled)),
  clearClientState: (token) => ipcRenderer.invoke("client-state:clear", token),
}

const remoteElectronAPI = {
  requestMicrophoneAccess: localElectronAPI.requestMicrophoneAccess,
  setWakeLock: localElectronAPI.setWakeLock,
  showNotification: localElectronAPI.showNotification,
}

contextBridge.exposeInMainWorld(
  "electronAPI",
  windowContext === "remote" ? remoteElectronAPI : localElectronAPI,
)
contextBridge.exposeInMainWorld("__SAIWORK_WINDOW_CONTEXT__", windowContext)
contextBridge.exposeInMainWorld("__SAIWORK_RUNTIME_HOST__", resolveRuntimeHost(windowContext))
