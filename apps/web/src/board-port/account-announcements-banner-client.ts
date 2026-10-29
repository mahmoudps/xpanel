import type { MessageValues } from '../i18n.ts'
/// <reference lib="dom" />
import type { AccountAnnouncementNotice } from './account-announcements-banner.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from '../tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

/** Strict reader for { announcements } from /api/account/announcements; anything else is not shown. */
export function readAccountAnnouncements(value: unknown): AccountAnnouncementNotice[] {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number): boolean => object(item) && Object.keys(item).sort().join() === 'ar,en'
    && [item.en, item.ar].every(part => typeof part === 'string' && part.length > 0 && [...part].length <= max)
  const stamp = (item: unknown): boolean => item === null || typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item)
  if (!object(value) || !Array.isArray(value.announcements) || value.announcements.length > 50) throw new Error('invalid_announcements')
  const list = value.announcements.map(item => {
    if (!object(item) || Object.keys(item).sort().join() !== 'body,endsAt,id,severity,startsAt,title' || typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id)
      || !['info', 'warning', 'maintenance'].includes(item.severity as string) || !text(item.title, 140) || !text(item.body, 2000) || !stamp(item.startsAt) || !stamp(item.endsAt)) throw new Error('invalid_announcements')
    const title = item.title as AccountAnnouncementNotice['title'], body = item.body as AccountAnnouncementNotice['body']
    return { id: item.id, severity: item.severity as AccountAnnouncementNotice['severity'], title: { en: title.en, ar: title.ar }, body: { en: body.en, ar: body.ar }, startsAt: item.startsAt as string | null, endsAt: item.endsAt as string | null }
  })
  if (new Set(list.map(item => item.id)).size !== list.length) throw new Error('invalid_announcements')
  return list
}

/** Browser twin of renderAccountAnnouncementNotice: text nodes only. */
/** Notice chrome in one language; a preview in another language than the page supplies its own. */
/** `until` and `dismissFor` are whole messages with the {end} and {title} placeholders left in. */
export interface AccountAnnouncementLabels { info: string; warning: string; maintenance: string; until: string; dismiss: string; dismissFor: string }

/** Builds a notice in the content language `locale` (authored text is keyed by locale tag; English is always present). */
export function buildAccountAnnouncementNotice(notice: AccountAnnouncementNotice, locale: string, dismissible: boolean, labels?: AccountAnnouncementLabels): HTMLElement {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const label = labels ?? { info: t('Notice'), warning: t('Warning'), maintenance: t('Maintenance'), until: t('Until {end}'), dismiss: t('Dismiss'), dismissFor: t('Dismiss announcement: {title}') }
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (content !== undefined) node.textContent = content
    return node
  }
  const localized = (text: AccountAnnouncementNotice['title']): string => (text as Readonly<Record<string, string>>)[locale] ?? text.en
  const title = localized(notice.title)
  const item = element('div', 'xp-account-announcement')
  item.dataset.accountAnnouncement = notice.id
  item.dataset.severity = notice.severity
  item.setAttribute('role', 'status')
  const text = element('div', 'xp-account-announcement__text'), heading = element('p', 'xp-account-announcement__title')
  heading.append(element('span', 'xp-account-announcement__severity', label[notice.severity]), element('span', undefined, title))
  text.append(heading, element('p', 'xp-account-announcement__body', localized(notice.body)))
  if (notice.endsAt) {
    // Labels are whole messages; the date goes where {end} stands.
    const [before, after = ''] = label.until.split('{end}')
    const until = element('p', 'xp-help', before), value = element('bdi', undefined, formatDisplayDateTime(notice.endsAt))
    value.dir = 'ltr'
    until.append(value, after)
    text.append(until)
  }
  item.append(text)
  if (dismissible) {
    const button = element('button', 'xp-btn', label.dismiss)
    button.type = 'button'
    button.dataset.accountAnnouncementDismiss = notice.id
    const [lead, tail = ''] = label.dismissFor.split('{title}')
    button.setAttribute('aria-label', lead + title + tail)
    item.append(button)
  }
  return item
}

function bindAccountAnnouncements(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-account-announcements]')).filter(root => root.dataset.announcementsBound !== 'true')
  roots.forEach(root => { root.dataset.announcementsBound = 'true' })
  const live = roots.filter(root => !root.closest(denied))
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  if (!live.length || typeof request !== 'function') return
  let busy = false
  const buttons = (): HTMLButtonElement[] => live.flatMap(root => Array.from(root.querySelectorAll<HTMLButtonElement>('[data-account-announcement-dismiss]')))
  const paint = (list: AccountAnnouncementNotice[]): void => {
    for (const root of live) {
      const holder = root.querySelector<HTMLElement>('[data-account-announcements-list]'), status = root.querySelector<HTMLElement>('[data-account-announcements-status]')
      if (!holder) continue
      holder.replaceChildren(...list.map(notice => buildAccountAnnouncementNotice(notice, document.documentElement.lang, true)))
      if (status) { status.hidden = true; status.textContent = '' }
      root.hidden = list.length === 0
      root.dataset.state = 'read'
    }
  }
  for (const root of live) root.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-account-announcement-dismiss]') : null
    const id = button?.dataset.accountAnnouncementDismiss
    if (!button || !root.contains(button) || busy || !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return
    const focused = document.activeElement === button
    busy = true
    for (const control of buttons()) control.disabled = true
    try {
      const result = await request('POST', '/api/account/announcements/' + id + '/dismiss') as { dismissed?: unknown; announcements?: unknown } | null
      if (!result || result.dismissed !== id) throw new Error('unverified')
      paint(readAccountAnnouncements({ announcements: result.announcements }))
      if (focused) root.querySelector<HTMLButtonElement>('[data-account-announcement-dismiss]')?.focus()
    } catch {
      for (const control of buttons()) control.disabled = false
      const status = root.querySelector<HTMLElement>('[data-account-announcements-status]')
      if (status) { status.hidden = false; status.setAttribute('role', 'alert'); status.textContent = t('The announcement could not be dismissed. It is still shown; try again.') }
    } finally { busy = false }
  })
  void (async () => {
    // A failed read leaves the banner as rendered: nothing is claimed about announcements that could not be read.
    try { paint(readAccountAnnouncements(await request('GET', '/api/account/announcements'))) }
    catch { for (const root of live) root.dataset.state = 'failed' }
  })()
}

export const ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readAccountAnnouncements=${readAccountAnnouncements.toString()};const buildAccountAnnouncementNotice=${buildAccountAnnouncementNotice.toString()};return ${bindAccountAnnouncements.toString()};})()`
