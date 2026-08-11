import { For, Show, createSignal, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { resolveQueueHint } from "../lib/prompt-queue-hint"
import { resolveQueueLayout } from "../lib/prompt-queue-layout"
import { resolvePastedTextPlaceholders } from "../lib/prompt-display-metadata"
import {
  clearQueue,
  getQueue,
  isQueuePaused,
  moveQueuedPrompt,
  removeQueuedPrompt,
  toggleQueuePaused,
  updateQueuedPrompt,
} from "../stores/prompt-queue"
import { promptQueueExpanded, setPromptQueueExpanded } from "../stores/ui"
import { getLogger } from "../lib/logger"

const log = getLogger("actions")

interface PromptQueuePanelProps {
  instanceId: string
  sessionId: string
  queueEnabled: boolean
  onToggleQueueEnabled: () => void
  /** True while the session is working; only changes the hint text. */
  sessionBusy?: boolean
  /** Sends the head of the queue immediately, bypassing the idle wait. */
  onSendNext?: () => void
  /** Queue drain mode: one at a time (separately) or everything at once (all). */
  sendMode?: "separately" | "all"
  onToggleSendMode?: () => void
}

/**
 * The queue, shown as a list the user can act on.
 *
 * Collapsed by default: the panel body has a fixed height and only the header
 * is always visible, so automatic enqueues (Goal Auto) never take height from
 * the message list. The user expands it on demand; it never expands by itself,
 * and the expanded body keeps one height whether it holds 1 entry or 40.
 */
const PromptQueuePanel: Component<PromptQueuePanelProps> = (props) => {
  const { t } = useI18n()
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal("")

  const items = () => getQueue(props.instanceId, props.sessionId)
  const paused = () => isQueuePaused(props.instanceId, props.sessionId)
  const layout = () =>
    resolveQueueLayout({ expanded: promptQueueExpanded(), pending: items().length })
  const hintKey = () =>
    resolveQueueHint({
      paused: paused(),
      sessionBusy: Boolean(props.sessionBusy),
      pending: items().length,
      queueEnabled: props.queueEnabled,
    })

  function beginEdit(id: string, text: string, attachments: Parameters<typeof resolvePastedTextPlaceholders>[1]) {
    setEditingId(id)
    setDraft(resolvePastedTextPlaceholders(text, attachments))
  }

  /** Fires a server mutation without letting a network failure become noise. */
  function runQuietly(action: () => Promise<unknown>) {
    void action().catch((error) => log.error("Queue action failed:", error))
  }

  function commitEdit(id: string) {
    runQuietly(() => updateQueuedPrompt(props.instanceId, props.sessionId, id, draft()))
    setEditingId(null)
    setDraft("")
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft("")
  }

  return (
      <section class="prompt-queue" data-state={layout().state} aria-label={t("promptQueue.title")}>
        <header class="prompt-queue-header">
          <div
            class="prompt-queue-toggle"
            onClick={() => setPromptQueueExpanded(!promptQueueExpanded())}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                setPromptQueueExpanded(!promptQueueExpanded())
              }
            }}
            aria-expanded={promptQueueExpanded()}
            aria-controls="prompt-queue-body"
            title={promptQueueExpanded() ? t("promptQueue.hide") : t("promptQueue.show")}
          >
            <span class="prompt-queue-title">{t("promptQueue.title")}</span>
            <span class="prompt-queue-count">{t("promptQueue.count", { count: items().length })}</span>
            <span
              class="prompt-queue-preview"
            >
              {items().map((item) => item.text).join(", ")}
            </span>
            <Show when={paused()}>
              <span class="prompt-queue-state">{t("promptQueue.paused")}</span>
            </Show>
          </div>
          <div class="prompt-queue-actions">
            <button
              type="button"
              class="queue-mode-toggle"
              data-enabled={props.queueEnabled ? "true" : "false"}
              aria-pressed={props.queueEnabled}
              onClick={props.onToggleQueueEnabled}
            >
              {props.queueEnabled ? t("promptQueue.mode.queued") : t("promptQueue.mode.direct")}
            </button>
            <Show when={props.onToggleSendMode}>
              <button
                type="button"
                class="prompt-queue-send-mode"
                data-all={props.sendMode === "all" ? "true" : "false"}
                onClick={() => props.onToggleSendMode?.()}
                title={t(props.sendMode === "all" ? "promptQueue.sendMode.allHint" : "promptQueue.sendMode.separatelyHint")}
                aria-pressed={props.sendMode === "all"}
              >
                {t(props.sendMode === "all" ? "promptQueue.sendMode.separately" : "promptQueue.sendMode.all")}
              </button>
            </Show>
            <Show when={props.onSendNext}>
              <button
                type="button"
                onClick={() => props.onSendNext?.()}
                disabled={items().length === 0}
                title={t("promptQueue.sendNext")}
              >
                {t("promptQueue.sendNext")}
              </button>
            </Show>
            <button
              type="button"
              onClick={() => runQuietly(() => toggleQueuePaused(props.instanceId, props.sessionId))}
              title={paused() ? t("promptQueue.resume") : t("promptQueue.pause")}
            >
              {paused() ? t("promptQueue.resume") : t("promptQueue.pause")}
            </button>
            <button
              type="button"
              onClick={() => runQuietly(() => clearQueue(props.instanceId, props.sessionId))}
              disabled={items().length === 0}
              title={t("promptQueue.clear")}
            >
              {t("promptQueue.clear")}
            </button>
          </div>
        </header>

        <div id="prompt-queue-body" class="prompt-queue-body" style={{ height: `${layout().bodyHeightPx}px` }}>
          <Show
            when={items().length > 0}
            fallback={<p class="prompt-queue-empty">{t("promptQueue.empty")}</p>}
          >
            <ol class="prompt-queue-list">
              <For each={items()}>
                {(item, index) => (
                  <li class="prompt-queue-item" data-next={index() === 0 ? "true" : "false"}>
                    <span class="prompt-queue-index">{index() + 1}.</span>

                    <Show
                      when={editingId() === item.id}
                      fallback={
                        <span class="prompt-queue-text">
                          {item.text}
                          <Show when={item.attachments.length > 0}>
                            <span class="prompt-queue-meta">
                              {" "}
                              {t("promptQueue.attachments", { count: item.attachments.length })}
                            </span>
                          </Show>
                        </span>
                      }
                    >
                      <textarea
                        class="prompt-queue-edit"
                        value={draft()}
                        onInput={(event) => setDraft(event.currentTarget.value)}
                      />
                    </Show>

                    <div class="prompt-queue-item-actions">
                      <Show
                        when={editingId() === item.id}
                        fallback={
                          <>
                            <button
                              type="button"
                              onClick={() => runQuietly(() => moveQueuedPrompt(props.instanceId, props.sessionId, item.id, -1))}
                              disabled={index() === 0}
                              title={t("promptQueue.moveUp")}
                              aria-label={t("promptQueue.moveUp")}
                            >
                              ^
                            </button>
                            <button
                              type="button"
                              onClick={() => runQuietly(() => moveQueuedPrompt(props.instanceId, props.sessionId, item.id, 1))}
                              disabled={index() === items().length - 1}
                              title={t("promptQueue.moveDown")}
                              aria-label={t("promptQueue.moveDown")}
                            >
                              v
                            </button>
                            <button
                              type="button"
                              onClick={() => beginEdit(item.id, item.text, item.attachments)}
                              title={t("promptQueue.edit")}
                            >
                              {t("promptQueue.edit")}
                            </button>
                            <button
                              type="button"
                              onClick={() => runQuietly(() => removeQueuedPrompt(props.instanceId, props.sessionId, item.id))}
                              title={t("promptQueue.remove")}
                              aria-label={t("promptQueue.remove")}
                            >
                              X
                            </button>
                          </>
                        }
                      >
                        <button type="button" onClick={() => commitEdit(item.id)} title={t("promptQueue.save")}>
                          {t("promptQueue.save")}
                        </button>
                        <button type="button" onClick={cancelEdit} title={t("promptQueue.cancel")}>
                          {t("promptQueue.cancel")}
                        </button>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </Show>

          {/* Rendered only when it adds something the empty-state above did not.
              Both slots used to be able to print `promptQueue.empty`. */}
          <Show when={hintKey()}>
            {(key) => <p class="prompt-queue-hint">{t(key())}</p>}
          </Show>
        </div>
      </section>
  )
}

export default PromptQueuePanel
