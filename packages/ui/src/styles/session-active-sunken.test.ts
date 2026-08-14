import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const css = (file: string) => readFileSync(new URL(`../styles/${file}`, import.meta.url), "utf8")

describe("selected session rows and project tabs render sunken", () => {
  it("flips the active sidebar session row to the inset (pressed) bevel", () => {
    const layout = css("panels/session-layout.css")
    const activeRule = layout.slice(layout.indexOf(".session-item-base.session-item-active"))
    assert.match(activeRule, /border-color: var\(--borderDark\) var\(--bevelLight\) var\(--bevelLight\) var\(--borderDark\)/)
    assert.match(activeRule, /background-color: var\(--surface\)/)
  })

  it("flips the active project tab to the inset (pressed) bevel distinct from idle", () => {
    const tabs = css("panels/tabs.css")
    assert.match(tabs, /\.tab-active \{[^}]*border-color: var\(--borderDark\) var\(--bevelLight\) var\(--bevelLight\) var\(--borderDark\)/)
    assert.match(tabs, /\.tab-active \{[^}]*background-color: var\(--surface\)/)
  })
})
