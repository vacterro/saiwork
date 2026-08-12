import { Select } from "@kobalte/core/select"
import { ChevronDown } from "lucide-solid"
import { createMemo, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useTheme } from "../../lib/theme"
import { wintageThemes, type WintageTheme } from "../../lib/wintage-themes"
import { StartupStateSettingsCard } from "./startup-state-settings-card"

export const AppearanceSettingsSection: Component = () => {
  const { t } = useI18n()
  const { themeMode, setThemeMode } = useTheme()
  const selectedTheme = createMemo(
    () => wintageThemes.find((theme) => theme.slug === themeMode()) ?? wintageThemes.find((theme) => theme.slug === "goldendefault")!,
  )

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.appearance.theme.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.appearance.theme.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>

        <Select<WintageTheme>
          value={selectedTheme()}
          onChange={(theme) => theme && setThemeMode(theme.slug)}
          options={wintageThemes}
          optionValue="slug"
          optionTextValue="label"
          itemComponent={(props) => (
            <Select.Item item={props.item} class="selector-option">
              <Select.ItemLabel class="selector-option-label">{props.item.rawValue.label}</Select.ItemLabel>
            </Select.Item>
          )}
        >
          <Select.Trigger class="selector-trigger" aria-label={t("settings.appearance.theme.title")}>
            <div class="flex-1 min-w-0">
              <Select.Value<WintageTheme>>
                {(state) => <span class="selector-trigger-primary selector-trigger-primary--align-left">{state.selectedOption()?.label}</span>}
              </Select.Value>
            </div>
            <Select.Icon class="selector-trigger-icon">
              <ChevronDown class="w-3 h-3" />
            </Select.Icon>
          </Select.Trigger>

          <Select.Portal>
            <Select.Content class="selector-popover">
              <Select.Listbox class="selector-listbox" />
            </Select.Content>
          </Select.Portal>
        </Select>
      </div>

      <StartupStateSettingsCard />
    </div>
  )
}
