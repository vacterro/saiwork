import assert from "node:assert/strict"
import test from "node:test"

import { resolveActualUsageTokens, resolveCompactionThreshold } from "./context-usage"

test("uses provider total when token components under-report context", () => {
  assert.equal(
    resolveActualUsageTokens({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      totalTokens: 240,
    }),
    240,
  )
})

test("falls back to OpenCode component sum for missing or zero totals", () => {
  assert.equal(
    resolveActualUsageTokens({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    }),
    155,
  )
  assert.equal(
    resolveActualUsageTokens({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 10,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      totalTokens: 0,
    }),
    155,
  )
})

test("summary starts new post-compaction context", () => {
  assert.equal(
    resolveActualUsageTokens({
      inputTokens: 800_000,
      outputTokens: 12_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 812_000,
      summary: true,
    }),
    12_000,
  )
})

test("matches OpenCode input-limit reserve threshold", () => {
  assert.equal(
    resolveCompactionThreshold({ contextWindow: 1_000_000, inputLimit: 922_000, outputLimit: 32_000 }),
    902_000,
  )
  assert.equal(
    resolveCompactionThreshold({
      contextWindow: 1_000_000,
      inputLimit: 922_000,
      outputLimit: 32_000,
      reservedTokens: 50_000,
    }),
    872_000,
  )
})

test("uses output limit without explicit input limit", () => {
  assert.equal(
    resolveCompactionThreshold({ contextWindow: 200_000, inputLimit: null, outputLimit: 32_000 }),
    168_000,
  )
  assert.equal(
    resolveCompactionThreshold({
      contextWindow: 200_000,
      inputLimit: null,
      outputLimit: 32_000,
      autoCompact: false,
    }),
    null,
  )
})
