import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { antigravityLiveCatalog, ANTIGRAVITY_DENIED_LIVE_IDS } from "./models"
import type { AntigravityModelInfo } from "./antigravity-session"

const liveModel = (id: string, displayName: string): AntigravityModelInfo => ({
  id,
  displayName,
  maxTokens: 1_048_576,
  maxOutputTokens: 65_536,
})

describe("antigravityLiveCatalog", () => {
  it("surfaces a newly released backend model with static metadata merged", () => {
    const models = antigravityLiveCatalog([
      liveModel("gemini-3.7-flash", "Gemini 3.7 Flash"),
      liveModel("gemini-pro-agent", "Gemini 3.1 Pro (High)"),
    ])
    const ids = models.map((model) => model.id)
    assert.ok(ids.includes("gemini-3.7-flash"), "a vendor-released model must appear live")
    const agent = models.find((model) => model.id === "gemini-pro-agent")
    assert.equal(agent?.displayName, "Gemini 3.1 Pro (High)", "static display metadata wins over the raw live name")
    assert.equal(agent?.context, 1_048_576)
  })

  it("drops known-broken backend ids and falls back to static on an empty list", () => {
    assert.ok(ANTIGRAVITY_DENIED_LIVE_IDS.size > 0)
    const models = antigravityLiveCatalog([liveModel("gemini-3.1-pro-high", "Gemini 3.1 Pro (High)")])
    assert.equal(models.some((model) => model.id === "gemini-3.1-pro-high"), false, "broken id must not be offered")

    const fallback = antigravityLiveCatalog([])
    assert.ok(fallback.length > 0, "empty live list falls back to the static catalog")
  })
})
