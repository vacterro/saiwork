import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getLosslessUserText, shouldRenderMessageTextAsMarkdown } from "./lossless-user-text.tsx"
import { getRawMessageText } from "../types/message.ts"

describe("user message rendering", () => {
  it("renders user-authored values without Markdown consuming characters", () => {
    const path = 'v:\\___VAC\\__K\\__CODE\\_AI_STUFF_AGENTIC\\_SAIWORK\\'
    const value = `${path}\n"${path}"\n\`literal\` $HOME _value_`

    assert.equal(getLosslessUserText(value), value)
    assert.equal(getRawMessageText([
      { id: "visible", sessionID: "session", messageID: "message", type: "text", text: value },
      { id: "hidden", sessionID: "session", messageID: "message", type: "text", text: "hidden", synthetic: true },
    ]), value)
    assert.equal(value.split("\\").length - 1, 12)
    assert.match(value, /`literal` \$HOME _value_/)
  })

  it("reserves Markdown rendering for assistant text", () => {
    assert.equal(shouldRenderMessageTextAsMarkdown("user", "part-1"), false)
    assert.equal(shouldRenderMessageTextAsMarkdown("assistant", "part-1"), true)
    assert.equal(shouldRenderMessageTextAsMarkdown("assistant", ""), false)
  })
})
