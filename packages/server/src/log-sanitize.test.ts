import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  LOG_REDACTED,
  isSensitiveLogKey,
  sanitizeLogValue,
  LOG_VALUE_MAX_LENGTH,
  LOG_ARRAY_MAX_ITEMS,
} from "./log-sanitize"

describe("log sanitize", () => {
  it("redacts literal passwords, API keys and tokens wherever they appear", () => {
    const payload = {
      username: "saiwork",
      password: "SuperSecretPass123",
      apiKey: "sk-literal-secret-456",
      headers: { authorization: "Bearer ya29.literal-token" },
      nested: { refreshToken: "rt-xyz" },
      data: { attributes: { accessToken: "at-abc", privateKey: "-----BEGIN PRIVATE KEY-----" } },
      cookie: "saiwork_session=leaked",
    }
    const sanitized = sanitizeLogValue(payload) as Record<string, unknown>
    assert.equal(sanitized.password, LOG_REDACTED)
    assert.equal(sanitized.apiKey, LOG_REDACTED)
    assert.equal((sanitized.headers as Record<string, unknown>)["authorization"], LOG_REDACTED)
    assert.equal((sanitized.nested as Record<string, unknown>)["refreshToken"], LOG_REDACTED)
    assert.equal((sanitized.data as Record<string, Record<string, unknown>>)["attributes"]["accessToken"], LOG_REDACTED)
    assert.equal((sanitized.data as Record<string, Record<string, unknown>>)["attributes"]["privateKey"], LOG_REDACTED)
    assert.equal(sanitized.cookie, LOG_REDACTED)
    assert.equal(sanitized.username, "saiwork", "non-secret fields survive untouched")
    const text = JSON.stringify(sanitized)
    assert.equal(text.includes("SuperSecretPass123"), false)
    assert.equal(text.includes("sk-literal-secret-456"), false)
    assert.equal(text.includes("ya29.literal-token"), false)
    assert.equal(text.includes("rt-xyz"), false)
    assert.equal(text.includes("at-abc"), false)
    assert.equal(text.includes("leaked"), false)
  })

  it("does not mutate the original payload", () => {
    const payload = { password: "keep-me", info: { depth: 1 } }
    sanitizeLogValue(payload)
    assert.equal((payload as Record<string, unknown>).password, "keep-me")
  })

  it("bounds string values", () => {
    const sanitized = sanitizeLogValue({ note: "x".repeat(LOG_VALUE_MAX_LENGTH + 50) }) as { note: string }
    assert.ok(sanitized.note.length <= LOG_VALUE_MAX_LENGTH + 60, "truncated string stays bounded")
    assert.match(sanitized.note, /<truncated 50 chars>/)
  })

  it("bounds arrays and stops recursing past the depth limit", () => {
    const sanitized = sanitizeLogValue({ items: Array.from({ length: LOG_ARRAY_MAX_ITEMS + 30 }, (_, i) => i) }) as {
      items: unknown[]
    }
    assert.equal(sanitized.items.length, LOG_ARRAY_MAX_ITEMS + 1)
    const deep = sanitizeLogValue({ a: { b: { c: { d: { e: { f: { g: { h: { i: "x" } } } } } } } } })
    assert.match(JSON.stringify(deep), /depth-limit/)
  })

  it("flags secret-looking keys", () => {
    for (const key of ["password", "accessToken", "refreshToken", "api_key", "apiKey", "authorization", "cookie", "privateKey", "client_secret"]) {
      assert.equal(isSensitiveLogKey(key), true, `${key} must be flagged`)
    }
    assert.equal(isSensitiveLogKey("username"), false)
    assert.equal(isSensitiveLogKey("text"), false)
  })
})
