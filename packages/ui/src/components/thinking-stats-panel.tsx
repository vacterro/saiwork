import { For, type Component } from "solid-js"
import { useI18n } from "../lib/i18n"
import { formatTokenTotal } from "../lib/formatters"
import { averageThinkingMs, formatThinkingDuration, type ThinkingRange } from "../lib/thinking-stats"
import { getThinkingTotals } from "../stores/thinking-stats"

const RANGES: ThinkingRange[] = ["day", "week", "month", "year", "all"]

const RANGE_LABEL_KEY: Record<ThinkingRange, string> = {
  day: "thinkingStats.range.day",
  week: "thinkingStats.range.week",
  month: "thinkingStats.range.month",
  year: "thinkingStats.range.year",
  all: "thinkingStats.range.all",
}

/**
 * How long the agent actually spent thinking, rolled up.
 *
 * Read on render from the persisted day buckets -- no polling and no timer, so
 * the numbers change when the user does something, never underneath them.
 */
const ThinkingStatsPanel: Component = () => {
  const { t } = useI18n()

  const rows = () =>
    RANGES.map((range) => {
      const totals = getThinkingTotals(range)
      return { range, totals, average: averageThinkingMs(totals) }
    })

  return (
    <section class="thinking-stats" aria-label={t("thinkingStats.title")}>
      <header class="thinking-stats-header">
        <span class="thinking-stats-title">{t("thinkingStats.title")}</span>
      </header>

      <table class="thinking-stats-table">
        <thead>
          <tr>
            <th>{t("thinkingStats.column.range")}</th>
            <th>{t("thinkingStats.column.thinking")}</th>
            <th>{t("thinkingStats.column.average")}</th>
            <th>{t("thinkingStats.column.replies")}</th>
            <th>{t("thinkingStats.column.toolCalls")}</th>
            <th>{t("thinkingStats.column.activeDays")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr>
                <td>{t(RANGE_LABEL_KEY[row.range])}</td>
                <td class="thinking-stats-value">{formatThinkingDuration(row.totals.thinkingMs)}</td>
                <td class="thinking-stats-value">{formatThinkingDuration(row.average)}</td>
                <td class="thinking-stats-value">{formatTokenTotal(row.totals.replies)}</td>
                <td class="thinking-stats-value">{formatTokenTotal(row.totals.toolCalls)}</td>
                <td class="thinking-stats-value">{row.totals.activeDays}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <p class="thinking-stats-hint">{t("thinkingStats.hint")}</p>
    </section>
  )
}

export default ThinkingStatsPanel
