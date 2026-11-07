import { tools } from './data/index.ts'

// Same grammar as FEATURE_KEY_RE in packages/state: a saved feature list holds only these.
const SAVED_FEATURE_KEY = /^(?:[a-z0-9][a-z0-9._-]{0,63}|plugin:[A-Za-z0-9_-]{1,57})$/
const LABELS = new Map<string, string[]>()
for (const tool of tools) if (tool.featureKey && !SAVED_FEATURE_KEY.test(tool.featureKey)) LABELS.set(tool.featureKey, [...LABELS.get(tool.featureKey) ?? [], tool.id])

/** Some catalog keys are cPanel labels the store refuses. A list saves the tool ids behind a label, and every feature check reads both. */
export const savedFeatureKeys = <T>(keys: T): T => (Array.isArray(keys) ? [...new Set(keys.flatMap(key => LABELS.get(key) ?? [key]))] : keys) as T

/** What Feature Manager shows for a saved list: a label comes back once all its tool ids are saved. */
export const shownFeatureKeys = (saved: readonly string[]): string[] => {
  const labels = [...LABELS].filter(([, ids]) => ids.every(id => saved.includes(id))), covered = new Set(labels.flatMap(([, ids]) => ids))
  return [...saved.filter(key => !covered.has(key)), ...labels.map(([label]) => label)]
}
