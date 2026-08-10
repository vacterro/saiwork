import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { KeyboardShortcut } from "./keyboard-registry.ts"
import {
  SHORTCUT_GROUP_ORDER,
  buildShortcutSections,
  formatShortcutKeys,
  UNREGISTERED_ROWS,
} from "./shortcuts-sheet.ts"

function shortcut(overrides: Partial<KeyboardShortcut> & Pick<KeyboardShortcut, "id">): KeyboardShortcut {
  return {
    key: "a",
    modifiers: {},
    handler: () => {},
    description: overrides.id,
    ...overrides,
  } as KeyboardShortcut
}

describe("formatShortcutKeys", () => {
  it("orders modifiers the same way every time", () => {
    const combo = shortcut({
      id: "x",
      key: "k",
      modifiers: { ctrl: true, meta: true, alt: true, shift: true },
    })
    assert.equal(formatShortcutKeys(combo, false), "Ctrl+Meta+Alt+Shift+K")
    assert.equal(formatShortcutKeys(combo, true), "Ctrl+Cmd+Alt+Shift+K")
  })

  it("leaves named keys alone and upper-cases single letters", () => {
    assert.equal(formatShortcutKeys(shortcut({ id: "f", key: "F1" }), false), "F1")
    assert.equal(formatShortcutKeys(shortcut({ id: "q", key: "q" }), false), "Q")
  })
})

describe("buildShortcutSections", () => {
  it("splits by meaning and keeps the declared section order", () => {
    const sections = buildShortcutSections(
      [
        shortcut({ id: "focus-model", group: "agent" }),
        shortcut({ id: "instance-next", group: "navigation" }),
        shortcut({ id: "session-new", group: "session" }),
      ],
      false,
    )

    const order = sections.map((section) => section.group)
    assert.deepEqual(order, ["navigation", "session", "prompt", "agent", "panels"].filter((group) =>
      order.includes(group as never),
    ))
    assert.deepEqual(order, ["navigation", "session", "prompt", "agent", "panels"])
  })

  it("drops empty sections instead of printing a bare heading", () => {
    // `agent` is the only group with no hand-written rows, so it is the only
    // one that can actually go empty.
    const withAgent = buildShortcutSections([shortcut({ id: "only", group: "agent" })], false)
    assert.ok(withAgent.some((section) => section.group === "agent"))

    const withoutAgent = buildShortcutSections([shortcut({ id: "nav", group: "navigation" })], false)
    assert.equal(
      withoutAgent.some((section) => section.group === "agent"),
      false,
      "a heading with nothing under it is noise",
    )
  })

  it("puts an ungrouped shortcut somewhere plausible instead of losing it", () => {
    const sections = buildShortcutSections([shortcut({ id: "stray" })], false)
    const panels = sections.find((section) => section.group === "panels")

    assert.ok(panels, "a section exists for it")
    assert.ok(panels!.rows.some((row) => row.description === "stray"))
  })

  it("keeps registered rows before the hand-written ones in a section", () => {
    const sections = buildShortcutSections([shortcut({ id: "clear-input", group: "prompt" })], false)
    const prompt = sections.find((section) => section.group === "prompt")

    assert.equal(prompt!.rows[0]?.description, "clear-input")
    assert.equal(prompt!.rows[1]?.descriptionIsKey, true)
  })

  it("marks hand-written descriptions as i18n keys, not literal text", () => {
    // A row rendered raw would print `shortcuts.prompt.send` at the user.
    for (const row of UNREGISTERED_ROWS) {
      assert.equal(row.descriptionIsKey, true, `${row.keys} must be translated`)
      assert.match(row.description, /^shortcuts\./)
    }
  })

  it("covers every declared group in the order table", () => {
    assert.deepEqual(new Set(SHORTCUT_GROUP_ORDER).size, SHORTCUT_GROUP_ORDER.length)
  })
})
