import assert from "node:assert/strict"
import test from "node:test"
import { readyCliUrl, shouldRecreateMainWindow } from "./window-recovery"

const alive = { isDestroyed: () => false }
const destroyed = { isDestroyed: () => true }

test("recreates the main window when it is null", () => {
  assert.equal(shouldRecreateMainWindow(null), true)
})

test("recreates the main window when it is destroyed", () => {
  assert.equal(shouldRecreateMainWindow(destroyed), true)
})

test("does not recreate a live main window", () => {
  assert.equal(shouldRecreateMainWindow(alive), false)
})

test("recovered main reconnects only to a ready CLI URL", () => {
  assert.equal(readyCliUrl({ state: "ready", url: "http://127.0.0.1:3000" }), "http://127.0.0.1:3000")
  assert.equal(readyCliUrl({ state: "starting", url: "http://127.0.0.1:3000" }), null)
  assert.equal(readyCliUrl({ state: "ready" }), null)
})
