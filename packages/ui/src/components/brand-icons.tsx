import type { Component } from "solid-js"
import { Github, MessagesSquare } from "lucide-solid"

type BrandIconProps = {
  class?: string
  title?: string
}

export const GitHubMarkIcon: Component<BrandIconProps> = (props) => (
  <Github
    aria-hidden={props.title ? undefined : "true"}
    role={props.title ? "img" : "presentation"}
    aria-label={props.title}
    class={props.class}
  />
)

export const DiscordSymbolIcon: Component<BrandIconProps> = (props) => (
  <MessagesSquare
    aria-hidden={props.title ? undefined : "true"}
    role={props.title ? "img" : "presentation"}
    aria-label={props.title}
    class={props.class}
  />
)
