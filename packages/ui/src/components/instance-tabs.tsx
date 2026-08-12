import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent as SolidDndDragEvent,
} from "@thisbeyond/solid-dnd"
import InstanceTab, { getInstanceTabLabel } from "./instance-tab"
import KeyboardHint from "./keyboard-hint"
import ToastHistoryPanel from "./toast-history-panel"
import { Plus, MonitorUp, Bell, BellOff, Settings, X } from "lucide-solid"
import { keyboardRegistry } from "../lib/keyboard-registry"
import { useI18n } from "../lib/i18n"
import { isOsNotificationSupportedSync } from "../lib/os-notifications"
import { canOpenRemoteWindows } from "../lib/runtime-env"
import { getUnreadToastCountSignal } from "../lib/notifications"
import { useConfig } from "../stores/preferences"
import { openSettings } from "../stores/settings-screen"
import type { AppTabRecord } from "../stores/app-tabs"
import ActionOverflowMenu, { type ActionOverflowMenuItem } from "./action-overflow-menu"
import { getOverflowTabIds } from "./instance-tabs-overflow"

interface InstanceTabsProps {
  tabs: AppTabRecord[]
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  onNew: () => void
  onMoveTab: (tabId: string, targetTabId: string, placement: "before" | "after") => void
}

interface SortableAppTabProps {
  tab: AppTabRecord
  activeTabId: string | null
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
  hidden?: boolean
}

