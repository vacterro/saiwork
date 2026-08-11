import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { truncateUtf8 } from "./utf8"

const samples = [
  "plain ASCII text",
  "Кириллица без потерь",
  "Täpitähed: õäöüšž",
  "日本語の計画",
  "emoji: 😀🧭🛠️",
]

describe("truncateUtf8", () => {
  for (const sample of samples) {
    it(`keeps head and tail valid within every byte cap: ${sample}`, () => {
      const byteLength = Buffer.byteLength(sample, "utf8")
      for (let cap = 0; cap <= byteLength; cap += 1) {
        const head = truncateUtf8(sample, cap, "head")
        const tail = truncateUtf8(sample, cap, "tail")
        assert.ok(Buffer.byteLength(head, "utf8") <= cap)
        assert.ok(Buffer.byteLength(tail, "utf8") <= cap)
        assert.equal(head.includes("\uFFFD"), false)
        assert.equal(tail.includes("\uFFFD"), false)
        assert.equal(sample.startsWith(head), true)
        assert.equal(sample.endsWith(tail), true)
      }
    })
  }
})
