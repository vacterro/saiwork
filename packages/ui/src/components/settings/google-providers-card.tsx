import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Component } from "solid-js"

import { useI18n } from "../../lib/i18n"
import { serverApi } from "../../lib/api-client"
import { getLogger } from "../../lib/logger"
import { useConfig } from "../../stores/preferences"
import type { GoogleProvidersStatusResponse, GoogleProviderInfo } from "../../../../server/src/api-types"

const log = getLogger("google")

type StatusLabel = "ready" | "auth_required" | "not_configured" | "plugin_missing" | "unavailable"

const STATUS_ORDER: StatusLabel[] = ["ready", "auth_required", "not_configured", "plugin_missing", "unavailable"]

const STATUS_CLASS: Record<StatusLabel, string> = {
  ready: "text-primary",
  auth_required: "text-secondary",
  not_configured: "text-secondary",
  plugin_missing: "text-tertiary",
  unavailable: "text-tertiary",
}

export const GoogleProvidersCard: Component = () => {
  const { t } = useI18n()
  const config = useConfig()
  const { preferences, updatePreferences } = config
  const [providers, setProviders] = createSignal<GoogleProvidersStatusResponse | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await serverApi.fetchGoogleProviders()
      setProviders(next)
    } catch (cause) {
      log.error("Failed to load Google provider status", cause)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void refresh()
  })
  onCleanup(() => undefined)

  const sortedProviders = createMemo(() => {
    const list = providers()?.providers ?? []
    const rank = (status: string) => STATUS_ORDER.indexOf(status as StatusLabel)
    return [...list].sort((a, b) => rank(a.status) - rank(b.status) || (a.experimental === b.experimental ? 0 : a.experimental ? 1 : -1))
  })

  const fallbackEnabled = () => preferences().allowProviderFallback === true
  const antigravityAcknowledged = () => preferences().antigravityAcknowledged === true

  const acknowledgeAntigravity = () => {
    updatePreferences({ antigravityAcknowledged: true })
    void serverApi.patchGoogleSettings({ antigravityAcknowledged: true }).catch((cause) => log.error("Failed to persist ack", cause))
  }

  const toggleFallback = () => {
    const next = !fallbackEnabled()
    updatePreferences({ allowProviderFallback: next })
    void serverApi.patchGoogleSettings({ allowProviderFallback: next }).catch((cause) => log.error("Failed to persist fallback", cause))
  }

  const showRiskAck = () =>
    !antigravityAcknowledged() && sortedProviders().some((p) => p.id === "google_antigravity" && p.status !== "unavailable")

  return (
    <div class="settings-card">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">{t("settings.google.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.google.subtitle")}</p>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class="settings-scope-badge" onClick={() => void refresh()}>
            {t("settings.google.refresh")}
          </button>
        </div>
      </div>

      <Show when={error()} keyed>
        {(message) => <p class="settings-error-message">{message}</p>}
      </Show>

      <Show when={loading() && !providers()} fallback={
        <div class="settings-stack">
          <For each={sortedProviders()}>
            {(provider) => <GoogleProviderRow t={t} provider={provider} />}
          </For>
        </div>
      }>
        <p class="settings-card-subtitle">{t("settings.google.loading")}</p>
      </Show>

      <Show when={showRiskAck()}>
        <div class="settings-toggle-row">
          <div class="min-w-0">
            <div class="settings-toggle-title">{t("settings.google.antigravityRisk.title")}</div>
            <div class="settings-toggle-caption">{t("settings.google.antigravityRisk.caption")}</div>
          </div>
          <button type="button" class="shrink-0" onClick={acknowledgeAntigravity}>
            {t("settings.google.acknowledge")}
          </button>
        </div>
      </Show>

      <div class="settings-toggle-row">
        <div class="min-w-0">
          <div class="settings-toggle-title">{t("settings.google.fallback.title")}</div>
          <div class="settings-toggle-caption">{t("settings.google.fallback.caption")}</div>
        </div>
        <label class="settings-checkbox-toggle">
          <input
            type="checkbox"
            checked={fallbackEnabled()}
            onChange={toggleFallback}
            aria-label={t("settings.google.fallback.title")}
          />
          <span>{fallbackEnabled() ? t("settings.common.enabled") : t("settings.common.disabled")}</span>
        </label>
      </div>
    </div>
  )
}

interface GoogleProviderRowProps {
  t: (key: string, vars?: Record<string, any>) => string
  provider: GoogleProviderInfo
}

const GoogleProviderRow: Component<GoogleProviderRowProps> = (props) => {
  const status = () => props.provider.status as StatusLabel
  return (
    <div class="settings-toggle-row">
      <div class="min-w-0">
        <div class="settings-toggle-title">
          <span>{props.provider.name}</span>
          {props.provider.experimental ? (
            <span class="text-xs text-secondary"> · {props.t("settings.google.experimental")}</span>
          ) : (
            <span class="text-xs text-tertiary"> · {props.t("settings.google.official")}</span>
          )}
        </div>
        <div class="settings-toggle-caption">{props.provider.description}</div>
        <Show when={props.provider.detail}>
          <div class="settings-toggle-caption">{props.provider.detail}</div>
        </Show>
      </div>
      <div class="shrink-0 text-right">
        <div class={`text-xs ${STATUS_CLASS[status()]}`}>{props.t(`settings.google.status.${props.provider.status}`)}</div>
        <div class="text-[10px] text-tertiary">{props.provider.modelCount} {props.t("settings.google.models")}</div>
      </div>
    </div>
  )
}
