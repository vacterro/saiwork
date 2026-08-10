import { createMemo, createSignal, Show, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useConfig, type SaipenSettings } from "../../stores/preferences"
import { normalizeSaipenFiles, normalizeSaipenHome } from "../../lib/settings/saipen-settings"

export const SaipenSettingsSection: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const saipenConfig = createMemo(() => config.serverSettings().saipen ?? {} as Partial<SaipenSettings>)

  const enabled = () => saipenConfig().enabled !== false
  const home = () => saipenConfig().home ?? ""
  const files = () => (saipenConfig().files ?? []).join(", ")

  const [editingHome, setEditingHome] = createSignal(false)
  const [editingFiles, setEditingFiles] = createSignal(false)
  const [homeDraft, setHomeDraft] = createSignal("")
  const [filesDraft, setFilesDraft] = createSignal("")
  const [saveError, setSaveError] = createSignal<string | null>(null)

  async function save(updates: Partial<SaipenSettings>): Promise<boolean> {
    try {
      await config.updateSaipenSettings(updates)
      setSaveError(null)
      return true
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  function beginEditHome() {
    setHomeDraft(home())
    setEditingHome(true)
  }

  async function commitHome() {
    if (await save({ home: normalizeSaipenHome(homeDraft()) })) setEditingHome(false)
  }

  function cancelHome() {
    setEditingHome(false)
  }

  function beginEditFiles() {
    setFilesDraft(files())
    setEditingFiles(true)
  }

  async function commitFiles() {
    if (await save({ files: normalizeSaipenFiles(filesDraft()) })) setEditingFiles(false)
  }

  function cancelFiles() {
    setEditingFiles(false)
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.saipen.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.saipen.subtitle")}</p>
          </div>
          <span class="settings-scope-badge settings-scope-badge-server">{t("settings.scope.server")}</span>
        </div>

        <div class="settings-stack">
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-title">{t("settings.saipen.enabled.title")}</div>
              <div id="saipen-enabled-description" class="settings-toggle-caption">
                {t("settings.saipen.enabled.subtitle")}
              </div>
            </div>
            <label class="settings-checkbox-toggle">
              <input
                type="checkbox"
                checked={enabled()}
                aria-describedby="saipen-enabled-description"
                onChange={(event) => void save({ enabled: event.currentTarget.checked })}
              />
              <span>{t(enabled() ? "settings.common.enabled" : "settings.common.disabled")}</span>
            </label>
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.saipen.autoUpdate.title")}</div>
              <div id="saipen-autoupdate-description" class="settings-toggle-caption">
                {t("settings.saipen.autoUpdate.subtitle")}
              </div>
            </div>
            <label class="settings-checkbox-toggle">
              <input
                type="checkbox"
                checked={saipenConfig().autoUpdate === true}
                aria-describedby="saipen-autoupdate-description"
                onChange={(event) => void save({ autoUpdate: event.currentTarget.checked })}
              />
              <span>{t(saipenConfig().autoUpdate ? "settings.common.enabled" : "settings.common.disabled")}</span>
            </label>
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.saipen.home.title")}</div>
              <div class="settings-toggle-caption">
                {home() || t("settings.saipen.home.autoDetect")}
              </div>
            </div>
            <Show
              when={editingHome()}
              fallback={
                <button
                  type="button"
                  class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                  onClick={beginEditHome}
                  aria-label={`${t("settings.saipen.home.title")}: ${t("settings.saipen.edit")}`}
                >
                  {t("settings.saipen.edit")}
                </button>
              }
            >
              <div class="settings-toolbar-inline">
                <input
                  type="text"
                  class="selector-input w-full"
                  value={homeDraft()}
                  onInput={(e) => setHomeDraft(e.currentTarget.value)}
                  placeholder={t("settings.saipen.home.placeholder")}
                  aria-label={t("settings.saipen.home.title")}
                />
                <button type="button" class="selector-button selector-button-secondary w-auto" onClick={commitHome} aria-label={`${t("settings.saipen.home.title")}: ${t("settings.saipen.save")}`}>
                  {t("settings.saipen.save")}
                </button>
                <button type="button" class="selector-button selector-button-secondary w-auto" onClick={cancelHome} aria-label={`${t("settings.saipen.home.title")}: ${t("settings.saipen.cancel")}`}>
                  {t("settings.saipen.cancel")}
                </button>
              </div>
            </Show>
          </div>

          <div class="settings-toggle-row settings-toggle-row-compact">
            <div>
              <div class="settings-toggle-title">{t("settings.saipen.files.title")}</div>
              <div class="settings-toggle-caption">
                {files() || t("settings.saipen.files.default")}
              </div>
            </div>
            <Show
              when={editingFiles()}
              fallback={
                <button
                  type="button"
                  class="selector-button selector-button-secondary w-auto whitespace-nowrap"
                  onClick={beginEditFiles}
                  aria-label={`${t("settings.saipen.files.title")}: ${t("settings.saipen.edit")}`}
                >
                  {t("settings.saipen.edit")}
                </button>
              }
            >
              <div class="settings-toolbar-inline">
                <input
                  type="text"
                  class="selector-input w-full"
                  value={filesDraft()}
                  onInput={(e) => setFilesDraft(e.currentTarget.value)}
                  placeholder={t("settings.saipen.files.placeholder")}
                  aria-label={t("settings.saipen.files.title")}
                />
                <button type="button" class="selector-button selector-button-secondary w-auto" onClick={commitFiles} aria-label={`${t("settings.saipen.files.title")}: ${t("settings.saipen.save")}`}>
                  {t("settings.saipen.save")}
                </button>
                <button type="button" class="selector-button selector-button-secondary w-auto" onClick={cancelFiles} aria-label={`${t("settings.saipen.files.title")}: ${t("settings.saipen.cancel")}`}>
                  {t("settings.saipen.cancel")}
                </button>
              </div>
            </Show>
          </div>
          <Show when={saveError()}>{(message) => <div class="settings-error-message" role="alert">{t("settings.saipen.saveError", { error: message() })}</div>}</Show>
        </div>
      </div>
    </div>
  )
}
