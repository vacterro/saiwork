import { Component } from "solid-js"
import { X } from "lucide-solid"
import type { Attachment } from "../types/attachment"
import { useI18n } from "../lib/i18n"

interface AttachmentChipProps {
  attachment: Attachment
  onRemove: () => void
}

const AttachmentChip: Component<AttachmentChipProps> = (props) => {
  const { t } = useI18n()
  return (
    <div
      class="attachment-chip"
      title={props.attachment.source.type === "file" ? props.attachment.source.path : undefined}
    >
      <span class="font-mono">{props.attachment.display}</span>
      <button
        onClick={props.onRemove}
        class="attachment-remove"
        aria-label={t("attachmentChip.removeAriaLabel")}
      >
        <X class="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  )
}

export default AttachmentChip
