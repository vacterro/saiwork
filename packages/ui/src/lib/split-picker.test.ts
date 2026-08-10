import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildSplitCandidates, paneKey } from "./split-picker.ts"

describe("split-picker candidates", () => {
  it("lists the current instance's cached sessions", () => {
    const result = buildSplitCandidates({
      currentInstanceId: "inst",
      cachedSessions: [
        { instanceId: "inst", sessionId: "s1", title: "One" },
        { instanceId: "inst", sessionId: "s2", title: "Two" },
      ],
      otherActiveSessions: [],
      shownPaneKeys: new Set(),
    })
    assert.deepEqual(result, [
      { instanceId: "inst", sessionId: "s1", title: "One" },
      { instanceId: "inst", sessionId: "s2", title: "Two" },
    ])
  })

  it("excludes sessions already shown as panes", () => {
    const result = buildSplitCandidates({
      currentInstanceId: "inst",
      cachedSessions: [
        { instanceId: "inst", sessionId: "s1", title: "One" },
        { instanceId: "inst", sessionId: "s2", title: "Two" },
      ],
      otherActiveSessions: [],
      shownPaneKeys: new Set([paneKey("inst", "s1")]),
    })
    assert.deepEqual(result, [{ instanceId: "inst", sessionId: "s2", title: "Two" }])
  })

  it("appends other instances' active sessions", () => {
    const result = buildSplitCandidates({
      currentInstanceId: "inst-a",
      cachedSessions: [{ instanceId: "inst-a", sessionId: "s1", title: "A" }],
      otherActiveSessions: [
        { instanceId: "inst-b", sessionId: "s2", title: "B" },
        { instanceId: "inst-c", sessionId: "s3", title: "C" },
      ],
      shownPaneKeys: new Set(),
    })
    assert.deepEqual(result, [
      { instanceId: "inst-a", sessionId: "s1", title: "A" },
      { instanceId: "inst-b", sessionId: "s2", title: "B" },
      { instanceId: "inst-c", sessionId: "s3", title: "C" },
    ])
  })

  it("drops other instances' sessions already shown as panes", () => {
    const result = buildSplitCandidates({
      currentInstanceId: "inst-a",
      cachedSessions: [{ instanceId: "inst-a", sessionId: "s1", title: "A" }],
      otherActiveSessions: [
        { instanceId: "inst-b", sessionId: "s2", title: "B" },
        { instanceId: "inst-b", sessionId: "s9", title: "B-other" },
      ],
      shownPaneKeys: new Set([paneKey("inst-b", "s2")]),
    })
    assert.deepEqual(result, [
      { instanceId: "inst-a", sessionId: "s1", title: "A" },
      { instanceId: "inst-b", sessionId: "s9", title: "B-other" },
    ])
  })

  it("never offers the current instance's own active session as another project", () => {
    const result = buildSplitCandidates({
      currentInstanceId: "inst",
      cachedSessions: [{ instanceId: "inst", sessionId: "s1", title: "One" }],
      otherActiveSessions: [{ instanceId: "inst", sessionId: "s1", title: "One (dup)" }],
      shownPaneKeys: new Set(),
    })
    assert.equal(result.length, 1)
    assert.equal(result[0].sessionId, "s1")
  })

  it("returns an empty list when everything is already shown", () => {
    const result = buildSplitCandidates({
      currentInstanceId: "inst",
      cachedSessions: [{ instanceId: "inst", sessionId: "s1", title: "One" }],
      otherActiveSessions: [],
      shownPaneKeys: new Set([paneKey("inst", "s1")]),
    })
    assert.deepEqual(result, [])
  })
})
