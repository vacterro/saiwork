import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { locateFreebuffInstall, readFreebuffAuth } from "./install"

const WIN_STATE = JSON.stringify({
  authSessions: {
    "https://www.codebuff.com": {
      token: "tok-123",
      user: { id: "u1", email: "dev@example.com", name: "Dev" },
    },
  },
})

describe("readFreebuffAuth", () => {
  it("reads the account from the desktop state file", () => {
    const auth = readFreebuffAuth({ readFile: () => WIN_STATE })
    assert.deepEqual(auth, {
      token: "tok-123",
      user: { id: "u1", email: "dev@example.com", name: "Dev" },
    })
  })

  it("falls back to the legacy authToken/authUser shape", () => {
    const auth = readFreebuffAuth({
      readFile: () => JSON.stringify({ authToken: "legacy", authUser: { id: "u2" } }),
    })
    assert.deepEqual(auth, { token: "legacy", user: { id: "u2" } })
  })

  it("returns null when every state file is missing or corrupt", () => {
    assert.equal(readFreebuffAuth({ readFile: () => { throw new Error("nope") } }), null)
  })
})

describe("locateFreebuffInstall", () => {
  const exists = (filePath: string) =>
    filePath.includes("bun.exe") ||
    filePath.includes("orchestrator.js") ||
    filePath.includes("resources")

  it("resolves the Windows desktop layout", () => {
    const install = locateFreebuffInstall({
      home: String.raw`C:\Users\dev\AppData\Local\Programs\@codebufffreebuff-desktop`,
      exists: () => true,
    })
    assert.ok(install)
    assert.equal(install!.bunPath, String.raw`C:\Users\dev\AppData\Local\Programs\@codebufffreebuff-desktop\resources\bun\bun.exe`)
    assert.equal(
      install!.orchestratorPath,
      String.raw`C:\Users\dev\AppData\Local\Programs\@codebufffreebuff-desktop\resources\orchestrator\orchestrator.js`,
    )
  })

  it("returns null when the engine bundle is absent", () => {
    const install = locateFreebuffInstall({ home: "C:\\missing", exists: () => false })
    assert.equal(install, null)
  })
})
