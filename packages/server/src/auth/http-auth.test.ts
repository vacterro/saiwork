import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseCookies } from "./http-auth"

describe("parseCookies", () => {
  it("decodes normal percent-encoded cookie values", () => {
    const cookies = parseCookies("a=hello%20world; b=abc%2Bdef")
    assert.equal(cookies.a, "hello world")
    assert.equal(cookies.b, "abc+def")
  })

  it("does not throw on a malformed percent-encoded value", () => {
    const cookies = parseCookies("bad=%E0%A4%A")
    assert.equal(cookies.bad, undefined, "a malformed cookie must be skipped, not parsed")
  })

  it("does not treat a malformed session cookie as authenticated", () => {
    const cookies = parseCookies(`saiwork_session=%E0%A4%A`)
    assert.equal(cookies.saiwork_session, undefined)
  })

  it("keeps other valid cookies parseable in the same header", () => {
    const cookies = parseCookies(`good=ok; bad=%ZZ; another=value; broken=%E0%A4%A`)
    assert.equal(cookies.good, "ok")
    assert.equal(cookies.another, "value")
    assert.equal(cookies.bad, undefined)
    assert.equal(cookies.broken, undefined)
  })

  it("handles an empty header and header pairs without '='", () => {
    assert.deepEqual(parseCookies(undefined), {})
    assert.deepEqual(parseCookies("just-a-name"), {})
  })
})
