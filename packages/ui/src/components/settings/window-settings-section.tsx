import { For, Show, createSignal, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"
import type { WindowPreset } from "../../lib/window-presets"

type PresetForm = { mode: "add" } | { mode: "edit"; preset: WindowPreset } | null

export const WindowSettingsSection: Component = () => {
  const { t } = useI18n()
  const { preferences, saveWindowPreset, deleteWindowPreset, setActiveWindowPreset } = useConfig()

  const [form, setForm] = createSignal<PresetForm>(null)
  const [name, setName] = createSignal("")
  const [width, setWidth] = createSignal("1200")
  const [height, setHeight] = createSignal("800")
  const [x, setX] = createSignal("")
  const [y, setY] = createSignal("")

  function openAdd() {
    setForm({ mode: "add" })
    setName("")
    setWidth("1200")
    setHeight("800")
    setX("")
    setY("")
  }

  function openEdit(preset: WindowPreset) {
    setForm({ mode: "edit", preset })
    setName(preset.name)
    setWidth(String(preset.width))
    setHeight(String(preset.height))
    setX(preset.x === undefined ? "" : String(preset.x))
    setY(preset.y === undefined ? "" : String(preset.y))
  }

  function commit() {
    const current = form()
    const parsedWidth = Number(width())
    const parsedHeight = Number(height())
    const parsedX = Number(x())
    const parsedY = Number(y())
    const preset: WindowPreset = {
      id: current?.mode === "edit" ? current.preset.id : `preset-${Date.now()}`,
      name: name().trim() || t("settings.window.preset.defaultName"),
      width: Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : 1200,
      height: Number.isFinite(parsedHeight) && parsedHeight > 0 ? parsedHeight : 800,
      x: x().trim() === "" || !Number.isFinite(parsedX) ? undefined : parsedX,
      y: y().trim() === "" || !Number.isFinite(parsedY) ? undefined : parsedY,
    }
    saveWindowPreset(preset)
    setForm(null)
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.window.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.window.subtitle")}</p>
          </div>
        </div>

        <div class="settings-stack">
          <Show
            when={preferences().windowPresets.length > 0}
            fallback={<p class="settings-toggle-caption">{t("settings.window.none")}</p>}
          >
            <For each={preferences().windowPresets}>
              {(preset) => {
                const active = () => preferences().activeWindowPreset === preset.id
                return (
                  <div class="settings-toggle-row settings-toggle-row-compact">
                    <div>
                      <div class="settings-toggle-title">{preset.name}</div>
                      <div class="settings-toggle-caption">
                        {preset.width}×{preset.height}
                        {preset.x !== undefined && preset.y !== undefined
                          ? t("settings.window.at", { x: preset.x, y: preset.y })
                          : t("settings.window.centered")}
                        {active() ? ` · ${t("settings.window.active")}` : ""}
                      </div>
                    </div>
                    <div class="settings-toolbar-inline">
                      <button
                        type="button"
                        class="selector-button selector-button-secondary w-auto"
                        onClick={() => setActiveWindowPreset(preset.id)}
                        disabled={active()}
                        aria-pressed={active()}
                      >
                        {active() ? t("settings.window.active") : t("settings.window.use")}
                      </button>
                      <button
                        type="button"
                        class="selector-button selector-button-secondary w-auto"
                        onClick={() => openEdit(preset)}
                      >
                        {t("settings.saipen.edit")}
                      </button>
                      <button
                        type="button"
                        class="selector-button selector-button-secondary w-auto"
                        onClick={() => deleteWindowPreset(preset.id)}
                      >
                        {t("settings.window.delete")}
                      </button>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>

          <Show when={form()} fallback={<button type="button" class="selector-button selector-button-secondary w-auto" onClick={openAdd}>{t("settings.window.add")}</button>}>
            <div class="settings-stack">
              <input
                type="text"
                class="selector-input"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder={t("settings.window.preset.name")}
                aria-label={t("settings.window.preset.name")}
              />
              <div class="settings-toolbar-inline">
                <input
                  type="number"
                  class="selector-input"
                  value={width()}
                  onInput={(e) => setWidth(e.currentTarget.value)}
                  placeholder="1200"
                  aria-label={t("settings.window.preset.width")}
                />
                <span class="settings-toggle-caption">×</span>
                <input
                  type="number"
                  class="selector-input"
                  value={height()}
                  onInput={(e) => setHeight(e.currentTarget.value)}
                  placeholder="800"
                  aria-label={t("settings.window.preset.height")}
                />
              </div>
              <div class="settings-toolbar-inline">
                <input
                  type="number"
                  class="selector-input"
                  value={x()}
                  onInput={(e) => setX(e.currentTarget.value)}
                  placeholder={t("settings.window.preset.x")}
                  aria-label={t("settings.window.preset.x")}
                />
                <input
                  type="number"
                  class="selector-input"
                  value={y()}
                  onInput={(e) => setY(e.currentTarget.value)}
                  placeholder={t("settings.window.preset.y")}
                  aria-label={t("settings.window.preset.y")}
                />
              </div>
              <div class="settings-toolbar-inline">
                <button type="button" class="selector-button selector-button-secondary w-auto" onClick={commit}>
                  {t("settings.saipen.save")}
                </button>
                <button type="button" class="selector-button selector-button-secondary w-auto" onClick={() => setForm(null)}>
                  {t("settings.saipen.cancel")}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
