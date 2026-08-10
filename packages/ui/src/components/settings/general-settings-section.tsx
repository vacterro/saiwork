import { createMemo, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getBehaviorSettings, type BehaviorSetting } from "../../lib/settings/behavior-registry"
import { useConfig } from "../../stores/preferences"
import { LocaleSelector } from "../locale-selector"
import { BehaviorSettingRows } from "./behavior-setting-rows"
import { StartupStateSettingsCard } from "./startup-state-settings-card"

export const GeneralSettingsSection: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const { updatePreferences } = config
  const generalSettings = createMemo<BehaviorSetting[]>(() => [
    ...getBehaviorSettings(config).filter(
      (setting) =>
        setting.id === "behavior.keyboardShortcutHints" ||
        setting.id === "behavior.messageTimeline" ||
        setting.id === "behavior.timelineToolCalls" ||
        setting.id === "behavior.diffViewMode" ||
        setting.id === "behavior.promptSubmitOnEnter" ||
        setting.id === "behavior.queueEnabled",
    ),
    {
      kind: "toggle",
      id: "behavior.holdLongAssistantReplies",
      titleKey: "settings.behavior.holdLongAssistantReplies.title",
      subtitleKey: "settings.behavior.holdLongAssistantReplies.subtitle",
      get: (current) => Boolean(current.holdLongAssistantReplies ?? true),
      set: (next) => updatePreferences({ holdLongAssistantReplies: next }),
    },
  ])

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("folderSelection.language.ariaLabel")}</h3>
            <p class="settings-card-subtitle">{t("settings.general.language.subtitle")}</p>
          </div>
          <span class="settings-scope-badge">{t("settings.scope.device")}</span>
        </div>
        <LocaleSelector />
      </div>

      <StartupStateSettingsCard />

      <div class="settings-card">
        <div class="settings-stack">
          <BehaviorSettingRows settings={generalSettings} preferences={config.preferences} />
        </div>
      </div>
    </div>
  )
}
