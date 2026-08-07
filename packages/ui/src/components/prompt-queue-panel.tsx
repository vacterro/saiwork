import { For, Show, createSignal, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import {
  clearQueue,
  getQueue,
  isQueuePaused,
  moveQueuedPrompt,
  removeQueuedPrompt,
  toggleQueuePaused,
  updateQueuedPrompt,
} from "../stores/prompt-queue"

interface PromptQueuePanelProps {
  instanceId: string
  sessionId: string
  /** True while the session is working; only changes the hint text. */
  sessionBusy?: boolean
  /** Sends the head of the queue immediately, bypassing the idle wait. */
  onSendNext?: () => void
}

/**
 * The queue, shown as a list the user can act on.
 *
 * Deliberately not collapsible-by-default and not auto-hiding: a queue the user
 * cannot see is a queue that will surprise them when it fires. The panel is
 * rendered only when there is something in it or the queue is paused, so an
 * unused queue costs no screen space.
 */
const PromptQueuePanel: Component<PromptQueuePanelProps> = (props) => {
  const { t } = useI18n()
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal("")

  const items = () => getQueue(props.instanceId, props.sessionId)
  const paused = () => isQueuePaused(props.instanceId, props.sessionId)

  function beginEdit(id: string, text: string) {
    setEditingId(id)
    setDraft(text)
  }

  function commitEdit(id: string) {
    updateQueuedPrompt(props.instanceId, props.sessionId, id, draft())
    setEditingId(null)
    setDraft("")
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft("")
  }

  return (
    <Show when={items().length > 0 || paused()}>
      <section class="prompt-queue" aria-label={t("promptQueue.title")}>
        <header class="prompt-queue-header">
          <span class="prompt-queue-title">{t("promptQueue.title")}</span>
          <span class="prompt-queue-count">{t("promptQueue.count", { count: items().length })}</span>
          <Show when={paused()}>
            <span class="prompt-queue-state">{t("promptQueue.paused")}</span>
          </Show>
          <div class="prompt-queue-actions">
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
              onClick={() => toggleQueuePaused(props.instanceId, props.sessionId)}
              title={paused() ? t("promptQueue.resume") : t("promptQueue.pause")}
            >
              {paused() ? t("promptQueue.resume") : t("promptQueue.pause")}
            </button>
            <button
              type="button"
              onClick={() => clearQueue(props.instanceId, props.sessionId)}
              disabled={items().length === 0}
              title={t("promptQueue.clear")}
            >
              {t("promptQueue.clear")}
            </button>
          </div>
        </header>

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
                            onClick={() => moveQueuedPrompt(props.instanceId, props.sessionId, item.id, -1)}
                            disabled={index() === 0}
                            title={t("promptQueue.moveUp")}
                            aria-label={t("promptQueue.moveUp")}
                          >
                            ^
                          </button>
                          <button
                            type="button"
                            onClick={() => moveQueuedPrompt(props.instanceId, props.sessionId, item.id, 1)}
                            disabled={index() === items().length - 1}
                            title={t("promptQueue.moveDown")}
                            aria-label={t("promptQueue.moveDown")}
                          >
                            v
                          </button>
                          <button
                            type="button"
                            onClick={() => beginEdit(item.id, item.text)}
                            title={t("promptQueue.edit")}
                          >
                            {t("promptQueue.edit")}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeQueuedPrompt(props.instanceId, props.sessionId, item.id)}
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

        <p class="prompt-queue-hint">
          {paused()
            ? t("promptQueue.pausedHint")
            : props.sessionBusy
              ? t("promptQueue.busyHint")
              : t("promptQueue.empty")}
        </p>
      </section>
    </Show>
  )
}

export default PromptQueuePanel
