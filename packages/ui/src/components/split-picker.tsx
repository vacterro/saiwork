import { Component, createEffect, For, Show } from "solid-js"
import { useI18n } from "../lib/i18n"
import type { SplitPickCandidate } from "../lib/split-picker"

interface SplitPickerProps {
  open: boolean
  candidates: SplitPickCandidate[]
  onPick: (candidate: SplitPickCandidate) => void
  onClose: () => void
}

/**
 * Shell-level split picker: a fixed top-right popup listing the sessions a
 * pane can show. Rendered at the shell level (not inside a hidden header) so
 * it never appears dead; a click-away backdrop closes it.
 */
const SplitPicker: Component<SplitPickerProps> = (props) => {
  const { t } = useI18n()

  let containerRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!props.open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    containerRef?.focus()
    return () => window.removeEventListener("keydown", onKeyDown)
  })

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50"
        role="presentation"
        onClick={() => props.onClose()}
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-label={t("saipenView.split")}
        tabIndex={-1}
        class="fixed top-2 right-2 z-50 min-w-[260px] max-w-[360px] modal-surface p-2"
        onClick={(event) => event.stopPropagation()}
      >
        <div class="px-2 py-1 text-sm font-medium text-secondary">
          {t("saipenView.split")}
        </div>
        <Show
          when={props.candidates.length > 0}
          fallback={
            <div class="px-2 py-3 text-sm text-muted text-center">
              {t("saipenView.noSplitTargets")}
            </div>
          }
        >
          <For each={props.candidates}>
            {(candidate) => (
              <button
                type="button"
                class="selector-option w-full text-left px-2 py-1.5 text-sm hover:bg-surface-hover focus:bg-surface-hover"
                onClick={() => props.onPick(candidate)}
              >
                <span class="block truncate">{candidate.title || t("sessionPicker.session.untitled")}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </Show>
  )
}

export default SplitPicker
