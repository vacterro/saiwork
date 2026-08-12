/**
 * Quota counts from codebuff.com arrive as floats (a turn consumes a fraction
 * of the daily limit). Printing them raw leaks FP noise like
 * `1.400000000000000000000000467`. This formats a count cleanly: integers stay
 * integers, fractions round to two decimal places.
 */
export function formatQuotaCount(value: number): string {
  if (!Number.isFinite(value)) return "0"
  if (Number.isInteger(value)) return String(value)
  return String(Math.round(value * 100) / 100)
}
