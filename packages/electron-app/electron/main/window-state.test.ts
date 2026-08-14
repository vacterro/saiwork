import assert from "node:assert/strict"
import test from "node:test"
import { clampWindowBounds, createDeferredWindowStateRestorer, installWindowZoomInput, normalizeNativeWindowState, normalizeZoomFactor, restoreWindowState, WindowStateTracker } from "./window-state"
import type { BrowserWindow } from "electron"
import type { ClientStateManager } from "./client-state"

const primaryDisplay = { x: 0, y: 0, width: 1920, height: 1080 }

test("normalizes persisted window state", () => {
  assert.equal(normalizeNativeWindowState({ bounds: { x: 0, y: 0, width: Number.NaN, height: 900 }, maximized: false, fullscreen: false, zoomFactor: 1 }), undefined)
  assert.deepEqual(clampWindowBounds({ x: 4000, y: 2000, width: 1400, height: 900 }, [primaryDisplay]), { x: 520, y: 180, width: 1400, height: 900 })
  assert.deepEqual(
    clampWindowBounds({ x: -2000, y: 100, width: 3000, height: 300 }, [{ x: -1280, y: 0, width: 1280, height: 1024 }, primaryDisplay]),
    { x: -1280, y: 100, width: 1280, height: 600 },
  )
})

test("normalizes unsafe zoom factors", () => {
  assert.equal(normalizeZoomFactor(Number.POSITIVE_INFINITY), 1)
  assert.equal(normalizeZoomFactor(0.01), 0.25)
  assert.equal(normalizeZoomFactor(9), 5)
})

test("restores shared outer position and content size", () => {
  const calls: unknown[] = []
  const window = {
    setPosition: (x: number, y: number) => calls.push(["position", x, y]),
    setContentSize: (width: number, height: number) => calls.push(["content", width, height]),
    maximize: () => undefined,
    setFullScreen: () => undefined,
    webContents: { setZoomFactor: () => undefined },
  } as unknown as BrowserWindow
  const bounds = { x: 10, y: 20, width: 1200, height: 800 }
  restoreWindowState(window, { bounds, maximized: false, fullscreen: false, zoomFactor: 1 }, bounds)
  assert.deepEqual(calls, [["position", 10, 20], ["content", 1200, 800]])
})

test("deferred ownership never overwrites window state changed by the user", () => {
  const events = new Map<string, () => void>()
  const calls: unknown[] = []
  const removed: string[] = []
  let maximized = false
  const window = {
    on: (name: string, handler: () => void) => events.set(name, handler),
    removeListener: (name: string, handler: () => void) => {
      if (events.get(name) === handler) events.delete(name)
      removed.push(name)
    },
    setPosition: (x: number, y: number) => calls.push(["position", x, y]),
    setContentSize: (width: number, height: number) => calls.push(["content", width, height]),
    maximize: () => calls.push(["maximize"]),
    setFullScreen: (value: boolean) => calls.push(["fullscreen", value]),
    getPosition: () => [100, 200],
    getContentSize: () => [900, 700],
    isMaximized: () => maximized,
    isFullScreen: () => false,
    webContents: {
      on: (name: string, handler: () => void) => events.set(name, handler),
      removeListener: (name: string, handler: () => void) => {
        if (events.get(name) === handler) events.delete(name)
        removed.push(name)
      },
      setZoomFactor: (value: number) => calls.push(["zoom", value]),
      getZoomFactor: () => 1.2,
    },
  } as unknown as BrowserWindow
  const restore = createDeferredWindowStateRestorer(window)
  const bounds = { x: 10, y: 20, width: 1200, height: 800 }
  const state = { bounds, maximized: false, fullscreen: false, zoomFactor: 1 }

  events.get("move")?.()
  maximized = true
  events.get("maximize")?.()
  const result = restore.restore(state, bounds)
  assert.equal(result.preserveCurrent, true)
  assert.deepEqual(result.initialState, {
    bounds: { x: 100, y: 200, width: 900, height: 700 },
    maximized: true,
    fullscreen: false,
    zoomFactor: 1.2,
  })
  assert.deepEqual(calls, [])
  assert.equal(events.size, 0)
  assert.deepEqual(removed.sort(), [
    "enter-full-screen",
    "leave-full-screen",
    "maximize",
    "move",
    "resize",
    "unmaximize",
    "zoom-changed",
  ])
})

