import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { deMessages } from "./de/index.ts"
import { enMessages } from "./en/index.ts"
import { esMessages } from "./es/index.ts"
import { frMessages } from "./fr/index.ts"
import { heMessages } from "./he/index.ts"
import { jaMessages } from "./ja/index.ts"
import { neMessages } from "./ne/index.ts"
import { ruMessages } from "./ru/index.ts"
import { zhHansMessages } from "./zh-Hans/index.ts"

const locales = { deMessages, esMessages, frMessages, heMessages, jaMessages, neMessages, ruMessages, zhHansMessages }
const prefixes = ["promptInput.queue", "promptQueue.", "saipen.", "shortcuts.", "settings.nav.saipen", "settings.saipen."]
const keys = Object.keys(enMessages).filter((key) => prefixes.some((prefix) => key.startsWith(prefix))).sort()

function placeholders(value: string): string[] {
  return Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort()
}

describe("SAIPEN locale parity", () => {
  for (const [locale, messages] of Object.entries(locales)) {
    it(`${locale} matches English keys and placeholders`, () => {
      const localizedKeys = Object.keys(messages).filter((key) => prefixes.some((prefix) => key.startsWith(prefix))).sort()
      assert.deepEqual(localizedKeys, keys)
      for (const key of keys) {
        assert.deepEqual(placeholders(messages[key as keyof typeof messages]), placeholders(enMessages[key as keyof typeof enMessages]), key)
      }
    })
  }
})
