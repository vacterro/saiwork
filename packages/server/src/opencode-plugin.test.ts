import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { buildGoogleProviderConfig } from "./google/adapter"
import { buildOpencodeConfigContent } from "./opencode-plugin"

const GOOGLE_PROVIDERS = buildGoogleProviderConfig().provider

describe("buildOpencodeConfigContent", () => {
  it("creates config content with the SaiWork plugin", () => {
    const content = buildOpencodeConfigContent(undefined, "file:///plugin.tgz")

    assert.deepEqual(JSON.parse(content), {
      "$schema": "https://opencode.ai/config.json",
      plugin: ["file:///plugin.tgz"],
      provider: GOOGLE_PROVIDERS,
    })
  })

  it("merges with existing JSONC content", () => {
    const content = buildOpencodeConfigContent(
      `{
        // user plugin
        "plugin": ["npm:user-plugin",],
        "model": "test-model",
      }`,
      "file:///plugin.tgz",
    )

    assert.deepEqual(JSON.parse(content), {
      "$schema": "https://opencode.ai/config.json",
      plugin: ["npm:user-plugin", "file:///plugin.tgz"],
      model: "test-model",
      provider: GOOGLE_PROVIDERS,
    })
  })

  it("does not duplicate the SaiWork plugin", () => {
    const content = buildOpencodeConfigContent('{"plugin":["file:///plugin.tgz"]}', "file:///plugin.tgz")

    assert.deepEqual(JSON.parse(content).plugin, ["file:///plugin.tgz"])
  })

  it("keeps a user-provided google provider config over the defaults", () => {
    const content = buildOpencodeConfigContent(
      JSON.stringify({
        provider: { google_gemini_api: { npm: "user-google", models: { "custom-model": {} } } },
      }),
      "file:///plugin.tgz",
    )
    const parsed = JSON.parse(content)
    assert.equal(parsed.provider.google_gemini_api.npm, "user-google")
    assert.ok(parsed.provider.google_antigravity)
    assert.equal(Object.keys(parsed.provider).length, 2)
  })

  it("adds the freebuff provider with the workspace header when scoped", () => {
    const content = buildOpencodeConfigContent(undefined, "file:///plugin.tgz", [], "http://127.0.0.1:4000", "C:/work/proj")
    const parsed = JSON.parse(content)
    assert.ok(parsed.provider.freebuff)
    assert.equal(parsed.provider.freebuff.npm, "@ai-sdk/openai-compatible")
    assert.equal(parsed.provider.freebuff.options.baseURL, "http://127.0.0.1:4000/fb/v1")
    assert.equal(parsed.provider.freebuff.options.headers["x-saiwork-workspace"], "C:/work/proj")
    assert.equal(parsed.provider.freebuff.models, undefined, "freebuff models must be auto-discovered from /fb/v1/models, never pinned")
  })

  it("does not pin Antigravity models so new backend models appear live", () => {
    const parsed = JSON.parse(buildOpencodeConfigContent(undefined, "file:///plugin.tgz"))
    assert.ok(parsed.provider.google_antigravity)
    assert.equal(parsed.provider.google_antigravity.models, undefined, "antigravity models must be auto-discovered from /v1/models")
  })

  it("omits the freebuff provider without a workspace path", () => {
    const content = buildOpencodeConfigContent(undefined, "file:///plugin.tgz")
    const parsed = JSON.parse(content)
    assert.equal(parsed.provider.freebuff, undefined)
  })

  it("hides Antigravity and FreeBuff when their backends are absent", () => {
    const content = buildOpencodeConfigContent(
      undefined, "file:///plugin.tgz", [], "http://127.0.0.1:4000", "C:/work/proj",
      { includeAntigravity: false, includeFreebuff: false },
    )
    const parsed = JSON.parse(content)
    assert.equal(parsed.provider.google_antigravity, undefined)
    assert.equal(parsed.provider.freebuff, undefined)
    // The always-available Gemini API provider survives.
    assert.ok(parsed.provider.google_gemini_api)
  })

  it("every model limit carries both context and output (opencode schema)", () => {
    const content = buildOpencodeConfigContent(undefined, "file:///plugin.tgz")
    const parsed = JSON.parse(content)
    const providers = Object.values(parsed.provider) as Array<{ models?: Record<string, { limit?: unknown }> }>
    for (const provider of providers) {
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        if (model.limit === undefined) continue
        const limit = model.limit as { context?: unknown; output?: unknown }
        assert.ok(
          typeof limit.context === "number" && limit.context > 0,
          `${modelId} limit.context missing`,
        )
        assert.ok(
          typeof limit.output === "number" && limit.output > 0,
          `${modelId} limit.output missing`,
        )
      }
    }
  })
})
