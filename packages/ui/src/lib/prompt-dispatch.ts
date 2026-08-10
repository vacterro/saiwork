import type { Attachment } from "../types/attachment"

interface DispatchOrdinaryPromptOptions {
  queueEnabled: boolean
  instanceId: string
  sessionId: string
  prompt: string
  attachments: Attachment[]
  enqueue: (
    instanceId: string,
    sessionId: string,
    prompt: string,
    attachments: Attachment[],
  ) => { ok: boolean; reason?: string }
  send: (instanceId: string, sessionId: string, prompt: string, attachments: Attachment[]) => Promise<void>
}

export type PromptDispatchOutcome =
  | { result: "queued" }
  | { result: "sent" }
  /** The queue refused the prompt; the caller still owns the text. */
  | { result: "rejected"; reason?: string }

/**
 * `queued` used to be returned unconditionally, so a refused enqueue still read
 * as success and the caller cleared the editor.
 */
export async function dispatchOrdinaryPrompt(
  options: DispatchOrdinaryPromptOptions,
): Promise<PromptDispatchOutcome> {
  if (options.queueEnabled) {
    const enqueued = options.enqueue(options.instanceId, options.sessionId, options.prompt, options.attachments)
    if (!enqueued.ok) return { result: "rejected", reason: enqueued.reason }
    return { result: "queued" }
  }

  await options.send(options.instanceId, options.sessionId, options.prompt, options.attachments)
  return { result: "sent" }
}

export function shouldDrainPromptQueue(state: {
  busy: boolean
  needsInput: boolean
  paused: boolean
  pending: number
}): boolean {
  return !state.busy && !state.needsInput && !state.paused && state.pending > 0
}
