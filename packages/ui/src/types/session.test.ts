import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  getSelectableAgentsForSession,
  isAgentModelAvailable,
  isSelectablePrimaryAgent,
  type Agent,
  type Provider,
} from "./session.ts"

const visiblePrimary: Agent = { name: "plan", description: "", mode: "primary" }
const visibleSubagent: Agent = { name: "review", description: "", mode: "subagent" }
const hiddenPrimary: Agent = { name: "build", description: "", mode: "primary", hidden: true }
const hiddenSubagent: Agent = { name: "debug", description: "", mode: "subagent", hidden: true }

describe("agent selectability", () => {
  it("matches primary-session selector rules", () => {
    assert.equal(isSelectablePrimaryAgent(visiblePrimary), true)
    assert.equal(isSelectablePrimaryAgent(visibleSubagent), false)
    assert.equal(isSelectablePrimaryAgent(hiddenPrimary), false)
    assert.equal(isSelectablePrimaryAgent(hiddenSubagent), false)
  })

  it("excludes hidden and subagent entries from main-session selectors", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "build", false).map((agent) => agent.name),
      ["plan"],
    )
  })

  it("preserves a child session's current hidden agent for steering", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "build", true).map((agent) => agent.name),
      ["review", "plan", "build"],
    )
  })

  it("does not add unrelated hidden agents to child-session selectors", () => {
    const agents = [hiddenPrimary, visibleSubagent, visiblePrimary]

    assert.deepEqual(
      getSelectableAgentsForSession(agents, "review", true).map((agent) => agent.name),
      ["review", "plan"],
    )
  })

  it("keeps inherited and valid models available while rejecting missing pins", () => {
    const providerList: Provider[] = [{
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", providerId: "openai" }],
    }]
    const inherited: Agent = { name: "general", description: "", mode: "subagent" }
    const valid: Agent = {
      name: "reviewer",
      description: "",
      mode: "subagent",
      model: { providerId: "openai", modelId: "gpt-5.6-sol" },
    }
    const unavailable: Agent = {
      name: "investigator",
      description: "",
      mode: "subagent",
      model: { providerId: "anthropic", modelId: "claude-haiku" },
    }

    assert.equal(isAgentModelAvailable(inherited, providerList), true)
    assert.equal(isAgentModelAvailable(valid, providerList), true)
    assert.equal(isAgentModelAvailable(unavailable, providerList), false)
    assert.equal(isAgentModelAvailable(unavailable, []), true)
  })
})
