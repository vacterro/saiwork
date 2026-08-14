import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { classifyNavigationTarget } from "./navigation-policy"

const ALLOWED = ["http://127.0.0.1:4000"]

describe("classifyNavigationTarget", () => {
  it("treats an allowed renderer origin as internal", () => {
    assert.equal(classifyNavigationTarget("http://127.0.0.1:4000/some/path", ALLOWED), "internal")
    assert.equal(classifyNavigationTarget("https://127.0.0.1:4000/", ALLOWED), "externalAllowed", "scheme changes the identity")
  })

  it("treats other http(s) origins as externalAllowed", () => {
    assert.equal(classifyNavigationTarget("https://example.com/docs", ALLOWED), "externalAllowed")
    assert.equal(classifyNavigationTarget("http://10.0.0.5:8080", ALLOWED), "externalAllowed")
  })

  it("blocks every non-http(s) scheme", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "shell:AppsFolder",
      "custom-proto://x",
      "mailto:user@example.com",
    ]) {
      assert.equal(classifyNavigationTarget(url, ALLOWED), "blocked", `${url} must be blocked`)
    }
  })

  it("blocks malformed URLs", () => {
    assert.equal(classifyNavigationTarget("http://", ALLOWED), "blocked")
    assert.equal(classifyNavigationTarget("://nope", ALLOWED), "blocked")
    assert.equal(classifyNavigationTarget("", ALLOWED), "blocked")
  })
})
