import assert from "node:assert/strict"
import test from "node:test"
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMainInvokeEvent } from "electron"
import { SessionPaneWindowManager, type SessionPaneWindowNotice, type SessionPaneWindowPayload } from "./session-pane-window-manager"

const payload: SessionPaneWindowPayload = {
  ownerInstanceId: "host-1",
  paneId: "pane-2",
  instanceId: "session-instance-1",
  sessionId: "session-1",
}

function harness() {
  const calls: string[] = []
  const windows: FakeWindow[] = []
  const mainListeners = new Map<string, (...args: any[]) => void>()
  const mainContents = {
    mainFrame: {},
    isDestroyed: () => false,
    on: (event: string, listener: (...args: any[]) => void) => mainListeners.set(event, listener),
    send: (channel: string, value: SessionPaneWindowNotice) => calls.push(`send:${channel}:${value.state}:${value.paneId}`),
  }
  const mainWindow = { isDestroyed: () => false, webContents: mainContents }
  let currentMain: typeof mainWindow | null = mainWindow
  let rejectLoad = false

  class FakeWindow {
    destroyed = false
    minimized = false
    listeners = new Map<string, () => void>()
    contentsListeners = new Map<string, () => void>()
    webContents = {
      on: (event: string, listener: () => void) => this.contentsListeners.set(event, listener),
    }
    on(event: string, listener: () => void) { this.listeners.set(event, listener) }
    async loadURL(url: string) {
      calls.push(`load:${url}`)
      if (rejectLoad) throw new Error("load failed")
    }
    isDestroyed() { return this.destroyed }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false; calls.push("restore") }
    show() { calls.push("show") }
    focus() { calls.push("focus") }
    close() { calls.push("close"); this.destroyed = true; this.listeners.get("closed")?.() }
    destroy() { calls.push("destroy"); this.destroyed = true; this.listeners.get("closed")?.() }
  }

  const manager = new SessionPaneWindowManager({
    createWindow: (_options: BrowserWindowConstructorOptions) => {
      const window = new FakeWindow()
      windows.push(window)
      return window as unknown as BrowserWindow
    },
    getMainWindow: () => currentMain as unknown as BrowserWindow | null,
    getBaseUrl: () => "http://127.0.0.1:3000/app?keep=yes",
    getIconPath: () => "icon.png",
    getPreloadPath: () => "preload.cjs",
    prepareWindow: () => calls.push("prepare"),
    setAllowedOrigin: () => calls.push("allow-origin"),
    clearAllowedOrigin: () => calls.push("clear-origin"),
    spellcheck: false,
    reportLoadError: () => calls.push("load-error"),
  })
  manager.attachMainWindow(mainWindow as unknown as BrowserWindow)
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => unknown>()
  const registrar = { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => handlers.set(channel, listener) }
  manager.registerIPC(registrar)
  const ownerEvent = { sender: mainContents, senderFrame: mainContents.mainFrame } as unknown as IpcMainInvokeEvent
  return {
    calls,
    handlers,
    mainContents,
    mainListeners,
    manager,
    ownerEvent,
    readyOwner: () => handlers.get("window:session-pane-owner-ready")!(ownerEvent),
    ackOwner: () => handlers.get("window:session-pane-owner-ack")!(ownerEvent, payload),
    setCurrentMain: (value: typeof mainWindow | null) => { currentMain = value },
    setRejectLoad: (value: boolean) => { rejectLoad = value },
    windows,
  }
}

test("duplicate detach focuses one loaded child and preserves complete route identity", async () => {
  const h = harness()
  assert.deepEqual(await h.manager.open(payload), { ok: true })
  assert.deepEqual(await h.manager.open(payload), { ok: true })
  assert.equal(h.windows.length, 1)
  assert.match(h.calls.find((call) => call.startsWith("load:"))!, /ownerInstance=host-1/)
  assert.match(h.calls.find((call) => call.startsWith("load:"))!, /pane=pane-2/)
  assert.match(h.calls.find((call) => call.startsWith("load:"))!, /instance=session-instance-1/)
  assert.match(h.calls.find((call) => call.startsWith("load:"))!, /session=session-1/)
  assert.deepEqual(h.calls.slice(-2), ["show", "focus"])
})

test("load failure removes child ownership and returns failure", async () => {
  const h = harness()
  h.setRejectLoad(true)
  assert.deepEqual(await h.manager.open(payload), { ok: false, reason: "load-failed" })
  assert.equal(h.calls.includes("destroy"), true)
  assert.deepEqual(h.calls.slice(-2), ["clear-origin", "load-error"])
  h.setRejectLoad(false)
  assert.deepEqual(await h.manager.open(payload), { ok: true })
  assert.equal(h.windows.length, 2)
})

test("close and renderer crash each notify exact pane once", async () => {
  const h = harness()
  h.readyOwner()
  await h.manager.open(payload)
  h.windows[0].listeners.get("closed")?.()
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:recover:pane-2").length, 1)

  await h.manager.open(payload)
  h.windows[1].contentsListeners.get("render-process-gone")?.()
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:recover:pane-2").length, 2)
  // The destroy is deferred out of Electron's event dispatch (teardown race
  // guard), so it lands on the next tick.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.calls.filter((call) => call === "destroy").length, 1)
})

test("reattach rejects wrong child, closes exact child, and notifies owner", async () => {
  const h = harness()
  h.readyOwner()
  await h.manager.open(payload)
  assert.deepEqual(h.manager.reattach(payload, {} as never), { ok: false, reason: "unauthorized" })
  assert.deepEqual(h.manager.reattach(payload, h.windows[0].webContents as never), { ok: true })
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:recover:pane-2").length, 1)
  assert.equal(h.calls.filter((call) => call === "close").length, 1)
})

test("validated main owner can roll back an exact loaded child", async () => {
  const h = harness()
  h.readyOwner()
  await h.manager.open(payload)
  assert.deepEqual(h.handlers.get("window:reattach-session-pane")!(h.ownerEvent, payload), { ok: true })
  assert.equal(h.calls.filter((call) => call === "close").length, 1)
})

test("recovered main renderer receives recovery queued while main was absent", async () => {
  const h = harness()
  await h.manager.open(payload)
  h.setCurrentMain(null)
  h.windows[0].listeners.get("closed")?.()
  assert.equal(h.calls.some((call) => call.startsWith("send:")), false)

  h.setCurrentMain({ isDestroyed: () => false, webContents: h.mainContents })
  h.manager.registerIPC({ handle: () => assert.fail("IPC registered twice") })
  assert.equal(h.handlers.size, 4, "IPC registration is idempotent")
  assert.deepEqual(h.readyOwner(), { ok: true })
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:recover:pane-2").length, 1)
  h.readyOwner()
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:recover:pane-2").length, 2)
  assert.deepEqual(h.ackOwner(), { ok: true })
  h.readyOwner()
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:recover:pane-2").length, 2)
})

test("main navigation queues child recovery until replacement renderer is ready", async () => {
  const h = harness()
  h.readyOwner()
  await h.manager.open(payload)
  h.mainListeners.get("did-start-navigation")?.({}, "http://127.0.0.1:3000", false, true)
  h.windows[0].listeners.get("closed")?.()
  assert.equal(h.calls.some((call) => call.startsWith("send:")), false)
  h.readyOwner()
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:recover:pane-2").length, 1)
})

test("recreated main receives ownership for a surviving detached child", async () => {
  const h = harness()
  await h.manager.open(payload)
  h.readyOwner()
  assert.equal(h.calls.filter((call) => call === "send:saipen:session-pane-state:detached:pane-2").length, 1)
})
