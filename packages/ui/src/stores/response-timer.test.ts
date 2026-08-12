import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  clearResponseStartedAt,
  getResponseStartedAt,
  responseStartedAtSignal,
  responseTimerKey,
  setResponseStartedAt,
} from "./response-timer"

describe("response timer store", () => {
  it("tracks start times per session independently", () => {
    clearResponseStartedAt("inst-1", "ses-1")
    clearResponseStartedAt("inst-1", "ses-2")
    assert.equal(getResponseStartedAt("inst-1", "ses-1"), null)

    setResponseStartedAt("inst-1", "ses-1", 1000)
    setResponseStartedAt("inst-1", "ses-2", 9000)
    assert.equal(getResponseStartedAt("inst-1", "ses-1"), 1000)
    assert.equal(getResponseStartedAt("inst-1", "ses-2"), 9000)
    assert.equal(getResponseStartedAt("inst-2", "ses-1"), null)
  })

  it("clears only the targeted session", () => {
    clearResponseStartedAt("inst-1", "ses-1")
    clearResponseStartedAt("inst-1", "ses-2")
    setResponseStartedAt("inst-1", "ses-1", 1000)
    setResponseStartedAt("inst-1", "ses-2", 9000)
    clearResponseStartedAt("inst-1", "ses-1")
    assert.equal(getResponseStartedAt("inst-1", "ses-1"), null)
    assert.equal(getResponseStartedAt("inst-1", "ses-2"), 9000)
  })

  it("reactive signal observes changes", () => {
    clearResponseStartedAt("inst-1", "ses-1")
    const read = responseStartedAtSignal("inst-1", "ses-1")
    assert.equal(read(), null)
    setResponseStartedAt("inst-1", "ses-1", 500)
    assert.equal(read(), 500)
    clearResponseStartedAt("inst-1", "ses-1")
    assert.equal(read(), null)
  })

  it("keys isolate instance and session", () => {
    assert.equal(responseTimerKey("a", "b"), "a::b")
    assert.notEqual(responseTimerKey("a", "b"), responseTimerKey("a", "c"))
  })
})
