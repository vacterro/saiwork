import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isNewFreebuffConversationSend, sessionHasFreebuffMessage } from "./freebuff-send-guard"

const noMessages = () => []
const freebuffMessages = () => [{ info: { providerID: "freebuff" } }]
const otherMessages = () => [{ info: { providerID: "openrouter" } }]

describe("freebuff send guard", () => {
  it("detects an existing FreeBuff message in the conversation", () => {
    assert.equal(sessionHasFreebuffMessage(freebuffMessages()), true)
    assert.equal(sessionHasFreebuffMessage(otherMessages()), false)
    assert.equal(sessionHasFreebuffMessage([]), false)
    // providerID may sit on the message itself rather than .info
    assert.equal(sessionHasFreebuffMessage([{ providerID: "freebuff" }]), true)
  })

  it("only flags NEW FreeBuff conversations", () => {
    assert.equal(isNewFreebuffConversationSend({ providerId: "freebuff", modelId: "mimo/mimo-v2.5" }, noMessages), true)
    assert.equal(isNewFreebuffConversationSend({ providerId: "freebuff", modelId: "mimo/mimo-v2.5" }, freebuffMessages), false)
    assert.equal(isNewFreebuffConversationSend({ providerId: "freebuff", modelId: "mimo/mimo-v2.5" }, otherMessages), true)
  })

  it("ignores non-FreeBuff models entirely", () => {
    assert.equal(isNewFreebuffConversationSend({ providerId: "openrouter", modelId: "deepseek/deepseek-v4-flash" }, noMessages), false)
    assert.equal(isNewFreebuffConversationSend(null, noMessages), false)
  })
})
