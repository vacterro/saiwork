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
})