const AppTabContent: Component<SortableAppTabProps> = (props) => {
  return (
    <>
      {props.tab.kind === "instance" ? (
        <InstanceTab
          instance={props.tab.instance}
          active={props.tab.id === props.activeTabId}
          onSelect={() => props.onSelect(props.tab.id)}
          onClose={() => props.onClose(props.tab.id)}
          hidden={props.hidden}
        />
      ) : (
        <div
          class={`tab-pill ${props.tab.id === props.activeTabId ? "tab-pill-active" : ""}`}
          role="tab"
          tabIndex={props.hidden ? -1 : 0}
          aria-selected={props.tab.id === props.activeTabId}
          onClick={() => props.onSelect(props.tab.id)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            props.onSelect(props.tab.id)
          }}
        >
          <span class="tab-pill-button">
            <span class="truncate max-w-[180px]">{props.tab.sidecarTab.name}</span>
          </span>
          <button
            class="tab-pill-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              props.onClose(props.tab.id)
            }}
            aria-label={props.tab.sidecarTab.name}
            tabIndex={props.hidden ? -1 : undefined}
          >
            <X class="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}

const SortableAppTab: Component<SortableAppTabProps> = (props) => {
  const sortable = createSortable(props.tab.id)

  return (
    <div
      ref={sortable}
      class={`tab-draggable ${sortable.isActiveDraggable ? "tab-draggable-active" : ""}`}
      data-app-tab-id={props.tab.id}
    >
      <AppTabContent {...props} />
    </div>
  )
}

const StaticAppTab: Component<SortableAppTabProps> = (props) => {
  return (
    <div class="tab-draggable" data-app-tab-id={props.tab.id}>
      <AppTabContent {...props} />
    </div>
  )
}

const isTouchOnlyPointer = () => {
  if (typeof window === "undefined") return false
  return Boolean(window.matchMedia?.("(pointer: coarse)")?.matches && !window.matchMedia?.("(any-pointer: fine)")?.matches)
}

const InstanceTabs: Component<InstanceTabsProps> = (props) => {
  const { t } = useI18n()
  const { preferences } = useConfig()
  const tabIds = createMemo(() => props.tabs.map((tab) => tab.id))
  const [dragReorderEnabled, setDragReorderEnabled] = createSignal(!isTouchOnlyPointer())

  onMount(() => {
    if (typeof window === "undefined") return
    const coarseQuery = window.matchMedia?.("(pointer: coarse)")
    const fineQuery = window.matchMedia?.("(any-pointer: fine)")
    if (!coarseQuery || !fineQuery) return

    const syncDragReorder = () => setDragReorderEnabled(!isTouchOnlyPointer())
    syncDragReorder()
    coarseQuery.addEventListener("change", syncDragReorder)
    fineQuery.addEventListener("change", syncDragReorder)

    onCleanup(() => {
      coarseQuery.removeEventListener("change", syncDragReorder)
      fineQuery.removeEventListener("change", syncDragReorder)
    })
  })

  /** Whether to show toast history panel */
  const [showToastHistory, setShowToastHistory] = createSignal(false)

  let tabScrollRef: HTMLDivElement | undefined
  let tabStripRef: HTMLDivElement | undefined
  const tabUnitRefs = new Map<string, HTMLDivElement>()
  const tabUnitWidths = new Map<string, number>()
  const [overflowTabIds, setOverflowTabIds] = createSignal<ReadonlySet<string>>(new Set())
  let tabResizeObserver: ResizeObserver | undefined
  let measureFrame = 0

  const isOverflowed = (tabId: string) => overflowTabIds().has(tabId)
  const registerTabUnit = (tabId: string) => (element: HTMLDivElement) => {
    const previous = tabUnitRefs.get(tabId)
    if (previous && previous !== element) tabResizeObserver?.unobserve(previous)
    tabUnitRefs.set(tabId, element)
    tabResizeObserver?.observe(element)
  }

  const measureOverflow = () => {
    measureFrame = 0
    if (!tabScrollRef) return
    const container = tabScrollRef.parentElement
    const trigger = container?.querySelector<HTMLElement>(".tab-overflow-trigger")
    const containerGap = container ? Number.parseFloat(getComputedStyle(container).columnGap) || 0 : 0
    const availableWidth = tabScrollRef.clientWidth
    const fullWidth = availableWidth + (trigger ? trigger.getBoundingClientRect().width + containerGap : 0)
    const gap = tabStripRef ? Number.parseFloat(getComputedStyle(tabStripRef).columnGap) || 0 : 0
    const measurements = props.tabs.flatMap((tab) => {
      const element = tabUnitRefs.get(tab.id)
      if (!element) return []
      const measuredWidth = element.getBoundingClientRect().width
      if (measuredWidth > 0) tabUnitWidths.set(tab.id, measuredWidth)
      const width = tabUnitWidths.get(tab.id)
      return width ? [{ id: tab.id, width }] : []
    })
    const overflowWithoutTrigger = getOverflowTabIds(measurements, fullWidth, props.activeTabId, gap)
    const next = new Set(
      overflowWithoutTrigger.length === 0
        ? []
        : getOverflowTabIds(measurements, availableWidth, props.activeTabId, gap),
    )
    setOverflowTabIds((current) => {
      if (current.size === next.size && Array.from(current).every((id) => next.has(id))) return current
      return next
    })
  }

  const scheduleOverflowMeasure = () => {
    cancelAnimationFrame(measureFrame)
    measureFrame = requestAnimationFrame(measureOverflow)
  }

  createEffect(() => {
    const liveIds = new Set(props.tabs.map((tab) => tab.id))
    for (const [tabId, element] of tabUnitRefs) {
      if (liveIds.has(tabId)) continue
      tabResizeObserver?.unobserve(element)
      tabUnitRefs.delete(tabId)
      tabUnitWidths.delete(tabId)
    }
    props.activeTabId
    scheduleOverflowMeasure()
  })

  onMount(() => {
    tabResizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleOverflowMeasure)
    if (tabScrollRef) tabResizeObserver?.observe(tabScrollRef)
    for (const element of tabUnitRefs.values()) tabResizeObserver?.observe(element)
    window.addEventListener("resize", scheduleOverflowMeasure)
    scheduleOverflowMeasure()

    onCleanup(() => {
      cancelAnimationFrame(measureFrame)
      tabResizeObserver?.disconnect()
      window.removeEventListener("resize", scheduleOverflowMeasure)
    })
  })

  const overflowMenuItems = createMemo<ActionOverflowMenuItem[]>(() => {
    const hidden = overflowTabIds()
    return props.tabs
      .filter((tab) => hidden.has(tab.id))
      .map((tab) => ({
        key: tab.id,
        label: tab.kind === "instance" ? getInstanceTabLabel(tab.instance) : tab.sidecarTab.name,
        checked: tab.id === props.activeTabId,
        onSelect: () => props.onSelect(tab.id),
      }))
  })

  const notificationsSupported = createMemo(() => isOsNotificationSupportedSync())
  const notificationsEnabled = createMemo(() => Boolean(preferences().osNotificationsEnabled))
  const notificationIcon = createMemo(() => {
    if (!notificationsSupported()) return BellOff
    return notificationsEnabled() ? Bell : BellOff
  })

  /** Unread notification count (reactive signal) */
  const unreadCount = getUnreadToastCountSignal()

  const notificationTitle = createMemo(() => {
    if (!notificationsSupported()) return t("settings.notifications.status.unsupported")
    return notificationsEnabled()
      ? t("settings.notifications.status.enabled")
      : t("settings.notifications.status.disabled")
  })

  const handleDragEnd = ({ draggable, droppable }: SolidDndDragEvent) => {
    if (!droppable) return

    const tabId = String(draggable.id)
    const targetTabId = String(droppable.id)
    if (tabId === targetTabId) return

    const fromIndex = props.tabs.findIndex((tab) => tab.id === tabId)
    const toIndex = props.tabs.findIndex((tab) => tab.id === targetTabId)
    if (fromIndex < 0 || toIndex < 0) return

    props.onMoveTab(tabId, targetTabId, fromIndex < toIndex ? "after" : "before")
  }

  return (
    <>
      <div class="tab-bar tab-bar-instance">
        <div class="tab-container">
          <div class="tab-scroll" ref={tabScrollRef} role="tablist">
            <div class="tab-strip-tabs" ref={tabStripRef}>
                <Show
                  when={dragReorderEnabled()}
                  fallback={
                    <For each={props.tabs}>
                      {(tab) => (
                        <div
                          class="tab-overflow-unit"
                          ref={registerTabUnit(tab.id)}
                          data-overflow-hidden={isOverflowed(tab.id) ? "true" : undefined}
                          aria-hidden={isOverflowed(tab.id)}
                        >
                          <StaticAppTab
                            tab={tab}
                            activeTabId={props.activeTabId}
                            onSelect={props.onSelect}
                            onClose={props.onClose}
                            hidden={isOverflowed(tab.id)}
                          />
                        </div>
                      )}
                    </For>
                  }
                >
                  <DragDropProvider collisionDetector={closestCenter} onDragEnd={handleDragEnd}>
                    <DragDropSensors>
                      <SortableProvider ids={tabIds()}>
                        <For each={props.tabs}>
                          {(tab) => (
                            <div
                              class="tab-overflow-unit"
                              ref={registerTabUnit(tab.id)}
                              data-overflow-hidden={isOverflowed(tab.id) ? "true" : undefined}
                              aria-hidden={isOverflowed(tab.id)}
                            >
                              <SortableAppTab
                                tab={tab}
                                activeTabId={props.activeTabId}
                                onSelect={props.onSelect}
                                onClose={props.onClose}
                                hidden={isOverflowed(tab.id)}
                              />
                            </div>
                          )}
                        </For>
                      </SortableProvider>
                    </DragDropSensors>
                  </DragDropProvider>
                </Show>
            </div>
          </div>

          <ActionOverflowMenu
            items={overflowMenuItems()}
            label={t("instanceTabs.more.ariaLabel")}
            triggerClass="tab-overflow-trigger"
          />

          <div class="tab-bar-actions">
            <Show when={props.tabs.length > 1}>
              <div class="tab-shortcuts">
                <KeyboardHint
                  shortcuts={[keyboardRegistry.get("instance-prev")!, keyboardRegistry.get("instance-next")!].filter(
                    Boolean,
                  )}
                />
              </div>
            </Show>

            <button
                class="new-tab-button"
                onClick={props.onNew}
                title={t("instanceTabs.new.title")}
                aria-label={t("instanceTabs.new.ariaLabel")}
              >
                <Plus class="w-4 h-4" />
            </button>

            <button
                class="new-tab-button"
                onClick={() => openSettings("general")}
                title={t("settings.open.title")}
                aria-label={t("settings.open.ariaLabel")}
              >
                <Settings class="w-4 h-4" />
            </button>

              {/* Notification Button */}
            <div class="relative">
                <button
                  class={`new-tab-button ${!notificationsSupported() ? "opacity-50" : ""}`}
                  onClick={() => setShowToastHistory(true)}
                  title={notificationTitle()}
                  aria-label={notificationTitle()}
                >
                  <Dynamic component={notificationIcon()} class="w-4 h-4" />
                </button>
                {/* Unread badge */}
                <Show when={unreadCount() > 0}>
                  <span
                    class="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                    aria-label={t("toastHistory.unread", { count: unreadCount() })}
                  >
                    {unreadCount() > 9 ? "9+" : unreadCount()}
                  </span>
                </Show>
            </div>

            <Show when={canOpenRemoteWindows()}>
              <button
                  class="new-tab-button tab-remote-button"
                  onClick={() => openSettings("remote")}
                  title={t("instanceTabs.remote.title")}
                  aria-label={t("instanceTabs.remote.ariaLabel")}
                >
                  <MonitorUp class="w-4 h-4" />
              </button>
            </Show>
          </div>
        </div>
      </div>

      {/* Toast History Panel */}
      <Show when={showToastHistory()}>
        <ToastHistoryPanel
          onClose={() => setShowToastHistory(false)}
          onOpenSettings={() => {
            setShowToastHistory(false)
            openSettings("notifications")
          }}
        />
      </Show>
    </>
  )
}

export default InstanceTabs
