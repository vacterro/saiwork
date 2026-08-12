import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  detectAntigravity,
  googleProviderStatus,
  resolveGeminiApiKey,
} from "./providers"
import {
  ANTIGRAVITY_PROVIDER_ID,
  GEMINI_API_PROVIDER_ID,
} from "./types"

function overrides(extra: Record<string, unknown> = {}) {
  const files = new Map<string, string>()
  const norm = (filePath: string) => filePath.replace(/\\/g, "/")
  return {
    env: { ...process.env, ...(extra.env ?? {}) },
    home: "C:/users/test",
    opencodeDataHome: "C:/users/test/opencode-data",
    opencodeConfigHome: "C:/users/test/opencode-config",
    exists: (filePath: string) => files.has(norm(filePath)),
    readFile: (filePath: string) => files.get(norm(filePath)) ?? "",
    readStateDb: () => null,
    files,
  } as { env: NodeJS.ProcessEnv; home: string; opencodeDataHome: string; opencodeConfigHome: string; exists: (f: string) => boolean; readFile: (f: string) => string; readStateDb: (p: string, k: string) => string | null; files: Map<string, string> }
}

const geminiAuth = JSON.stringify({ google: { type: "api", key: "AIzaTEST1234567890abcdefghijklmno" } })

describe("google provider separation", () => {
  it("treats Gemini API and Antigravity as distinct providers", () => {
    const providers = googleProviderStatus(overrides())
    const ids = providers.map((p) => p.id)
    assert.ok(ids.includes(GEMINI_API_PROVIDER_ID))
    assert.ok(ids.includes(ANTIGRAVITY_PROVIDER_ID))
    assert.notEqual(GEMINI_API_PROVIDER_ID, ANTIGRAVITY_PROVIDER_ID)
  })

  it("gemini api never requires antigravity oauth", () => {
    // No Antigravity session anywhere, but a Gemini API key in env.
    const o = overrides({ env: { GEMINI_API_KEY: "AIzaTESTKEY" } })
    const providers = googleProviderStatus(o)
    const gemini = providers.find((p) => p.id === GEMINI_API_PROVIDER_ID)!
    assert.equal(gemini.status, "ready")
    // Antigravity stays unconfigured; it does not piggyback on the api key.
    const antigravity = providers.find((p) => p.id === ANTIGRAVITY_PROVIDER_ID)!
    assert.notEqual(antigravity.status, "ready")
  })

  it("antigravity never requires an api key", () => {
    // OAuth session + adapter present, no API key anywhere.
    const o = overrides()
    delete o.env.GEMINI_API_KEY
    delete o.env.GOOGLE_GENERATIVE_AI_API_KEY
    o.files.set(
      `${o.opencodeConfigHome}/antigravity-accounts.json`,
      JSON.stringify({ accounts: [{ accessToken: "ya29.TESTTOKEN" }] }),
    )
    o.files.set(`${o.opencodeConfigHome}/plugins/opencode-antigravity-auth`, "x")
    o.env.PATH = "C:/bin"
    o.files.set("C:/bin/opencode.exe", "x")
    const detection = detectAntigravity(o)
    assert.equal(detection.sessionAvailable, true)
    assert.equal(detection.adapterInstalled, true)
    // resolveGeminiApiKey still finds nothing.
    assert.equal(resolveGeminiApiKey(o), null)
    const providers = googleProviderStatus(o)
    const antigravity = providers.find((p) => p.id === ANTIGRAVITY_PROVIDER_ID)!
    assert.equal(antigravity.status, "ready")
  })

  it("missing antigravity plugin is non-fatal", () => {
    const o = overrides({ env: { GEMINI_API_KEY: "AIzaTESTKEY" } })
    const providers = googleProviderStatus(o)
    const antigravity = providers.find((p) => p.id === ANTIGRAVITY_PROVIDER_ID)!
    assert.ok(["plugin_missing", "not_configured", "unavailable"].includes(antigravity.status))
    // The rest of the list still resolves.
    assert.ok(providers.some((p) => p.id === GEMINI_API_PROVIDER_ID && p.status === "ready"))
  })

  it("missing opencode is non-fatal", () => {
    const o = overrides()
    o.env.PATH = ""
    o.files.set(
      `${o.opencodeConfigHome}/antigravity-accounts.json`,
      JSON.stringify({ accounts: [{ accessToken: "ya29.TESTTOKEN" }] }),
    )
    const detection = detectAntigravity(o)
    assert.equal(detection.opencodeAvailable, false)
    const providers = googleProviderStatus(o)
    const antigravity = providers.find((p) => p.id === ANTIGRAVITY_PROVIDER_ID)!
    assert.equal(antigravity.status, "unavailable")
  })

  it("reads the gemini api key from env or opencode auth", () => {
    assert.equal(resolveGeminiApiKey(overrides({ env: { GEMINI_API_KEY: "AIzaENVKEY" } })), "AIzaENVKEY")
    const o = overrides()
    o.files.set("C:/users/test/opencode-data/auth.json", geminiAuth)
    const key = resolveGeminiApiKey(o)
    assert.equal(key, "AIzaTEST1234567890abcdefghijklmno")
  })

  it("detects an antigravity session from the app state db", () => {
    const o = overrides()
    const blob = Buffer.from(`session{access:"ya29.FAKETOKEN" refresh:"1//FAKEREFRESH"}`).toString("base64")
    o.readStateDb = () => blob
    o.env.PATH = "C:/bin"
    o.files.set("C:/bin/opencode.exe", "x")
    o.files.set(`${o.opencodeConfigHome}/plugins/opencode-antigravity-auth`, "x")
    const detection = detectAntigravity(o)
    assert.equal(detection.sessionAvailable, true)
    const providers = googleProviderStatus(o)
    assert.equal(providers.find((p) => p.id === ANTIGRAVITY_PROVIDER_ID)!.status, "ready")
  })
})
