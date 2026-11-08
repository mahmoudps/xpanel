import type { MessageValues } from '../i18n.ts'
/// <reference lib="dom" />
import type { AccountAnnouncementNotice } from './account-announcements-banner.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from '../tokens.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from '../client-templates.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate

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

/** Each preview owns whole translated messages, including exactly one date/title placeholder. */
export function readAccountAnnouncementLabels(value: unknown): AccountAnnouncementLabels {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'dismiss,dismissFor,info,maintenance,until,warning') throw new Error('invalid_announcement_labels')
  const labels = value as Record<string, unknown>
  if (Object.values(labels).some(item => typeof item !== 'string' || !item.trim() || item.length > 1024)
    || (labels.until as string).split('{end}').length !== 2 || (labels.dismissFor as string).split('{title}').length !== 2) throw new Error('invalid_announcement_labels')
  return labels as unknown as AccountAnnouncementLabels
}

function accountAnnouncementNoticeTemplate(root: HTMLElement, severity: AccountAnnouncementNotice['severity']): HTMLElement {
  if (!['info', 'warning', 'maintenance'].includes(severity)) throw new Error('invalid_announcement_severity')
  const slots = { severity: 'span', title: 'span', body: 'p', expiry: 'p', end: 'bdi', dismiss: 'button' } as const
  const clone = cloneClientTemplate(clientTemplate(root, 'account-announcement-notice-' + severity), 'div', Object.keys(slots))
  const present = [...(clone.hasAttribute('data-xp-slot') ? [clone] : []), ...clone.querySelectorAll<HTMLElement>('[data-xp-slot]')]
  if (present.length !== Object.keys(slots).length || present.some(node => !Object.hasOwn(slots, node.getAttribute('data-xp-slot')!)) || clone.getAttribute('role') !== 'status'
    || clone.querySelector('script,iframe,object,embed,form,input,select,textarea,a') || clone.querySelectorAll('button').length !== 1) throw new Error('invalid_announcement_template')
  for (const [slot, tag] of Object.entries(slots)) clientTemplateSlot(clone, slot, tag)
  const expiry = clientTemplateSlot(clone, 'expiry', 'p'), end = clientTemplateSlot(clone, 'end', 'bdi')
  const dismiss = clientTemplateSlot(clone, 'dismiss', 'button') as HTMLButtonElement
  if (!expiry.contains(end) || end.getAttribute('dir') !== 'ltr' || dismiss.type !== 'button' || !dismiss.disabled || dismiss.textContent?.trim()
    || clone.querySelector('[data-action],[data-filter-chip],[data-api-url]')
    || [...clone.querySelectorAll<HTMLElement>('*'), clone].some(node => [...node.attributes].some(attribute => /^on/i.test(attribute.name)))) throw new Error('invalid_announcement_template')
  return clone
}

/** Validate every possible notice before a read or preview edit, without inserting or enabling DOM. */
export function requireAccountAnnouncementTemplates(root: HTMLElement): void {
  for (const severity of ['info', 'warning', 'maintenance'] as const) accountAnnouncementNoticeTemplate(root, severity)
}

/** Builds a notice in the content language `locale` (authored text is keyed by locale tag; English is always present). */
export function buildAccountAnnouncementNotice(root: HTMLElement, notice: AccountAnnouncementNotice, locale: string, dismissible: boolean, labels?: AccountAnnouncementLabels): HTMLElement {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const label = readAccountAnnouncementLabels(labels ?? { info: t('Notice'), warning: t('Warning'), maintenance: t('Maintenance'), until: t('Until {end}'), dismiss: t('Dismiss'), dismissFor: t('Dismiss announcement: {title}') })
  const localized = (text: AccountAnnouncementNotice['title']): string => (text as Readonly<Record<string, string>>)[locale] ?? text.en
  const title = localized(notice.title)
  const item = accountAnnouncementNoticeTemplate(root, notice.severity)
  item.dataset.accountAnnouncement = notice.id
  item.dataset.severity = notice.severity
  clientTemplateSlot(item, 'severity', 'span').textContent = label[notice.severity]
  clientTemplateSlot(item, 'title', 'span').textContent = title
  clientTemplateSlot(item, 'body', 'p').textContent = localized(notice.body)
  const until = clientTemplateSlot(item, 'expiry', 'p'), value = clientTemplateSlot(item, 'end', 'bdi')
  if (notice.endsAt) {
    // Labels are whole messages; the date goes where {end} stands.
    const [before = '', after = ''] = label.until.split('{end}')
    value.textContent = formatDisplayDateTime(notice.endsAt)
    until.replaceChildren(before, value, after)
  } else until.remove()
  const button = clientTemplateSlot(item, 'dismiss', 'button') as HTMLButtonElement
  if (dismissible) {
    button.prepend(label.dismiss)
    button.disabled = false
    button.dataset.accountAnnouncementDismiss = notice.id
    const [lead = '', tail = ''] = label.dismissFor.split('{title}')
    button.setAttribute('aria-label', lead + title + tail)
  } else button.remove()
  for (const node of [item, ...item.querySelectorAll<HTMLElement>('[data-xp-slot]')]) node.removeAttribute('data-xp-slot')
  return item
}

/** The Home unread marker counts server-rendered warnings plus unread announcements. */
function syncNoticeCount(unread: number): void {
  for (const marker of document.querySelectorAll<HTMLElement>('[data-account-notices-count]')) {
    const total = Number(marker.dataset.accountNoticesBase ?? 0) + unread
    marker.textContent = String(total); marker.hidden = total === 0
  }
}

