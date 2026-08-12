import { Component, Show, createMemo } from "solid-js"
import type { Instance } from "../types/instance"
import { getInstanceIdleFadeClass, getInstanceSessionIndicatorStatus } from "../stores/session-status"
import { FolderOpen, ShieldAlert, X } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { useConfig } from "../stores/preferences"
import { useNow } from "../lib/hooks/use-now"

interface InstanceTabProps {
  instance: Instance
  active: boolean
  onSelect: () => void
  onClose: () => void
  hidden?: boolean
}

function getPathBasename(path: string): string {
  // Instance folders can be POSIX-like (/Users/...) on macOS/Linux or Windows-like (C:\Users\...).
  // Normalize by trimming trailing separators and then splitting on both '/' and '\\'.
  const normalized = path.replace(/[\\/]+$/, "")
  return normalized.split(/[\\/]/).pop() || path
}

export function getInstanceTabLabel(instance: Instance): string {
  return instance.projectName?.trim() || getPathBasename(instance.folder)
}

const InstanceTab: Component<InstanceTabProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const now = useNow()

  const aggregatedStatus = createMemo(() =>
    getInstanceSessionIndicatorStatus(props.instance.id, now(), preferences().keepUnseenSubagentIdleStatus),
  )
  const statusClassName = createMemo(() => {
    const status = aggregatedStatus()
    if (!status) return null
    if (status === "permission") return "session-permission"
    const base = `session-${status}`
    const fadeClass =
      status === "idle" ? getInstanceIdleFadeClass(props.instance.id, now(), preferences().keepUnseenSubagentIdleStatus) : ""
    return fadeClass ? `${base} ${fadeClass}` : base
  })
  const statusTitle = createMemo(() => {
    switch (aggregatedStatus()) {
      case "permission":
        return t("instanceTab.status.permission")
      case "compacting":
        return t("instanceTab.status.compacting")
      case "working":
        return t("instanceTab.status.working")
      case "idle":
        return t("instanceTab.status.idle")
      default:
        return null
    }
  })
  const tabLabel = createMemo(() => getInstanceTabLabel(props.instance))

  return (
    <div class="group">
      <button
        class={`tab-base ${props.active ? "tab-active" : "tab-inactive"}`}
        onClick={props.onSelect}
        title={props.instance.folder}
        role="tab"
        aria-selected={props.active}
        tabIndex={props.hidden ? -1 : undefined}
      >
        <FolderOpen class="w-4 h-4 flex-shrink-0" />
        <span class="tab-label">
          {tabLabel()}
        </span>
        <Show when={statusClassName() && statusTitle()}>
          <span
            class={`status-indicator session-status ml-auto ${statusClassName()}`}
            title={statusTitle() ?? undefined}
            aria-label={t("instanceTab.status.ariaLabel", { status: statusTitle() ?? "" })}
          >
            {aggregatedStatus() === "permission" ? (
              <ShieldAlert class="w-3.5 h-3.5" aria-hidden="true" />
            ) : (
              <span class="status-dot" />
            )}
          </span>
        </Show>
        <Show when={props.instance.unreadGoalAuto && !props.active}>
          <span
            class="text-[9px] font-bold text-[#FFD700] ml-1 bg-black/40 px-1 py-0.5 rounded-sm border border-[#FFD700]/50"
            title="Goal Auto queued prompts in background"
          >
            CC
          </span>
        </Show>
        <span
          class="tab-close"
          onClick={(e) => {
            e.stopPropagation()
            props.onClose()
          }}
          onPointerDown={(e) => e.stopPropagation()}
          role="button"
          tabIndex={props.hidden ? -1 : 0}
          aria-label={t("instanceTab.actions.close.ariaLabel")}
        >
          <X class="w-3 h-3" />
        </span>
      </button>
    </div>
  )
}

export default InstanceTab
