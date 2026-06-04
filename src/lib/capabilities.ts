// Per-model capability flags ({vision, embedding, rerank}).
//
// We do NOT call out to providers for this — there's no universal endpoint
// and most providers don't expose it at all. Instead we infer from the model
// id (which is the single thing that's actually portable across providers)
// and let the user override per model in Settings.
//
// Override semantics are tri-state:
//   undefined    -> "use the heuristic"
//   true / false -> "force on / off, ignore the heuristic"
//
// Storage: ProviderEntry.modelCapabilities is a `Record<modelId, Override>`,
// where Override is a partial { vision?, embedding?, rerank? } — keys present
// in the override beat the heuristic; keys absent fall through. The whole
// record itself is optional on the entry, so old settings blobs cost nothing.

import type { ProviderEntry } from './settings'

export interface ModelCapabilities {
  vision: boolean
  embedding: boolean
  rerank: boolean
}

/** Override is *partial*: keys present force that capability on/off, keys
 *  absent defer to the heuristic. */
export type ModelCapabilityOverride = Partial<ModelCapabilities>

/** Heuristic inference from a model id. Falsy by default — we'd rather
 *  under-promise than confidently mislabel a brand-new model id. */
export function inferModelCapabilities(modelId: string): ModelCapabilities {
  const id = (modelId || '').toLowerCase()
  // Vision: enumerate the families we have reasonable confidence about.
  // The pattern style stays conservative — if a future id breaks the regex,
  // the user can flip the override in Settings.
  const vision =
    /gpt-?4o|gpt-?4-?turbo|gpt-?4-?vision|gpt-?5/.test(id) ||
    /claude-3/.test(id) ||
    /claude-(?:opus|sonnet|haiku)-(?:[4-9]|\d{2,})/.test(id) ||
    /gemini-(?:1\.5|2\.|pro-vision)/.test(id) ||
    /(?:^|[-_])(?:vl|vision|llava)(?:[-_]|\d|$)/.test(id)
  const embedding = /(?:^|[-_])(?:embedding|embed)(?:[-_]|\d|$)/.test(id)
  const rerank = /(?:^|[-_])rerank(?:er)?(?:[-_]|\d|$)/.test(id)
  return { vision, embedding, rerank }
}

/** Resolve effective capabilities = (heuristic) overlayed by any per-model
 *  override stored on the provider. */
export function getModelCapabilities(
  provider: ProviderEntry | undefined,
  modelId: string,
): ModelCapabilities {
  const base = inferModelCapabilities(modelId)
  const override = provider?.modelCapabilities?.[modelId]
  if (!override) return base
  return {
    vision: override.vision ?? base.vision,
    embedding: override.embedding ?? base.embedding,
    rerank: override.rerank ?? base.rerank,
  }
}

/** Return the partial override saved for a model (or empty object). Useful
 *  for Settings UIs that want to render the tri-state directly. */
export function getModelCapabilityOverride(
  provider: ProviderEntry | undefined,
  modelId: string,
): ModelCapabilityOverride {
  return provider?.modelCapabilities?.[modelId] ?? {}
}

/** Functional setter: returns a NEW ProviderEntry with the named capability
 *  override flipped to `value`. Pass `undefined` to drop the override and
 *  defer back to the heuristic. */
export function setModelCapabilityOverride(
  provider: ProviderEntry,
  modelId: string,
  capability: keyof ModelCapabilities,
  value: boolean | undefined,
): ProviderEntry {
  const all = { ...(provider.modelCapabilities ?? {}) }
  const entry: ModelCapabilityOverride = { ...(all[modelId] ?? {}) }
  if (value === undefined) {
    delete entry[capability]
  } else {
    entry[capability] = value
  }
  if (Object.keys(entry).length === 0) {
    delete all[modelId]
  } else {
    all[modelId] = entry
  }
  return { ...provider, modelCapabilities: all }
}
