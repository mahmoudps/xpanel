/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface PersonalPreferencesView {
  state: 'default' | 'saved' | 'invalid'; locale: string | null; inheritedLocale: string | null
  noticePosition: string; notifications: { disk: boolean; bandwidth: boolean; announcements: boolean }; onboardingDismissed: boolean
  choices: { locales: string[]; positions: string[] }; revision: string; updatedAt: string | null
}

/** Strict reader of /api/auth/personal-preferences; anything else is not shown or saved back. */
export function readPersonalPreferences(raw: unknown): PersonalPreferencesView {
  const v = raw as PersonalPreferencesView | null, n = v?.notifications
  if (!v || typeof v !== 'object' || !['default', 'saved', 'invalid'].includes(v.state) || !(v.locale === null || typeof v.locale === 'string') || !(v.inheritedLocale === null || typeof v.inheritedLocale === 'string') || typeof v.noticePosition !== 'string'
    || !n || ![n.disk, n.bandwidth, n.announcements].every(item => typeof item === 'boolean') || typeof v.onboardingDismissed !== 'boolean' || !Array.isArray(v.choices?.locales) || !Array.isArray(v.choices?.positions)
    || typeof v.revision !== 'string' || !/^[0-9a-f]{64}$/.test(v.revision)) throw new Error('invalid_personal_preferences')
  return v
}

const ROUTE = '/api/auth/personal-preferences'

function bindPersonalPreferences(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  if (!request) return
  const put = (view: PersonalPreferencesView, change: Partial<PersonalPreferencesView>): Promise<PersonalPreferencesView> => request('PUT', ROUTE, { locale: view.locale, noticePosition: view.noticePosition, notifications: view.notifications, onboardingDismissed: view.onboardingDismissed, ...change, expectedRevision: view.revision }).then(readPersonalPreferences)
  for (const root of document.querySelectorAll<HTMLElement>('[data-personal-preferences]')) {
    if (root.dataset.personalBound === 'true') continue
    root.dataset.personalBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-personal-status]'), save = root.querySelector<HTMLButtonElement>('[data-personal-save]')
    const locale = root.querySelector<HTMLSelectElement>('[data-personal-locale]'), position = root.querySelector<HTMLSelectElement>('[data-personal-position]')
    const switches = [...root.querySelectorAll<HTMLInputElement>('[data-personal-notify]')]
    let view: PersonalPreferencesView | null = null
    const note = (state: string, text: string): void => { if (status) { status.dataset.state = state; status.textContent = text } }
    const paint = (next: PersonalPreferencesView): void => {
      view = next
      if (locale) { locale.value = next.locale ?? ''; locale.disabled = false }
      if (position) { position.value = next.noticePosition; position.disabled = false }
      for (const item of switches) { item.checked = next.notifications[item.dataset.personalNotify as keyof PersonalPreferencesView['notifications']]; item.disabled = false }
      if (save) save.disabled = next.state === 'invalid'
    }
    void request('GET', ROUTE).then(raw => { paint(readPersonalPreferences(raw)); note(view!.state === 'invalid' ? 'failed' : 'read', view!.state === 'invalid' ? t('The saved preferences need review. Nothing can be saved here.') : view!.inheritedLocale && !view!.locale ? t('Preferences read. You use the account owner language until you choose your own.') : t('Preferences read.')) })
      .catch(() => note('failed', t('Preferences could not be read. Nothing was changed.')))
    save?.addEventListener('click', () => {
      if (!view || save.disabled) return
      const before = view, nextLocale = locale ? locale.value || null : view.locale
      const notifications = { ...view.notifications }
      for (const item of switches) notifications[item.dataset.personalNotify as keyof typeof notifications] = item.checked
      save.disabled = true; note('saving', t('Saving your preferences…'))
      put(before, { locale: nextLocale, noticePosition: position?.value ?? before.noticePosition, notifications }).then(next => {
        paint(next); note('saved', t('Preferences saved.'))
        document.documentElement.dataset.noticePosition = next.noticePosition
        if (next.locale !== before.locale) { const url = new URL(location.href); url.searchParams.delete('lang'); location.assign(url.href) }
      }).catch((error: { status?: number }) => { save.disabled = false; note('failed', error?.status === 409 ? t('The preferences changed. Reload the page before saving again.') : t('The preferences could not be saved. Reload them before retrying.')) })
    })
  }
  for (const root of document.querySelectorAll<HTMLElement>('[data-onboarding]')) {
    const dismiss = root.querySelector<HTMLButtonElement>('[data-onboarding-dismiss]')
    if (!dismiss || root.dataset.personalBound === 'true') continue
    root.dataset.personalBound = 'true'
    dismiss.disabled = false
    dismiss.addEventListener('click', () => {
      dismiss.disabled = true
      request('GET', ROUTE).then(raw => put(readPersonalPreferences(raw), { onboardingDismissed: true })).then(next => { if (next.onboardingDismissed) root.hidden = true }).catch(() => { dismiss.disabled = false })
    })
  }
}

export const PERSONAL_PREFERENCES_CLIENT_BINDING = `(()=>{const readPersonalPreferences=${readPersonalPreferences.toString()};const ROUTE=${JSON.stringify(ROUTE)};(${bindPersonalPreferences.toString()})()})`
