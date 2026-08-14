import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"

const browserFrame = readFileSync(new URL("./browser-frame.tsx", import.meta.url), "utf8")
const previewView = readFileSync(new URL("./session-preview-view.tsx", import.meta.url), "utf8")
const sidecarView = readFileSync(new URL("./sidecar-view.tsx", import.meta.url), "utf8")

describe("preview content is treated as untrusted", () => {
  it("BrowserFrame exposes a sandbox prop and binds it to the iframe", () => {
    assert.match(browserFrame, /sandbox\?: string/)
    assert.match(browserFrame, /\bsandbox=\{props\.sandbox\}/, "the iframe must bind the sandbox prop")
  })

  it("the session preview frames remote content with allow-same-origin ONLY", () => {
    assert.match(previewView, /sandbox="allow-same-origin"/, "remote preview content must be sandboxed same-origin, no scripts")
    const previewSandboxLine = previewView.split("\n").find((line) => line.includes("sandbox=")) ?? ""
    assert.ok(!previewSandboxLine.includes("allow-scripts"), "allow-scripts must never combine with allow-same-origin for untrusted preview")
  })

  it("keeps the SideCar trust policy separate", () => {
    assert.ok(!sidecarView.includes('sandbox="allow-same-origin"'), "the SideCar frame keeps its own trust policy")
  })
})
