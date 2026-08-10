export function LosslessUserText(props: { text: string }) {
  return <span class="text-primary message-user-plain" dir="auto">{getLosslessUserText(props.text)}</span>
}

export function getLosslessUserText(text: string): string {
  return text
}

export function shouldRenderMessageTextAsMarkdown(
  messageType: "user" | "assistant" | undefined,
  partId: unknown,
): boolean {
  return messageType === "assistant" && typeof partId === "string" && partId.length > 0
}
