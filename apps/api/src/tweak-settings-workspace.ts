import { effectiveServerWebSettings, fail, parseTweakValues, SETTINGS_INDEX, settingValue, TWEAK_SETTINGS_STATE, TWEAKS } from '@xpanel/core'
import type { TweakValue } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigRevision, panelJson, readPanelConfigBody, stateConfigFile } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { signInPolicyFile } from './sign-in-policy.ts'

export const TWEAK_SETTINGS_NAMESPACE = 'tweak-settings:v1'
const unchanged = { stateChanged: false }

/** Saved Tweak Settings: one JSON object of key to value, holding only values that differ from their default. */
export const tweakSettingsFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<Record<string, TweakValue>> =>
  stateConfigFile(store, TWEAK_SETTINGS_STATE, TWEAK_SETTINGS_NAMESPACE, raw => { try { return parseTweakValues(raw) } catch { return null } }, () => parseTweakValues(null))

/** One tweak value as its consumer reads it: the saved value, or its default while nothing valid is saved. */
export const tweakValue = async (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>, key: string): Promise<TweakValue> => {
  const values = await tweakSettingsFile(store).current()
  return Object.hasOwn(values, key) ? values[key]! : fail('NOT_FOUND', 'unknown tweak setting', { key })
}

const viewOf = (raw: unknown, values: Record<string, TweakValue> | null) => ({
  state: raw === null ? 'default' : values ? 'saved' : 'invalid',
  revision: panelConfigRevision(TWEAK_SETTINGS_NAMESPACE, raw),
  values,
  definitions: TWEAKS,
})

export interface TweakSettingsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock' | 'getServerSettings'>
}

/**
 * WHM Tweak Settings and the Advanced Settings Browser. GET/PUT /api/server/tweak-settings read and save the registry
 * values (revision-bound, refused outside a definition); GET /api/server/settings-index reads every indexed setting by key.
 */
export async function handleTweakSettingsRoute(request: Request, url: URL, method: string, helpers: TweakSettingsHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/tweak-settings' && url.pathname !== '/api/server/settings-index') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.tweak-settings')
  const index = url.pathname === '/api/server/settings-index'
  if (method !== 'GET' && (index || method !== 'PUT')) return new Response(null, { status: 405, headers: { allow: index ? 'GET' : 'GET, PUT' } })
  if (url.search) return fail('VALIDATION', 'tweak settings accept no query selectors', unchanged)
  const file = tweakSettingsFile(helpers.store)
  if (index) {
    const [settings, policy, tweaks] = await Promise.all([helpers.store.getServerSettings(), signInPolicyFile(helpers.store).read(), file.read()])
    const sources = { tweak: tweaks.value, server: settings, web: settings ? { web: effectiveServerWebSettings(settings) } : null, 'sign-in': policy.value } as const
    return panelJson({ values: Object.fromEntries(SETTINGS_INDEX.map(entry => {
      const source = sources[entry.source]
      return [entry.key, source === null ? null : entry.source === 'tweak' ? (source as Record<string, unknown>)[entry.key] ?? null : settingValue(source, entry.key)]
    })) })
  }
  if (method === 'GET') { const { raw, value } = await file.read(); return panelJson(viewOf(raw, value)) }
  const body = await readPanelConfigBody(request)
  if (!exactKeys(body, ['values', 'expectedRevision'])) return fail('VALIDATION', 'exactly values and expectedRevision are required', unchanged)
  const expected = assertExpectedRevision(body.expectedRevision)
  let values: Record<string, TweakValue>
  try { values = parseTweakValues(body.values) } catch (error) { return fail('VALIDATION', error instanceof Error ? error.message : 'invalid tweak settings', { ...unchanged, ...(error as { detail?: object }).detail }) }
  const changed = Object.fromEntries(TWEAKS.filter(d => values[d.key] !== d.default).map(d => [d.key, values[d.key]!]))
  const saved = await file.write(changed, expected, async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.tweak-settings') })
  try {
    await helpers.emitAudit({ actor: caller.principal.username, action: 'server.tweak_settings.updated', target: 'tweak-settings', detail: { changed: Object.keys(changed) }, outcome: 'ok', principalId: caller.principal.id })
  } catch { return fail('SERVICE_UNAVAILABLE', 'the settings were saved but their audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(viewOf(saved.raw, saved.value))
}
