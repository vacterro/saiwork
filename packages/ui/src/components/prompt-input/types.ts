import type { Attachment } from "../../types/attachment"

export type PromptMode = "normal" | "shell"
export type ExpandState = "normal" | "expanded"
export type PickerMode = "mention" | "command"
export type PromptInsertMode = "quote" | "code"

export interface PromptInputApi {
  insertSelection(text: string, mode: PromptInsertMode): void
  insertComment(text: string): void
  expandTextAttachment(attachmentId: string): void
  removeAttachment(attachmentId: string): void
  setPromptText(text: string, opts?: { focus?: boolean }): void
  focus(): void
}

export interface PromptInputProps {
  instanceId: string
  instanceFolder: string
  sessionId: string

  // Used to scope global "type-to-focus" behavior.
  isActive?: boolean

  // Phone/tablet layouts should keep the expanded prompt more compact.
  compactLayout?: boolean
  onSend: (prompt: string, attachments: Attachment[]) => Promise<void>
  /**
   * Adds the current prompt to the session queue instead of sending it.
   * Returning `false` means the queue refused it, and the editor keeps the text.
   */
  onQueue?: (prompt: string, attachments: Attachment[]) => void | boolean | Promise<void | boolean>
  /** Adds text to active sessions across ready instances. */
  onQueueAll?: (prompt: string) => number
  /** Opens the model / worktree controls (the sidebar drawer). */
  onOpenModelControls?: () => void
  /** Starts a new conversation (fork) in the same session. */
  onNewConversation?: () => void
  /** Pending prompts for this session; drives the queue button label. */
  queuedCount?: number
  onCommand?: (commandName: string, args: string) => Promise<void>
  onRunShell?: (command: string) => Promise<void>
  disabled?: boolean
  escapeInDebounce?: boolean
  isSessionBusy?: boolean
  onAbortSession?: () => Promise<void>
  registerPromptInputApi?: (api: PromptInputApi) => void | (() => void)
}
