/**
 * Shared relative-time formatting ("just now", "5m ago", "3h ago", "2d ago").
 *
 * Three components used to carry byte-identical copies of this logic; the
 * formatter needs the i18n `t` function for the labels, so it takes it as a
 * parameter instead of reaching into the i18n module itself.
 */

export type RelativeTimeTranslator = (key: string, params?: Record<string, unknown>) => string

export function formatRelativeTime(timestamp: number, now: number, t: RelativeTimeTranslator): string {
  const seconds = Math.floor((now - timestamp) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return t("time.relative.daysAgoShort", { count: days })
  if (hours > 0) return t("time.relative.hoursAgoShort", { count: hours })
  if (minutes > 0) return t("time.relative.minutesAgoShort", { count: minutes })
  return t("time.relative.justNow")
}