test("deferred ownership listeners can be disposed when ownership is unavailable", () => {
  const events = new Map<string, () => void>()
  const window = {
    on: (name: string, handler: () => void) => events.set(name, handler),
    removeListener: (name: string, handler: () => void) => {
      if (events.get(name) === handler) events.delete(name)
    },
    getPosition: () => [0, 0],
    getContentSize: () => [800, 600],
    isMaximized: () => false,
    isFullScreen: () => false,
    webContents: {
      on: (name: string, handler: () => void) => events.set(name, handler),
      removeListener: (name: string, handler: () => void) => {
        if (events.get(name) === handler) events.delete(name)
      },
    },
  } as unknown as BrowserWindow

  const restore = createDeferredWindowStateRestorer(window)
  assert.equal(events.size, 7)
  restore.dispose()
  restore.dispose()
  assert.equal(events.size, 0)
})

test("flush captures the current native zoom", async () => {
  let zoomLevel = -0.5
  const window = {
    isDestroyed: () => false,
    on: () => undefined,
    getPosition: () => [0, 0],
    getContentSize: () => [1200, 800],
    isMaximized: () => false,
    isFullScreen: () => false,
    webContents: {
      isDestroyed: () => false,
      on: () => undefined,
      setZoomLevel: (level: number) => { zoomLevel = level },
      getZoomLevel: () => zoomLevel,
      setZoomFactor: (factor: number) => { zoomLevel = Math.log(factor) / Math.log(1.2) },
      getZoomFactor: () => 1.2 ** zoomLevel,
    },
  } as unknown as BrowserWindow
  const savedZoomFactors: number[] = []
  const manager = {
    saveWindowState: async (state: { zoomFactor: number }) => { savedZoomFactors.push(state.zoomFactor); return true },
    flush: async () => undefined,
  } as unknown as ClientStateManager
  const tracker = new WindowStateTracker(window, manager, { bounds: { x: 0, y: 0, width: 1200, height: 800 }, maximized: false, fullscreen: false, zoomFactor: 1 })

  await tracker.flush()
  assert.ok(Math.abs(savedZoomFactors.at(-1)! - (1.2 ** -0.5)) < 0.000001)
})

test("Electron keyboard and wheel zoom input is applied explicitly", () => {
  const events = new Map<string, (...args: any[]) => void>()
  let zoomLevel = 0
  const prevented: string[] = []
  const window = {
    webContents: {
      on: (name: string, handler: (...args: any[]) => void) => events.set(name, handler),
      getZoomLevel: () => zoomLevel,
    },
  } as unknown as BrowserWindow
  installWindowZoomInput(window, (level) => { zoomLevel = level })

  events.get("before-input-event")?.({ preventDefault: () => prevented.push("keyboard") }, {
    type: "keyDown", control: true, meta: false, alt: false, key: "=",
  })
  assert.equal(zoomLevel, 0.5)
  events.get("zoom-changed")?.({ preventDefault: () => prevented.push("wheel") }, "out")
  assert.equal(zoomLevel, 0)
  assert.deepEqual(prevented, ["keyboard", "wheel"])
})

test("native menu zoom survives cross-origin navigation", () => {
  const events = new Map<string, (...args: any[]) => void>()
  let zoomLevel = -0.5
  const window = {
    isDestroyed: () => false,
    on: () => undefined,
    webContents: {
      isDestroyed: () => false,
      on: (name: string, handler: (...args: any[]) => void) => events.set(name, handler),
      getZoomFactor: () => 1.2 ** zoomLevel,
      setZoomFactor: (factor: number) => { zoomLevel = Math.log(factor) / Math.log(1.2) },
    },
  } as unknown as BrowserWindow
  const manager = { flush: async () => undefined } as unknown as ClientStateManager
  new WindowStateTracker(window, manager, {
    bounds: { x: 0, y: 0, width: 1200, height: 800 }, maximized: false, fullscreen: false, zoomFactor: 1,
  })

  events.get("did-start-navigation")?.({}, "http://next.test", false, true)
  zoomLevel = 0
  events.get("did-finish-load")?.()
  assert.ok(Math.abs(zoomLevel - (-0.5)) < 0.000001)
})
