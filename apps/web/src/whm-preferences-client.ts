/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import { LOCALES, type Locale, type MessageValues } from './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
/** Registry tags a saved preference may name; the client binding receives the same list. */
const PREFERENCE_LOCALES: readonly string[] = LOCALES.map(info => info.tag)
export interface AdminPreferenceFields { language: Locale; theme: 'light' | 'dark'; density: 'comfortable' | 'compact' }
export interface AdminPreferencesView { state: 'default' | 'saved' | 'invalid'; preferences: AdminPreferenceFields | null; updatedAt: string | null; revision: string; application: 'next_navigation' }

export function readAdminPreferencesView(value: unknown): AdminPreferencesView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || Object.keys(value).sort().join() !== 'application,preferences,revision,state,updatedAt' || !['default', 'saved', 'invalid'].includes(value.state as string)
    || value.application !== 'next_navigation' || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)) throw new Error('invalid_preferences')
  const raw = value.preferences
  if (value.state === 'invalid') {
    if (raw !== null || value.updatedAt !== null) throw new Error('invalid_preferences')
    return { state: 'invalid', preferences: null, updatedAt: null, revision: value.revision, application: 'next_navigation' }
  }
  if (!object(raw) || Object.keys(raw).sort().join() !== 'density,language,theme' || !PREFERENCE_LOCALES.includes(raw.language as string)
    || (raw.theme !== 'light' && raw.theme !== 'dark') || (raw.density !== 'comfortable' && raw.density !== 'compact')) throw new Error('invalid_preferences')
  if (value.state === 'default' && (value.updatedAt !== null || raw.language !== PREFERENCE_LOCALES[0] || raw.theme !== 'light' || raw.density !== 'comfortable')) throw new Error('invalid_preferences')
  if (value.state === 'saved' && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || new Date(value.updatedAt).toISOString() !== value.updatedAt)) throw new Error('invalid_preferences')
  return { state: value.state as AdminPreferencesView['state'], preferences: { language: raw.language as Locale, theme: raw.theme, density: raw.density }, updatedAt: value.updatedAt as string | null, revision: value.revision, application: 'next_navigation' }
}

