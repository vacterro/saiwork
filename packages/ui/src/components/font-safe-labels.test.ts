import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { getToolShortLabel } from "./tool-call/utils"

const here = dirname(fileURLToPath(import.meta.url))
const labelSources = [
  "saipen-bar.tsx",
  "message-item.tsx",
  "message-timeline.tsx",
  join("tool-call", "utils.ts"),
  join("tool-call", "diagnostics-section.tsx"),
  join("tool-call", "renderers", "task.tsx"),
]
const unsupportedLabelGlyph = /[☐☑⚠⚡✓✗●⏳⏸]|\uFE0F|[\u{1F300}-\u{1FAFF}]/u

describe("font-safe compact labels", () => {
  it("keeps known compact labels inside printable ASCII", () => {
    const tools = ["bash", "edit", "read", "write", "glob", "grep", "webfetch", "task", "todowrite", "question", "list", "patch", "apply_patch", "unknown"]
    for (const tool of tools) {
      assert.match(getToolShortLabel(tool), /^[\x20-\x7E]+$/)
      assert.ok(getToolShortLabel(tool).length <= 3, tool)
    }
  })

  it("rejects ballot boxes and emoji-only labels from compact status surfaces", async () => {
    for (const relativePath of labelSources) {
      const source = await readFile(join(here, relativePath), "utf8")
      assert.equal(unsupportedLabelGlyph.test(source), false, relativePath)
    }
  })
})
