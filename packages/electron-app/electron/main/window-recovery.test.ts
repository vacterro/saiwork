import assert from "node:assert/strict"
import test from "node:test"
import { shouldRecreateMainWindow } from "./window-recovery"

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
