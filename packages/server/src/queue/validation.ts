import {
  MAX_QUEUED_ATTACHMENT_BYTES,
  type QueueState,
  type QueuedAttachment,
  type QueuedPrompt,
} from "../api-types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPosition(value: unknown): value is { line: number; char: number } {
  return isRecord(value) && typeof value.line === "number" && typeof value.char === "number"
}

export function isQueuedAttachment(value: unknown): value is QueuedAttachment {
  if (!isRecord(value) || !isRecord(value.source)) return false
  if (
    typeof value.id !== "string"
    || typeof value.display !== "string"
    || typeof value.url !== "string"
    || typeof value.filename !== "string"
    || typeof value.mediaType !== "string"
    || value.type !== value.source.type
  ) return false

  const source = value.source
  if (value.type === "file") return typeof source.path === "string" && typeof source.mime === "string"
  if (value.type === "text") return typeof source.value === "string"
  if (value.type === "agent") return typeof source.name === "string"
  if (value.type !== "symbol" || !isRecord(source.range)) return false
  return typeof source.path === "string"
    && typeof source.name === "string"
    && typeof source.kind === "number"
    && isPosition(source.range.start)
    && isPosition(source.range.end)
}

export function queuedAttachmentBytes(attachments: readonly unknown[]): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(attachments)).byteLength
  } catch {
    return null
  }
}

export function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  if (!isRecord(value) || !Array.isArray(value.attachments)) return false
  const attachmentBytes = queuedAttachmentBytes(value.attachments)
  return typeof value.id === "string"
    && value.id.length > 0
    && typeof value.text === "string"
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && attachmentBytes !== null
    && attachmentBytes <= MAX_QUEUED_ATTACHMENT_BYTES
    && value.attachments.every(isQueuedAttachment)
}

export function isQueueState(value: unknown): value is QueueState {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every(isQueuedPrompt)
    && typeof value.paused === "boolean"
    && typeof value.revision === "string"
}
