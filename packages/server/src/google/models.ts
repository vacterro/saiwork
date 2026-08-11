import {
  ANTIGRAVITY_PROVIDER_ID,
  GEMINI_API_PROVIDER_ID,
  type GoogleModelInfo,
  type GoogleProviderId,
} from "./types"

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
}

const GEMINI_API_MODELS: RawModel[] = [
  { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", reasoning: true, context: 1_048_576 },
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", reasoning: true, context: 1_048_576 },
  { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", reasoning: true, context: 1_048_576 },
  { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", reasoning: true, context: 1_048_576 },
]

const ANTIGRAVITY_MODELS: RawModel[] = [
  { id: "gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro Preview", reasoning: true, context: 1_048_576 },
  { id: "gemini-3.5-flash", displayName: "Gemini 3.5 Flash", reasoning: true, context: 1_048_576 },
  { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash Lite", reasoning: true, context: 1_048_576 },
]

function scoped(providerId: GoogleProviderId, models: RawModel[]): GoogleModelInfo[] {
  return models.map((model) => ({ ...model, providerId }))
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
