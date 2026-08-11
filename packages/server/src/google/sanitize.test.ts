import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { looksLikeSecret, sanitizeHeaderLine, sanitizeSecretText, sanitizeStderr } from "./sanitize"

describe("google secret sanitization", () => {
  it("redacts api keys and oauth tokens from free text", () => {
    const input = "key=AIzaSyA12345678901234567890123456789 token=ya29.abcdef12345 refresh=1//xyz789"
    const output = sanitizeSecretText(input)
    assert.ok(!output.includes("AIzaSyA12345678901234567890123456789"))
    assert.ok(!output.includes("ya29.abcdef12345"))
    assert.ok(!output.includes("1//xyz789"))
    assert.ok(output.includes("[REDACTED]"))
  })

  it("redacts authorization headers", () => {
    const line = sanitizeHeaderLine("Authorization: Bearer ya29.supersecrettoken")
    assert.ok(!line.includes("ya29.supersecrettoken"))
    assert.ok(line.includes("[REDACTED]"))
    const keyLine = sanitizeHeaderLine("X-Goog-Api-Key: AIzaSyB1234567890123456789012345678")
    assert.ok(!keyLine.includes("AIzaSyB1234567890123456789012345678"))
  })

  it("sanitizes stderr before persistence", () => {
    const raw = [
      "Authorization: Bearer ya29.tokenvalue",
      "curl https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent -H 'X-Goog-Api-Key: AIzaSyC99999999999999999999999999999'",
      "error: quota exceeded",
    ].join("\n")
    const output = sanitizeStderr(raw)
    assert.ok(!output.includes("ya29.tokenvalue"))
    assert.ok(!output.includes("AIzaSyC99999999999999999999999999999"))
    assert.ok(output.includes("quota exceeded"))
  })

  it("detects secret-looking strings", () => {
    assert.equal(looksLikeSecret("AIzaSyD1234567890123456789012345678"), true)
    assert.equal(looksLikeSecret("just a normal error message"), false)
  })
})
