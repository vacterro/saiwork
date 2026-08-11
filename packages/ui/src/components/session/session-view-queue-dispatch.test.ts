import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-view.tsx")
const source = fs.readFileSync(sourcePath, "utf8")

describe("session queue dispatch safety", () => {
  it("restores only failures proven not to have reached promptAsync", () => {
    const start = source.indexOf("async function drainQueueHead()")
    const end = source.indexOf("// Drains one entry", start)
    assert.ok(start >= 0 && end > start, "queue drain function must remain discoverable")
    const drain = source.slice(start, end)

    assert.match(drain, /await dequeuePrompt[\s\S]*await handleSendMessage/)
    assert.match(drain, /if \(!didSessionPromptReachServer\(error\)\)[\s\S]*await restoreDequeuedPrompt/)
    assert.match(drain, /await restoreDequeuedPrompts/)
    assert.doesNotMatch(drain, /enqueuePrompt\(/)
  })
})
