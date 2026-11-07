import { join } from 'node:path'
import { parseTweakValues, TWEAK_SETTINGS_STATE } from '@xpanel/core'
import type { TweakValue } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'

/** Saved Tweak Settings below the desired-state root; a missing or invalid file yields the defaults, as in the API. */
export async function readSavedTweakValues(stateRoot: string): Promise<Record<string, TweakValue>> {
  try { return parseTweakValues(await readJsonIfExists<unknown>(join(stateRoot, TWEAK_SETTINGS_STATE))) } catch { return parseTweakValues(null) }
}
