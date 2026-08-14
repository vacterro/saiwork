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
  it("resolves the Windows desktop layout", () => {
    const install = locateFreebuffInstall({
      home: String.raw`C:\Users\dev\AppData\Local\Programs\@codebufffreebuff-desktop`,
      exists: () => true,
      readFile: () => JSON.stringify({ version: "0.0.61" }),
    })
    assert.ok(install)
    assert.equal(install!.bunPath, String.raw`C:\Users\dev\AppData\Local\Programs\@codebufffreebuff-desktop\resources\bun\bun.exe`)
    assert.equal(
      install!.orchestratorPath,
      String.raw`C:\Users\dev\AppData\Local\Programs\@codebufffreebuff-desktop\resources\orchestrator\orchestrator.js`,
    )
    assert.equal(install!.version, "0.0.61")
  })

  it("does not append a second Resources segment on macOS-style roots", () => {
    const install = locateFreebuffInstall({
      home: "/Applications/Freebuff.app/Contents/Resources",
      exists: () => true,
      readFile: () => JSON.stringify({ version: "1.2.3" }),
    })
    assert.ok(install)
    assert.equal(install!.orchestratorPath, pathForPlatform("/Applications/Freebuff.app/Contents/Resources/orchestrator/orchestrator.js"))
  })

  it("falls back to the genuine package metadata inside app.asar", () => {
    const install = locateFreebuffInstall({
      home: "C:\\Freebuff",
      exists: () => true,
      readFile: () => { throw new Error("packed") },
      readAsarPackage: (filePath) => {
        assert.match(filePath, /app\.asar$/)
        return JSON.stringify({ version: "0.0.62" })
      },
    })
    assert.equal(install?.version, "0.0.62")
  })

  it("prefers the genuine archive version over wrapper package metadata", () => {
    const install = locateFreebuffInstall({
      home: "C:\\Freebuff",
      exists: () => true,
      readFile: () => JSON.stringify({ version: "9.9.9" }),
      readAsarPackage: () => JSON.stringify({ version: "0.0.61" }),
    })
    assert.equal(install?.version, "0.0.61")
  })

  it("returns null when the engine bundle is absent", () => {
    const install = locateFreebuffInstall({ home: "C:\\missing", exists: () => false })
    assert.equal(install, null)
  })
})

function pathForPlatform(value: string): string {
  return process.platform === "win32" ? value.replaceAll("/", "\\") : value
}
