import { For, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { keyboardRegistry, type KeyboardShortcut } from "../lib/keyboard-registry"
import { isMac } from "../lib/keyboard-utils"
import { SAIPEN_COMMANDS } from "../lib/saipen-commands"
import { setShowShortcutsOverlay, showShortcutsOverlay } from "../stores/ui"

/**
 * Keyboard reference, opened with F1.
 *
 * Registered shortcuts are read from the registry rather than transcribed, so
 * the sheet cannot drift from what the app actually binds. The prompt-field
 * keys below it are hand-written because they are handled inside the textarea's
 * own keydown, not through the registry.
 */

interface StaticShortcut {
  keys: string
  description: string
}

function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = []
  if (shortcut.modifiers.ctrl) parts.push("Ctrl")
  if (shortcut.modifiers.meta) parts.push(isMac() ? "Cmd" : "Meta")
  if (shortcut.modifiers.alt) parts.push("Alt")
  if (shortcut.modifiers.shift) parts.push("Shift")
  parts.push(shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key)
  return parts.join("+")
}

const ShortcutsOverlay: Component = () => {
  const { t } = useI18n()

  const promptShortcuts = (): StaticShortcut[] => [
    { keys: "Enter / Ctrl+Enter", description: t("shortcuts.prompt.send") },
    { keys: "Alt+Enter", description: t("shortcuts.prompt.queue") },
    { keys: "Shift+Enter", description: t("shortcuts.prompt.newline") },
    { keys: "!", description: t("shortcuts.prompt.shell") },
    { keys: "/", description: t("shortcuts.prompt.command") },
    { keys: "@", description: t("shortcuts.prompt.mention") },
    { keys: "Up / Down", description: t("shortcuts.prompt.history") },
  ]

  return (
    <Show when={showShortcutsOverlay()}>
      <div class="shortcuts-overlay" role="dialog" aria-modal="true" aria-label={t("shortcuts.title")}>
        <div class="shortcuts-panel">
          <header class="shortcuts-header">
            <span class="shortcuts-title">{t("shortcuts.title")}</span>
            <button type="button" onClick={() => setShowShortcutsOverlay(false)}>
              {t("shortcuts.close")}
            </button>
          </header>

          <div class="shortcuts-body">
            <section class="shortcuts-section">
              <h2 class="shortcuts-section-title">{t("shortcuts.section.global")}</h2>
              <table class="shortcuts-table">
                <tbody>
                  <For each={keyboardRegistry.list()}>
                    {(shortcut) => (
                      <tr>
                        <td class="shortcuts-key">{formatShortcut(shortcut)}</td>
                        <td>{shortcut.description}</td>
                      </tr>
                    )}
                  </For>
                  <tr>
                    <td class="shortcuts-key">Ctrl+Shift+P</td>
                    <td>{t("shortcuts.global.commandPalette")}</td>
                  </tr>
                  <tr>
                    <td class="shortcuts-key">Ctrl+1..9</td>
                    <td>{t("shortcuts.global.selectTab")}</td>
                  </tr>
                  <tr>
                    <td class="shortcuts-key">Ctrl+W</td>
                    <td>{t("shortcuts.global.closeTab")}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section class="shortcuts-section">
              <h2 class="shortcuts-section-title">{t("shortcuts.section.prompt")}</h2>
              <table class="shortcuts-table">
                <tbody>
                  <For each={promptShortcuts()}>
                    {(entry) => (
                      <tr>
                        <td class="shortcuts-key">{entry.keys}</td>
                        <td>{entry.description}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>

            <section class="shortcuts-section">
              <h2 class="shortcuts-section-title">{t("shortcuts.section.saipen")}</h2>
              <table class="shortcuts-table">
                <tbody>
                  <For each={SAIPEN_COMMANDS}>
                    {(command) => (
                      <tr>
                        <td class="shortcuts-key">
                          {command.shortcut}
                          <Show when={command.cyrillic}>{` / ${command.cyrillic}`}</Show>
                        </td>
                        <td>
                          {command.verb}
                          <span class="shortcuts-note"> — {command.summary}</span>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </section>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default ShortcutsOverlay
