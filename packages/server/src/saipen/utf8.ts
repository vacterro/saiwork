export type Utf8TruncationSide = "head" | "tail"

/** Returns at most maxBytes without splitting a UTF-8 code point. */
export function truncateUtf8(text: string, maxBytes: number, side: Utf8TruncationSide): string {
  if (maxBytes <= 0) return ""
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maxBytes) return text

  if (side === "head") {
    let end = maxBytes
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
    return bytes.subarray(0, end).toString("utf8")
  }

  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString("utf8")
}