function bindWhmPreferences(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-preferences-workspace]').forEach(root => {
    if (root.dataset.preferencesBound === 'true') return
    root.dataset.preferencesBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const form = one<HTMLFormElement>('[data-whm-preferences-form]'), status = one<HTMLElement>('[data-whm-preferences-status]'), saveStatus = one<HTMLElement>('[data-whm-preferences-save-status]')
    const save = one<HTMLButtonElement>('[data-whm-preferences-save]'), reload = one<HTMLButtonElement>('[data-whm-preferences-reload]'), apply = one<HTMLAnchorElement>('[data-whm-preferences-apply]'), loading = one<HTMLElement>('[data-whm-preferences-loading]')
    const language = one<HTMLSelectElement>('[data-whm-preferences-input="language"]'), theme = one<HTMLSelectElement>('[data-whm-preferences-input="theme"]'), density = one<HTMLSelectElement>('[data-whm-preferences-input="density"]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!form || !status || !saveStatus || !save || !reload || !apply || !language || !theme || !density) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.preferencesCanManage === 'true' && form.tagName === 'FORM' && !root.closest(denied) && typeof request === 'function'
    let revision = '', busy = false, readable = false
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const lock = (): void => { for (const input of [language, theme, density, save]) input.disabled = busy || !readable || !revision || !admitted(); reload.disabled = busy || !admitted(); root.setAttribute('aria-busy', String(busy)) }
    const languages = new Intl.DisplayNames([document.documentElement.lang || PREFERENCE_LOCALES[0]!], { type: 'language' })
    const labels: Record<string, string> = { ...Object.fromEntries(PREFERENCE_LOCALES.map(tag => [tag, languages.of(tag) ?? tag])), light: t('Light'), dark: t('Dark'), comfortable: t('Comfortable'), compact: t('Compact') }
    const field = (key: string, text: string, technical = false): void => {
      const target = one<HTMLElement>('[data-whm-preferences-field="' + key + '"]'); if (!target) return
      target.replaceChildren()
      if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = text; target.append(bdi) } else target.textContent = text
    }
    const paint = (view: AdminPreferencesView): void => {
      revision = view.state === 'invalid' ? '' : view.revision; readable = view.preferences !== null
      for (const key of ['language', 'theme', 'density'] as const) field(key, view.preferences ? labels[view.preferences[key]]! : t('Unavailable'))
      if (view.preferences) { language.value = view.preferences.language; theme.value = view.preferences.theme; density.value = view.preferences.density }
      field('updatedAt', view.updatedAt ? formatDisplayDateTime(view.updatedAt) : t(msgctxt('whm-preferences-client', 'Never saved')), !!view.updatedAt)
      apply.hidden = view.state !== 'saved'; apply.setAttribute('href', '/whm/preferences')
      note(status, view.state === 'invalid' ? 'failed' : 'read', view.state === 'saved' ? t('Saved preferences read for your account.') : view.state === 'default'
        ? t('No preferences have been saved. The default choices are shown.')
        : t('The saved preferences could not be verified. Ask an administrator to review the saved record before changing it.'))
    }
    const failure = (error: unknown, fallback: string): string => {
      const item = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean; unknownOutcome?: boolean } }
      if (item?.details?.verificationRequired || item?.details?.stateChanged || item?.details?.unknownOutcome) return t('The save could not be verified. Reload preferences before saving again.')
      if (item?.status === 409) return t('Preferences changed since they were read. Reload before saving again.')
      if (item?.status === 401 || item?.status === 403) return t('Administrator access is unavailable. Sign in again to manage your preferences.')
      if (item?.status === 400 || item?.status === 422) return t('The server refused these preferences. Check each choice and reload.')
      return fallback
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; readable = false; revision = ''; lock(); if (loading) loading.hidden = false
      note(status, 'reading', t('Reading your preferences…'))
      try { paint(readAdminPreferencesView(await request('GET', '/api/admin/preferences'))) }
      catch (error) { apply.hidden = true; note(status, 'failed', failure(error, t('Preferences could not be read. Nothing was changed.'))) }
      finally { busy = false; lock(); if (loading) loading.hidden = true }
    }
    if (!admitted()) { lock(); note(status, 'unavailable', t('Personal preferences are unavailable here. Nothing was read or changed.')); return }
    reload.addEventListener('click', () => { saveStatus.hidden = true; void load() })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (busy || !readable || !revision || !admitted() || !request) return
      const desired = { language: language.value, theme: theme.value, density: density.value }
      if (!PREFERENCE_LOCALES.includes(desired.language) || !['light', 'dark'].includes(desired.theme) || !['comfortable', 'compact'].includes(desired.density)) { note(saveStatus, 'failed', t('Choose a listed value for every preference.')); return }
      busy = true; lock(); apply.hidden = true; note(saveStatus, 'reading', t('Saving your preferences…'))
      try {
        const ack = readAdminPreferencesView(await request('PUT', '/api/admin/preferences', { ...desired, expectedRevision: revision }))
        if (ack.state !== 'saved' || !ack.preferences || Object.entries(desired).some(([key, value]) => ack.preferences![key as keyof AdminPreferenceFields] !== value)) throw new Error('unverified_save')
        const verified = readAdminPreferencesView(await request('GET', '/api/admin/preferences'))
        if (verified.state !== 'saved' || verified.revision !== ack.revision || JSON.stringify(verified.preferences) !== JSON.stringify(ack.preferences) || verified.updatedAt !== ack.updatedAt) throw new Error('unverified_save')
        paint(verified); note(saveStatus, 'read', t('Preferences saved and read back. Apply them now or on your next page visit.'))
      } catch (error) { revision = ''; readable = false; note(saveStatus, 'failed', failure(error, t('The save could not be verified. Reload preferences before saving again.'))) }
      finally { busy = false; lock() }
    })
    void load()
  })
}
export const WHM_PREFERENCES_CLIENT_BINDING = `(()=>{const PREFERENCE_LOCALES=${JSON.stringify(PREFERENCE_LOCALES)};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readAdminPreferencesView=${readAdminPreferencesView.toString()};return ${bindWhmPreferences.toString()};})()`
