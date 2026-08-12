import { randomBytes } from "node:crypto"

/**
 * Per-instance bearer keys for the local OpenAI-compatible shims.
 *
 * A fixed string would let any local process that knows it consume the user's
 * subscription quota through the shims. Each server process therefore mints a
 * random key; the same value is injected into the workspace OpenCode provider
 * config and required by the shim routes, so only that process's workspaces can
 * call the shims. Override via SAIWORK_ANTIGRAVITY_SHIM_KEY /
 * SAIWORK_FREEBUFF_SHIM_KEY for deterministic deployments.
 */

function makeKey(label: string): string {
  const envName = `SAIWORK_${label.toUpperCase()}_SHIM_KEY`
  const env = process.env[envName]
  if (env && env.trim()) return env.trim()
  return `saiwork-${label}-shim-${randomBytes(16).toString("hex")}`
}

export const ANTIGRAVITY_SHIM_API_KEY = makeKey("antigravity")
export const FREEBUFF_SHIM_API_KEY = makeKey("freebuff")
