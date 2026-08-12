import { Component, For, Show, createMemo, createSignal } from "solid-js"
import { Github, Loader2 } from "lucide-solid"
import type { Instance } from "../types/instance"
import { useOptionalInstanceMetadataContext } from "../lib/contexts/instance-metadata-context"
import InstanceServiceStatus from "./instance-service-status"
import { useI18n } from "../lib/i18n"
import { useConfig } from "../stores/preferences"
import { showConfirmDialog } from "../stores/alerts"
import { disposeInstance } from "../stores/instances"
import { showToastNotification } from "../lib/notifications"
import { getLogger } from "../lib/logger"

interface InstanceInfoProps {
  instance: Instance
  compact?: boolean
  showDisposeButton?: boolean
}

const log = getLogger("actions")

const InstanceInfo: Component<InstanceInfoProps> = (props) => {
  const { t } = useI18n()
  const { isSecureEnvVar } = useConfig()
  const metadataContext = useOptionalInstanceMetadataContext()
  const isLoadingMetadata = metadataContext?.isLoading ?? (() => false)
  const instanceAccessor = metadataContext?.instance ?? (() => props.instance)
  const metadataAccessor = metadataContext?.metadata ?? (() => props.instance.metadata)

  const [isDisposing, setIsDisposing] = createSignal(false)

  const currentInstance = () => instanceAccessor()
  const metadata = () => metadataAccessor()
  const binaryVersion = () => currentInstance().binaryVersion || metadata()?.version
  const environmentVariables = () => currentInstance().environmentVariables
  const environmentEntries = createMemo(() => {
    const env = environmentVariables()
    return env ? Object.entries(env) : []
  })

  const disposeEnabled = createMemo(() => Boolean(currentInstance()?.client) && !isDisposing())

  const handleDisposeInstance = async () => {
    if (!disposeEnabled()) return

    const confirmed = await showConfirmDialog(t("infoView.dispose.confirm.message"), {
      title: t("infoView.dispose.confirm.title"),
      variant: "warning",
      confirmLabel: t("infoView.dispose.confirm.confirmLabel"),
      cancelLabel: t("infoView.dispose.confirm.cancelLabel"),
      dismissible: false,
    })

    if (!confirmed) return

    setIsDisposing(true)
    try {
      const ok = await disposeInstance(currentInstance().id)
      if (ok) {
        showToastNotification({
          message: t("infoView.dispose.toast.success"),
          variant: "success",
          duration: 8000,
        })
      } else {
        showToastNotification({
          message: t("infoView.dispose.toast.error"),
          variant: "error",
        })
      }
    } catch (error) {
      log.error("Failed to dispose instance", error)
      showToastNotification({
        message: t("infoView.dispose.toast.error"),
        variant: "error",
      })
    } finally {
      setIsDisposing(false)
    }
  }

  return (
    <div class="panel">
      <div class="panel-header">
        <h2 class="panel-title">{t("instanceInfo.title")}</h2>
      </div>
      <div class="panel-body space-y-3">
        <div>
          <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">{t("instanceInfo.labels.folder")}</div>
          <div dir="ltr" class="text-xs text-primary font-mono break-all px-2 py-1.5 rounded border bg-surface-secondary border-base">
            {currentInstance().folder}
          </div>
        </div>

        <Show when={!isLoadingMetadata() && metadata()?.project}>
          {(project) => (
            <>
              <div>
                <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                  {t("instanceInfo.labels.project")}
                </div>
                <div dir="ltr" class="text-xs font-mono px-2 py-1.5 rounded border truncate bg-surface-secondary border-base text-primary">
                  {project().id}
                </div>
              </div>

              <Show when={project().vcs}>
                <div>
                  <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                    {t("instanceInfo.labels.versionControl")}
                  </div>
                  <div class="flex items-center gap-2 text-xs text-primary">
                    <Github class="w-3.5 h-3.5" style="color: var(--status-warning);" />
                    <span class="capitalize">{project().vcs}</span>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>

        <Show when={binaryVersion()}>
          <div>
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              {t("instanceInfo.labels.opencodeVersion")}
            </div>
            <div class="text-xs px-2 py-1.5 rounded border bg-surface-secondary border-base text-primary">
              v{binaryVersion()}
            </div>
          </div>
        </Show>

        <Show when={currentInstance().binaryPath}>
          <div>
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
              {t("instanceInfo.labels.binaryPath")}
            </div>
            <div dir="ltr" class="text-xs font-mono break-all px-2 py-1.5 rounded border bg-surface-secondary border-base text-primary">
              {currentInstance().binaryPath}
            </div>
          </div>
        </Show>

        <Show when={environmentEntries().length > 0}>
          <div>
            <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">
              {t("instanceInfo.labels.environmentVariables", { count: environmentEntries().length })}
            </div>
            <div class="space-y-1">
              <For each={environmentEntries()}>
                {([key, value]) => (
                  <div dir="ltr" class="flex items-center gap-2 px-2 py-1.5 rounded border bg-surface-secondary border-base">
                    <span class="text-xs font-mono font-medium flex-1 text-primary" title={key}>
                      {key}
                    </span>
                    <span class="text-xs font-mono flex-1 text-secondary" title={isSecureEnvVar(key) ? t("envEditor.fields.secure.masked") : value}>
                      {isSecureEnvVar(key) ? "***" : value}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <InstanceServiceStatus initialInstance={props.instance} class="space-y-3" />

        <Show when={isLoadingMetadata()}>
          <div class="text-xs text-muted py-1">
            <div class="flex items-center gap-1.5">
              <Loader2 class="animate-spin h-3 w-3 icon-muted" />
              {t("instanceInfo.loading")}
            </div>
          </div>
        </Show>

        <div>
          <div class="text-xs font-medium text-muted uppercase tracking-wide mb-1.5">{t("instanceInfo.server.title")}</div>
          <div class="space-y-1 text-xs">
            <div class="flex justify-between items-center">
              <span class="text-secondary">{t("instanceInfo.server.port")}</span>
              <span class="text-primary font-mono">{currentInstance().port}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary">{t("instanceInfo.server.pid")}</span>
              <span class="text-primary font-mono">{currentInstance().pid}</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary">{t("instanceInfo.server.status")}</span>
              <span class={`status-badge ${currentInstance().status}`}>
                <div
                  class={`status-dot ${currentInstance().status === "ready" ? "ready" : currentInstance().status === "starting" ? "starting" : currentInstance().status === "error" ? "error" : "stopped"} ${currentInstance().status === "ready" || currentInstance().status === "starting" ? "animate-pulse" : ""}`}
                />
                {currentInstance().status}
              </span>
            </div>
          </div>
        </div>

        <Show when={props.showDisposeButton}>
          <div class="pt-3 border-t border-base">
            <button
              type="button"
              class="button-danger button-small w-full"
              onClick={handleDisposeInstance}
              disabled={!disposeEnabled()}
            >
              {isDisposing() ? t("infoView.dispose.actions.disposing") : t("infoView.dispose.actions.dispose")}
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default InstanceInfo