function bindAccountAnnouncements(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-account-announcements]')).filter(root => root.dataset.announcementsBound !== 'true')
  roots.forEach(root => { root.dataset.announcementsBound = 'true' })
  const live = roots.filter(root => !root.closest(denied))
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  if (!live.length || typeof request !== 'function') return
  const requireRoot = (root: HTMLElement): void => {
    const own = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest('[data-account-announcements]') === root)
    const lists = own('[data-account-announcements-list]'), statuses = own('[data-account-announcements-status]')
    if (lists.length !== 1 || lists[0]!.tagName !== 'DIV' || statuses.length !== 1 || statuses[0]!.tagName !== 'P') throw new Error('invalid_announcement_root')
    requireAccountAnnouncementTemplates(root)
  }
  try { for (const root of live) requireRoot(root) } catch {
    for (const root of live) {
      root.dataset.state = 'unavailable'
      root.querySelectorAll<HTMLButtonElement>('[data-account-announcement-dismiss]').forEach(button => { button.disabled = true })
    }
    return
  }
  let busy = false
  const buttons = (): HTMLButtonElement[] => live.flatMap(root => Array.from(root.querySelectorAll<HTMLButtonElement>('[data-account-announcement-dismiss]')))
  const paint = (list: AccountAnnouncementNotice[]): void => {
    for (const root of live) {
      if (!root.isConnected || root.closest(denied)) continue
      requireRoot(root)
      const holder = root.querySelector<HTMLElement>('[data-account-announcements-list]'), status = root.querySelector<HTMLElement>('[data-account-announcements-status]')
      if (!holder) continue
      holder.replaceChildren(...list.map(notice => buildAccountAnnouncementNotice(root, notice, document.documentElement.lang, true)))
      if (status) { status.hidden = true; status.textContent = '' }
      root.hidden = list.length === 0
      root.dataset.state = 'read'
    }
  }
  for (const root of live) root.addEventListener('click', async event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-account-announcement-dismiss]') : null
    const id = button?.dataset.accountAnnouncementDismiss
    if (!(button instanceof HTMLButtonElement) || button.type !== 'button' || button.disabled || !root.isConnected || button.closest(denied) || button.closest('[data-account-announcements]') !== root
      || busy || !id || button.closest<HTMLElement>('[data-account-announcement]')?.dataset.accountAnnouncement !== id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return
    try { for (const liveRoot of live) requireRoot(liveRoot) } catch { return }
    const focused = document.activeElement === button
    let confirmed = false
    const disabledBefore = new Map(buttons().map(control => [control, control.disabled]))
    busy = true
    for (const control of buttons()) control.disabled = true
    try {
      const result = await request('POST', '/api/account/announcements/' + id + '/dismiss') as { dismissed?: unknown; announcements?: unknown } | null
      if (!result || result.dismissed !== id) throw new Error('unverified')
      confirmed = true
      paint(readAccountAnnouncements({ announcements: result.announcements }))
      syncNoticeCount((result.announcements as unknown[]).length)
      if (focused) root.querySelector<HTMLButtonElement>('[data-account-announcement-dismiss]')?.focus()
    } catch {
      for (const control of buttons()) control.disabled = confirmed || disabledBefore.get(control) === true || !control.isConnected || !!control.closest(denied)
      if (confirmed) { root.hidden = false; for (const liveRoot of live) liveRoot.dataset.capabilityState = 'unavailable' }
      const status = root.querySelector<HTMLElement>('[data-account-announcements-status]')
      if (status) { status.hidden = false; status.setAttribute('role', 'alert'); status.textContent = confirmed ? t('The announcement was dismissed, but this page could not refresh. Reload the page.') : t('The announcement could not be dismissed. It is still shown; try again.') }
    } finally { busy = false }
  })
  void (async () => {
    // A failed read preserves existing notice facts and shows a failure status; it is never a successful empty read.
    try { const read = readAccountAnnouncements(await request('GET', '/api/account/announcements')); paint(read); syncNoticeCount(read.length) }
    catch {
      for (const root of live) {
        if (!root.isConnected || root.closest(denied)) continue
        try { requireRoot(root) } catch { root.dataset.state = 'unavailable'; continue }
        root.dataset.state = 'failed'
        const status = root.querySelector<HTMLElement>('[data-account-announcements-status]')
        if (status) {
          status.hidden = false
          status.setAttribute('role', 'alert')
          status.textContent = t('Announcements could not be read or verified. Nothing was changed.')
        }
        root.hidden = false
      }
    }
  })()
}

export const ACCOUNT_ANNOUNCEMENT_NOTICE_HELPERS_BINDING = `const accountAnnouncementNoticeTemplate=${accountAnnouncementNoticeTemplate.toString()};const requireAccountAnnouncementTemplates=${requireAccountAnnouncementTemplates.toString()};const readAccountAnnouncementLabels=${readAccountAnnouncementLabels.toString()};`
export const ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING = `(()=>{const syncNoticeCount=${syncNoticeCount.toString()};const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};${ACCOUNT_ANNOUNCEMENT_NOTICE_HELPERS_BINDING}const readAccountAnnouncements=${readAccountAnnouncements.toString()};const buildAccountAnnouncementNotice=${buildAccountAnnouncementNotice.toString()};return ${bindAccountAnnouncements.toString()};})()`
