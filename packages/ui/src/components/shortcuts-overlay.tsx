import { For, Show, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { isMac } from "../lib/keyboard-utils"
import { SAIPEN_COMMANDS } from "../lib/saipen-commands"
import { buildShortcutSections } from "../lib/shortcuts-sheet"
import { setShowShortcutsOverlay, showShortcutsOverlay } from "../stores/ui"

/**
 * Keyboard reference, opened with F1.
 *
 * Rows come from the live registry, so the sheet cannot claim a binding the app
 * does not have. Which section each one lands in, and the order of sections,
 * lives in lib/shortcuts-sheet where it can be tested.
 */

const ShortcutsOverlay: Component = () => {
  const { t } = useI18n()

  const sections = () => buildShortcutSections(keyboardRegistry.list(), isMac())

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
            {/* Sections come from lib/shortcuts-sheet, so what the app binds and
                what this sheet prints cannot drift apart, and the order is one
                decision in one table instead of JSX sequence. */}
            <For each={sections()}>
              {(section) => (
                <section class="shortcuts-section">
                  <h2 class="shortcuts-section-title">{t(section.labelKey)}</h2>
                  <table class="shortcuts-table">
                    <tbody>
                      <For each={section.rows}>
                        {(row) => (
                          <tr>
                            <td class="shortcuts-key">{row.keys}</td>
                            <td>{row.descriptionIsKey ? t(row.description) : row.description}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </section>
              )}
            </For>

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
