import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isBenignDestroyRace } from "./main-process-guard"

describe("main process guard", () => {
  it("treats the WebContents teardown race as benign", () => {
    assert.equal(
      isBenignDestroyRace(
        new Error("Object has been destroyed\n    at WebContents.disconnectRenderer (...)\n    at WebContents.emit (node:events:530:35)"),
      ),
      true,
    )
  })

  it("treats an empty-stack destroy error as benign", () => {
    assert.equal(isBenignDestroyRace(new Error("Object has been destroyed")), false)
    assert.equal(isBenignDestroyRace("Object has been destroyed"), false)
  })

  it("does not hide real application errors", () => {
    assert.equal(isBenignDestroyRace(new Error("TypeError: window.webContents is not a function")), false)
    assert.equal(isBenignDestroyRace(new Error("ECONNREFUSED 127.0.0.1:4000")), false)
    assert.equal(isBenignDestroyRace(null), false)
  })
})
