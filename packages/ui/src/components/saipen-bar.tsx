import { For, Show, createSignal, onMount, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { getLogger } from "../lib/logger"
import { serverApi } from "../lib/api-client"
import { SAIPEN_COMMANDS, type SaipenCommand } from "../lib/saipen-commands"
import type { SaipenStatusResponse } from "../../../server/src/api-types"

const log = getLogger("actions")

interface SaipenBarProps {
  /** Workspace folder, used to resolve the project's own .saipen state. */
  folder: string
  /** Sends the shortcut as the entire message, which is what the protocol expects. */
  onRunShortcut: (shortcut: string) => void
  /** Puts the shortcut in the prompt for the user to complete. */
  onInsertShortcut: (text: string) => void
}

/**
 * SAIPEN command bar.
 *
 * Two kinds of control, and each one always behaves the same way:
 * argument-less shortcuts run on click, argument-taking ones (`gg`, `dd`) land
 * in the prompt so the user can finish the sentence. The status list is loaded
 * on mount and on an explicit refresh -- never polled, because content moving
 * under a reading eye is the surprise the UI rules exist to prevent.
 */
const SaipenBar: Component<SaipenBarProps> = (props) => {
  const { t } = useI18n()
  const [status, setStatus] = createSignal<SaipenStatusResponse | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)

  async function refresh() {
    setLoading(true)
    try {
      const next = await serverApi.fetchSaipenStatus(props.folder)
      setStatus(next)
      setLoadError(null)
    } catch (error) {
      log.error("Failed to load SAIPEN status:", error)
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void refresh()
  })

  function activate(command: SaipenCommand) {
    if (command.argument === "required") {
      props.onInsertShortcut(`${command.shortcut} `)
      return
    }
    props.onRunShortcut(command.shortcut)
  }

  const coreLine = () => {
    const current = status()
    if (!current) return t("saipen.core.unknown")
    if (!current.enabled) return t("saipen.core.disabled")
    if (current.error) return current.error
    if (current.instructions.length === 0) return t("saipen.core.noFiles")
    return t("saipen.core.loaded", { count: current.instructions.length, dir: current.protocolDir ?? "" })
  }

  return (
    <section class="saipen-bar" aria-label={t("saipen.title")}>
      <header class="saipen-bar-header">
        <span class="saipen-bar-title">{t("saipen.title")}</span>
        <span class="saipen-bar-core" title={status()?.protocolDir ?? undefined}>
          {coreLine()}
        </span>
        <div class="saipen-bar-header-actions">
          <button type="button" onClick={() => setExpanded(!expanded())}>
            {expanded() ? t("saipen.hideStatus") : t("saipen.showStatus")}
          </button>
          <button type="button" onClick={() => void refresh()} disabled={loading()}>
            {loading() ? "..." : t("saipen.refresh")}
          </button>
        </div>
      </header>

      <div class="saipen-bar-commands">
        <For each={SAIPEN_COMMANDS}>
          {(command) => (
            <button
              type="button"
              class="saipen-command"
              onClick={() => activate(command)}
              title={`${command.verb} - ${command.summary}${
                command.argument === "required" ? ` (${t("saipen.insertsIntoPrompt")})` : ""
              }`}
            >
              {command.shortcut}
            </button>
          )}
        </For>
      </div>

      <Show when={expanded()}>
        <div class="saipen-bar-status">
          <Show when={loadError()}>
            <p class="saipen-bar-error">{loadError()}</p>
          </Show>

          <Show when={(status()?.missing.length ?? 0) > 0}>
            <p class="saipen-bar-error">
              {t("saipen.missingFiles", { files: (status()?.missing ?? []).join(", ") })}
            </p>
          </Show>

          <Show
            when={(status()?.subs.length ?? 0) > 0}
            fallback={<p class="saipen-bar-empty">{t("saipen.noSubs")}</p>}
          >
            <table class="saipen-subs">
              <thead>
                <tr>
                  <th>{t("saipen.subs.name")}</th>
                  <th>{t("saipen.subs.phase")}</th>
                  <th>{t("saipen.subs.task")}</th>
                  <th>{t("saipen.subs.updated")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={status()?.subs ?? []}>
                  {(sub) => (
                    <tr>
                      <td>{sub.name}</td>
                      <td>{sub.phase ?? "-"}</td>
                      <td title={sub.nextAction ?? undefined}>{sub.task ?? "-"}</td>
                      <td>{sub.updated ?? "-"}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </Show>
    </section>
  )
}

export default SaipenBar
