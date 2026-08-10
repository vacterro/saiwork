import { For, Show, createSignal, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { keyboardRegistry, type KeyboardShortcut } from "../../lib/keyboard-registry"
import { useConfig } from "../../stores/preferences"

const SAIWORK_SHORTCUT_IDS = [
  "saipen-bar-toggle",
  "prompt-queue-toggle",
  "window-snap-preset",
  "shortcuts-overlay",
]

const SAIWORK_SHORTCUT_LABEL_KEYS: Record<string, string> = {
  "saipen-bar-toggle": "settings.shortcuts.saipenBar",
  "prompt-queue-toggle": "settings.shortcuts.queueToggle",
  "window-snap-preset": "settings.shortcuts.snapPreset",
  "shortcuts-overlay": "settings.shortcuts.overlay",
}

function formatBinding(shortcut: KeyboardShortcut): string {
  const parts: string[] = []
  if (shortcut.modifiers.ctrl) parts.push("Ctrl")
  if (shortcut.modifiers.meta) parts.push("Cmd")
  if (shortcut.modifiers.alt) parts.push("Alt")
  if (shortcut.modifiers.shift) parts.push("Shift")
  const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
  parts.push(key)
  return parts.join("+")
}

interface CaptureState {
  id: string
  current: KeyboardShortcut
}

export const ShortcutSettingsCard: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const [capturing, setCapturing] = createSignal<CaptureState | null>(null)

  const saiworkShortcuts = () =>
    SAIWORK_SHORTCUT_IDS
      .map((id) => keyboardRegistry.get(id))
      .filter((s): s is KeyboardShortcut => Boolean(s))

  const startCapture = (id: string) => {
    const current = keyboardRegistry.get(id)
    if (!current) return
    setCapturing({ id, current })
  }

  const handleCaptureKeyDown = (event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const capture = capturing()
    if (!capture) return

    // Allow Escape to cancel without changing the binding.
    if (event.key === "Escape") {
      setCapturing(null)
      return
    }

    // Ignore pure modifier presses (wait for an actual key).
    if (["Control", "Meta", "Shift", "Alt", "AltGraph"].includes(event.key)) return

    const next = {
      key: event.key === " " ? "Space" : event.key,
      modifiers: {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
      },
    }

    keyboardRegistry.reconfigure(capture.id, next.key, next.modifiers)
    config.updatePreferences({
      shortcutOverrides: {
        ...(config.preferences().shortcutOverrides ?? {}),
        [capture.id]: next,
      },
    })
    setCapturing(null)
  }

  return (
    <div class="settings-card">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">{t("settings.shortcuts.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.shortcuts.subtitle")}</p>
        </div>
        <span class="settings-scope-badge">{t("settings.scope.device")}</span>
      </div>

      <div class="settings-stack">
        <For each={saiworkShortcuts()}>
          {(shortcut) => {
            const isCapturing = () => capturing()?.id === shortcut.id
            return (
              <div class="settings-toggle-row">
                <div class="min-w-0">
                  <div class="settings-toggle-title">
                    {t(SAIWORK_SHORTCUT_LABEL_KEYS[shortcut.id] ?? shortcut.id)}
                  </div>
                  <div class="settings-toggle-caption">{shortcut.description}</div>
                </div>
                <button
                  type="button"
                  class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                  onClick={() => startCapture(shortcut.id)}
                >
                  <Show
                    when={isCapturing()}
                    fallback={<span class="font-mono">{formatBinding(shortcut)}</span>}
                  >
                    <span>{t("settings.shortcuts.pressKeys")}</span>
                  </Show>
                </button>
                <Show when={isCapturing()}>
                  <button
                    type="button"
                    class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                    onClick={() => setCapturing(null)}
                  >
                    {t("promptQueue.cancel")}
                  </button>
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      {/* Invisible capture handler: while capturing, any keydown rebinds. */}
      <Show when={capturing()}>
        <div
          style={{ position: "fixed", inset: 0, "z-index": 1300 }}
          onKeyDown={handleCaptureKeyDown}
          tabindex={-1}
        />
      </Show>
    </div>
  )
}
