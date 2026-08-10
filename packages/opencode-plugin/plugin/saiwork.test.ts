import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Config } from "@opencode-ai/plugin"

import { sanitizeAgentModelPins } from "./saiwork.js"

describe("sanitizeAgentModelPins", () => {
  it("removes shorthand pins so agents inherit the session model", () => {
    const config: Config = {
      agent: {
        investigator: { model: "haiku" },
        reviewer: { model: "provider/" },
      },
    }

    assert.deepEqual(sanitizeAgentModelPins(config), [
      { agent: "investigator", configuredModel: "haiku", effectiveModel: null },
      { agent: "reviewer", configuredModel: "provider/", effectiveModel: null },
    ])
    assert.equal(config.agent?.investigator?.model, undefined)
    assert.equal(config.agent?.reviewer?.model, undefined)
  })

  it("uses a qualified default model when one exists", () => {
    const config: Config = {
      model: " openai/gpt-5.6-sol ",
      agent: { investigator: { model: "haiku" } },
    }

    assert.deepEqual(sanitizeAgentModelPins(config), [
      { agent: "investigator", configuredModel: "haiku", effectiveModel: "openai/gpt-5.6-sol" },
    ])
    assert.equal(config.agent?.investigator?.model, "openai/gpt-5.6-sol")
  })

  it("preserves qualified agent pins", () => {
    const config: Config = {
      agent: { investigator: { model: "anthropic/claude-sonnet-4-6" } },
    }

    assert.deepEqual(sanitizeAgentModelPins(config), [])
    assert.equal(config.agent?.investigator?.model, "anthropic/claude-sonnet-4-6")
  })
})
