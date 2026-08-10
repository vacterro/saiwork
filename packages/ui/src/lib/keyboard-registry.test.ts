import assert from "node:assert/strict"
import test from "node:test"
import { keyboardRegistry, shortcutKeyFromEvent } from "./keyboard-registry"

const keyboardEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
}) as KeyboardEvent

test("shortcutKeyFromEvent uses physical letter and digit codes", () => {
  assert.equal(shortcutKeyFromEvent(keyboardEvent({ key: "в", code: "KeyD" })), "d")
  assert.equal(shortcutKeyFromEvent(keyboardEvent({ key: "&", code: "Digit1" })), "1")
})

test("registry matches Alt+D on a non-Latin keyboard layout", () => {
  keyboardRegistry.register({
    id: "test-layout-independent-shortcut",
    key: "d",
    modifiers: { alt: true },
    handler: () => undefined,
    description: "test",
    context: "global",
  })

  try {
    const match = keyboardRegistry.findMatch(keyboardEvent({
      key: "в",
      code: "KeyD",
      altKey: true,
    }))
    assert.equal(match?.id, "test-layout-independent-shortcut")
  } finally {
    keyboardRegistry.unregister("test-layout-independent-shortcut")
  }
})

test("registry does not match a Latin key produced by another physical key", () => {
  keyboardRegistry.register({
    id: "test-physical-shortcut-position",
    key: "p",
    modifiers: { ctrl: true },
    handler: () => undefined,
    description: "test",
    context: "global",
  })

  try {
    const match = keyboardRegistry.findMatch(keyboardEvent({
      key: "p",
      code: "KeyR",
      ctrlKey: true,
    }))
    assert.equal(match, null)
  } finally {
    keyboardRegistry.unregister("test-physical-shortcut-position")
  }
})

test("registry still matches persisted layout-specific bindings", () => {
  keyboardRegistry.register({
    id: "test-legacy-layout-binding",
    key: "в",
    modifiers: { alt: true },
    handler: () => undefined,
    description: "test",
    context: "global",
    physical: false,
  })

  try {
    const match = keyboardRegistry.findMatch(keyboardEvent({
      key: "в",
      code: "KeyD",
      altKey: true,
    }))
    assert.equal(match?.id, "test-legacy-layout-binding")
  } finally {
    keyboardRegistry.unregister("test-legacy-layout-binding")
  }
})

test("legacy ASCII bindings retain event.key semantics", () => {
  keyboardRegistry.register({
    id: "test-legacy-ascii-binding",
    key: "p",
    modifiers: { ctrl: true },
    handler: () => undefined,
    description: "test",
    context: "global",
    physical: false,
  })

  try {
    const match = keyboardRegistry.findMatch(keyboardEvent({
      key: "p",
      code: "KeyR",
      ctrlKey: true,
    }))
    assert.equal(match?.id, "test-legacy-ascii-binding")
  } finally {
    keyboardRegistry.unregister("test-legacy-ascii-binding")
  }
})
