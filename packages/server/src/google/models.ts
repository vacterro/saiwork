import {
  ANTIGRAVITY_PROVIDER_ID,
  GEMINI_API_PROVIDER_ID,
  type GoogleModelInfo,
  type GoogleProviderId,
} from "./types"
import type { AntigravityModelInfo } from "./antigravity-session"

/**
 * Provider-scoped Google model catalogs.
 *
 * A model id belongs to exactly one Google provider. `google_gemini_api`
 * models are billed to the Gemini Developer API project; `google_antigravity`
 * models run against the Google AI Pro subscription. The same upstream model
 * name exists in both pools, but the SAIWORK ids are distinct so a free-tier
 * quota error can never be mistaken for an Antigravity quota error and vice
 * versa.
 */

interface RawModel {
  id: string
  displayName: string
  reasoning: boolean
  context: number
  output: number
}

const GEMINI_API_MODELS: RawModel[] = [
  { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", reasoning: true, context: 1_048_576, output: 65_535 },
]

// The production catalog the Antigravity subscription backend actually serves
// (verified against fetchAvailableModels + streamGenerateContent). The id in
// this catalog is the exact id the backend accepts. `gemini-3.1-pro-high` is
// registered but rejects generate requests with HTTP 400; its working twin is
// `gemini-pro-agent` (displayed "Gemini 3.1 Pro (High)"), so that is what we
// expose. Display names match what the Antigravity UI shows. context/output
// mirror the backend's maxTokens/maxOutputTokens.
const ANTIGRAVITY_MODELS: RawModel[] = [
  { id: "gemini-pro-agent", displayName: "Gemini 3.1 Pro (High)", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "gemini-3.1-pro-low", displayName: "Gemini 3.1 Pro (Low)", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "gemini-3.6-flash-high", displayName: "Gemini 3.6 Flash (High)", reasoning: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3.6-flash-medium", displayName: "Gemini 3.6 Flash (Medium)", reasoning: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3.6-flash-low", displayName: "Gemini 3.6 Flash (Low)", reasoning: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3.5-flash-low", displayName: "Gemini 3.5 Flash (Medium)", reasoning: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3.5-flash-extra-low", displayName: "Gemini 3.5 Flash (Low)", reasoning: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3-flash-agent", displayName: "Gemini 3.5 Flash (High)", reasoning: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-3-flash", displayName: "Gemini 3 Flash", reasoning: true, context: 1_048_576, output: 65_536 },
  { id: "gemini-2.5-flash-thinking", displayName: "Gemini 3.1 Flash Lite", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "gemini-2.5-flash", displayName: "Gemini 3.1 Flash Lite", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", reasoning: true, context: 1_048_576, output: 65_535 },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Thinking)", reasoning: true, context: 250_000, output: 64_000 },
  { id: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 (Thinking)", reasoning: true, context: 250_000, output: 64_000 },
  { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)", reasoning: false, context: 131_072, output: 32_768 },
]

function scoped(providerId: GoogleProviderId, models: RawModel[]): GoogleModelInfo[] {
  return models.map((model) => ({ ...model, providerId }))
}

/**
 * Backend-registered ids that must never be offered: they are served by
 * `fetchAvailableModels` but reject generate requests (the working twin is
 * exposed instead).
 */
export const ANTIGRAVITY_DENIED_LIVE_IDS = new Set(["gemini-3.1-pro-high"])

/**
 * The live Antigravity catalog: what the subscription backend currently
 * serves, merged with static display metadata and with known-broken ids
 * filtered out. A newly released model (Gemini 3.7 Flash, ...) appears here
 * as soon as the backend returns it; models the backend no longer serves
 * drop off. When the live list is empty (no session / network down) the
 * static catalog is the fallback so the provider never goes empty.
 */
export function antigravityLiveCatalog(live: AntigravityModelInfo[]): RawModel[] {
  if (live.length === 0) return ANTIGRAVITY_MODELS
  const staticById = new Map(ANTIGRAVITY_MODELS.map((model) => [model.id, model]))
  const out: RawModel[] = []
  for (const model of live) {
    if (ANTIGRAVITY_DENIED_LIVE_IDS.has(model.id)) continue
    const existing = staticById.get(model.id)
    out.push({
      id: model.id,
      displayName: existing?.displayName ?? model.displayName,
      reasoning: existing?.reasoning ?? true,
      context: existing?.context ?? (model.maxTokens ?? 1_048_576),
      output: existing?.output ?? (model.maxOutputTokens ?? 65_536),
    })
  }
  return out.length > 0 ? out : ANTIGRAVITY_MODELS
}

/** The raw Antigravity catalog used by both the OpenCode provider config and the shim. */
export function antigravityCatalog(): RawModel[] {
  return ANTIGRAVITY_MODELS
}

export const GOOGLE_MODELS: Record<GoogleProviderId, GoogleModelInfo[]> = {
  [GEMINI_API_PROVIDER_ID]: scoped(GEMINI_API_PROVIDER_ID, GEMINI_API_MODELS),
  [ANTIGRAVITY_PROVIDER_ID]: scoped(ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_MODELS),
}

export function googleModelsFor(providerId: GoogleProviderId): GoogleModelInfo[] {
  return GOOGLE_MODELS[providerId]
}

/** The SAIWORK-scoped id, e.g. `google_gemini_api/gemini-3.1-pro-preview`. */
export function scopedModelId(providerId: GoogleProviderId, modelId: string): string {
  return `${providerId}/${modelId}`
}

export function isGoogleScopedModelId(candidate: string): boolean {
  return candidate.startsWith(`${GEMINI_API_PROVIDER_ID}/`) || candidate.startsWith(`${ANTIGRAVITY_PROVIDER_ID}/`)
}
