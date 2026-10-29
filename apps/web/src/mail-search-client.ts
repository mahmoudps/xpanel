/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

export interface MailSearchSummary { uid: number; from: string; fromName?: string; to: string; cc?: string; subject: string; receivedAt: string; preview?: string; unread: boolean; sizeBytes: number }
export interface MailSearchContext { mailbox: string; folder: string; uidValidity: number; query: string }
export interface MailSearchPage { context: MailSearchContext; messages: MailSearchSummary[]; page: { limit: number; totalMatches: number; nextCursor: string | null } }
export interface MailSearchSelection { mailbox: string; folder: string; uid: number; uidValidity: number }
export interface MailSearchMessage { context: Omit<MailSearchContext, 'query'>; message: MailSearchSummary & { body: string }; bodyTruncated: boolean }
const MAIL_SEARCH_FOLDER = /^[A-Za-z][A-Za-z0-9._-]{0,40}$/
const MAIL_SEARCH_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
export function mailSearchObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function mailSearchText(value: unknown, max = 65536): value is string { return typeof value === 'string' && value.length <= max && value.isWellFormed() }
export function mailSearchUid(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4294967295 }
export function mailSearchQuery(value: string): string {
  if (!mailSearchText(value, 1024)) throw new Error('invalid_search_query')
  const query = value.normalize('NFC').trim()
  if (!query || Array.from(query).length > 256 || new TextEncoder().encode(query).length > 1024 || MAIL_SEARCH_CONTROL.test(query)) throw new Error('invalid_search_query')
  return query
}
export function readMailSearchSummary(value: unknown): MailSearchSummary {
  if (!mailSearchObject(value) || !mailSearchUid(value.uid) || !['from', 'to', 'subject', 'receivedAt'].every(key => mailSearchText(value[key]))
    || !['fromName', 'cc', 'preview'].every(key => value[key] === undefined || mailSearchText(value[key]))
    || typeof value.unread !== 'boolean' || typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0
    || !Number.isFinite(Date.parse(value.receivedAt as string))) throw new Error('invalid_search_message')
  return { uid: value.uid, from: value.from as string, to: value.to as string, subject: value.subject as string, receivedAt: value.receivedAt as string,
    unread: value.unread, sizeBytes: value.sizeBytes, ...(value.fromName === undefined ? {} : { fromName: value.fromName as string }),
    ...(value.cc === undefined ? {} : { cc: value.cc as string }), ...(value.preview === undefined ? {} : { preview: value.preview as string }) }
}
export function readMailSearchPage(value: unknown, expected: { mailbox: string; folder: string; query: string; limit: number; uidValidity?: number }): MailSearchPage {
  if (!mailSearchObject(value) || !mailSearchObject(value.context) || !mailSearchObject(value.page) || !Array.isArray(value.messages)) throw new Error('invalid_search_page')
  const context = value.context, page = value.page
  if (context.mailbox !== expected.mailbox || context.folder !== expected.folder || context.query !== expected.query || !mailSearchUid(context.uidValidity)
    || expected.uidValidity !== undefined && context.uidValidity !== expected.uidValidity || page.limit !== expected.limit
    || typeof page.totalMatches !== 'number' || !Number.isSafeInteger(page.totalMatches) || page.totalMatches < 0
    || value.messages.length > expected.limit || value.messages.length > page.totalMatches
    || !(page.nextCursor === null || mailSearchText(page.nextCursor, 4096) && !!page.nextCursor && !MAIL_SEARCH_CONTROL.test(page.nextCursor))) throw new Error('invalid_search_page')
  const messages = value.messages.map(readMailSearchSummary)
  if (new Set(messages.map(message => message.uid)).size !== messages.length) throw new Error('duplicate_search_uid')
  if (page.totalMatches === 0 && page.nextCursor !== null) throw new Error('invalid_empty_search_cursor')
  if (page.totalMatches > 0 && messages.length === 0) throw Object.assign(new Error('search_page_changed'), { mailSearchStale: true })
  return { context: { mailbox: expected.mailbox, folder: expected.folder, query: expected.query, uidValidity: context.uidValidity }, messages,
    page: { limit: expected.limit, totalMatches: page.totalMatches, nextCursor: page.nextCursor as string | null } }
}
export function readMailSearchMessage(value: unknown, expected: MailSearchSelection): MailSearchMessage {
  if (!mailSearchObject(value) || !mailSearchObject(value.context) || !mailSearchObject(value.message)
    || value.context.mailbox !== expected.mailbox || value.context.folder !== expected.folder || !mailSearchUid(value.context.uidValidity) || value.context.uidValidity !== expected.uidValidity
    || value.message.uid !== expected.uid || !mailSearchText(value.message.body, 262144) || new TextEncoder().encode(value.message.body).length > 262144
    || typeof value.bodyTruncated !== 'boolean') throw new Error('invalid_search_detail')
  return { context: { mailbox: expected.mailbox, folder: expected.folder, uidValidity: expected.uidValidity },
    message: { ...readMailSearchSummary(value.message), body: value.message.body }, bodyTruncated: value.bodyTruncated }
}

function bindMailSearch(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-search-workspace]').forEach(root => {
    if (root.dataset.mailSearchBound === 'true') return
    root.dataset.mailSearchBound = 'true'
    const mailbox = root.dataset.searchMailbox ?? ''
    const form = root.querySelector<HTMLFormElement>('[data-mail-search-form]')!, query = root.querySelector<HTMLInputElement>('[data-mail-search-query]')!
    const folder = root.querySelector<HTMLSelectElement>('[data-mail-search-folder]')!, results = root.querySelector<HTMLUListElement>('[data-mail-search-results]')!
    const status = root.querySelector<HTMLElement>('[data-mail-search-status]')!, article = root.querySelector<HTMLElement>('[data-mail-search-message]')!
    const submit = root.querySelector<HTMLButtonElement>('[data-mail-search-submit]')!, clear = root.querySelector<HTMLButtonElement>('[data-mail-search-clear]')!, next = root.querySelector<HTMLButtonElement>('[data-mail-search-next]')!
    const field = (key: string): HTMLElement | null => root.querySelector<HTMLElement>('[data-mail-search-' + key + ']')
    if (!form || !query || !folder || !results || !status || !article || !submit || !clear || !next || ['subject', 'from', 'to', 'date', 'body', 'truncated'].some(key => !field(key))) return
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.searchEnabled === 'true' && root.dataset.searchMailbox === mailbox && !!mailbox && !root.closest(denied) && !!send
    let generation = 0, busy = false, needsFresh = false, active: MailSearchPage | null = null, messages: MailSearchSummary[] = [], selectedUid: number | null = null
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'stale' ? 'alert' : 'status') }
    const draft = (): { query: string; folder: string } => { if (!MAIL_SEARCH_FOLDER.test(folder.value)) throw new Error('invalid_search_folder'); return { query: mailSearchQuery(query.value), folder: folder.value } }
    const matches = (): boolean => { try { const current = draft(); return !!active && current.query === active.context.query && current.folder === active.context.folder } catch { return false } }
    const controls = (): void => {
      const blocked = !admitted()
      query.disabled = blocked; folder.disabled = blocked; submit.disabled = blocked || busy; clear.disabled = blocked
      next.disabled = blocked || busy || needsFresh || !matches() || !active?.page.nextCursor
      results.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = blocked || busy || needsFresh || !matches(); button.setAttribute('aria-pressed', String(Number(button.dataset.mailSearchUid) === selectedUid)) })
      root.setAttribute('aria-busy', String(busy))
    }
    const hideMessage = (): void => { article.hidden = true; selectedUid = null; for (const key of ['subject', 'from', 'to', 'date', 'body']) field(key)!.textContent = ''; field('truncated')!.hidden = true }
    const paintResults = (): void => {
      results.textContent = ''
      for (const message of messages) {
        const item = document.createElement('li'), button = document.createElement('button'), subject = document.createElement('strong'), sender = document.createElement('bdi'), at = document.createElement('bdi')
        button.type = 'button'; button.className = 'xp-btn xp-mail-search__result'; button.dataset.mailSearchUid = String(message.uid)
        subject.dir = 'auto'; subject.textContent = message.subject || t(msgctxt('mail-search-client', '(No subject)'))
        sender.dir = 'auto'; sender.textContent = message.fromName ? message.fromName + ' <' + message.from + '>' : message.from
        const fullMailDate = formatMailDateTime(message.receivedAt)
        at.dir = 'ltr'; at.textContent = fullMailDate === '—' ? formatMailDateTime(new Date(message.receivedAt)) : fullMailDate
        button.append(subject, sender, at)
        if (message.preview) { const preview = document.createElement('span'); preview.dir = 'auto'; preview.textContent = message.preview; button.append(preview) }
        button.addEventListener('click', () => { void openMessage(message) }); item.append(button); results.append(item)
      }
      controls()
    }
    const request = (path: string): Promise<unknown> => admitted() && send ? send('GET', path) : Promise.reject(new Error('search_unavailable'))
    const unavailable = (): void => { generation++; busy = false; needsFresh = true; active = null; messages = []; results.textContent = ''; hideMessage(); announce('unavailable', t('Search is unavailable for this mailbox session. No message is shown.')); controls() }
    async function search(more: boolean): Promise<void> {
      if (busy || !admitted() || more && (needsFresh || !matches() || !active?.page.nextCursor)) return
      let captured: { query: string; folder: string }
      try { captured = draft() } catch { announce('failed', t('Enter 1 through 256 valid Unicode characters without control characters. Nothing was sent.')); return }
      const baseline = active, cursor = more ? baseline!.page.nextCursor : null, token = ++generation
      busy = true; hideMessage(); controls(); announce('reading', t('Reading matching messages…'))
      const params = new URLSearchParams({ q: captured.query, folder: captured.folder, limit: '20' }); if (cursor !== null) params.set('cursor', cursor)
      try {
        const page = readMailSearchPage(await request('/api/webmail/search?' + params), { mailbox, ...captured, limit: 20, ...(more ? { uidValidity: baseline!.context.uidValidity } : {}) })
        if (token !== generation) return
        if (!admitted()) { unavailable(); return }
        const prior = more ? messages : []
        if (more && (page.page.nextCursor === cursor || prior.some(message => page.messages.some(current => current.uid === message.uid)) || prior.length + page.messages.length > page.page.totalMatches)) throw Object.assign(new Error('search_cursor_changed'), { mailSearchStale: true })
        messages = [...prior, ...page.messages]; active = page; needsFresh = false; paintResults()
        announce(page.page.totalMatches === 0 ? 'no-matches' : 'read', page.page.totalMatches === 0
          ? t('No matching messages were returned.')
          : t('Messages read: {count} / {total}', { count: messages.length, total: page.page.totalMatches }))
      } catch (error) {
        if (token !== generation) return
        needsFresh = true
        const stale = mailSearchObject(error) && (error.status === 409 || error.mailSearchStale === true)
        announce(stale ? 'stale' : 'failed', stale ? t('The search page changed or expired. Start a fresh search; your text is kept.') : t('Matching messages could not be read or verified. Your search text is kept; no retry was sent.'))
      } finally { if (token === generation) { busy = false; controls() } }
    }
    async function openMessage(summary: MailSearchSummary): Promise<void> {
      if (busy || needsFresh || !matches() || !active || !admitted()) return
      const selection: MailSearchSelection = { mailbox, folder: active.context.folder, uid: summary.uid, uidValidity: active.context.uidValidity }, token = ++generation
      busy = true; hideMessage(); controls(); announce('opening', t('Reading the selected message…'))
      const params = new URLSearchParams({ uid: String(selection.uid), folder: selection.folder, uidValidity: String(selection.uidValidity) })
      try {
        const detail = readMailSearchMessage(await request('/api/webmail/search-message?' + params), selection)
        if (token !== generation) return
        if (!admitted()) { unavailable(); return }
        const message = detail.message
        field('subject')!.textContent = message.subject || t(msgctxt('mail-search-client', '(No subject)'))
        field('from')!.textContent = message.fromName ? message.fromName + ' <' + message.from + '>' : message.from
        const fullMailDate = formatMailDateTime(message.receivedAt)
        field('to')!.textContent = message.to; field('date')!.textContent = fullMailDate === '—' ? formatMailDateTime(new Date(message.receivedAt)) : fullMailDate
        field('body')!.textContent = message.body; field('truncated')!.hidden = !detail.bodyTruncated
        selectedUid = message.uid
        article.dispatchEvent(new CustomEvent('xpanel:mail-search-selection', { bubbles: true, detail: selection }))
        article.hidden = false; announce('message', t('Selected message read as plain text.'))
      } catch (error) {
        if (token !== generation) return
        const stale = mailSearchObject(error) && (error.status === 409 || error.status === 404)
        needsFresh ||= stale
        announce(stale ? 'stale' : 'failed', stale ? t('The selected message changed or is unavailable. Start a fresh search.') : t('The selected message could not be read or verified. No previous body was shown.'))
      } finally { if (token === generation) { busy = false; controls() } }
    }
    const edited = (): void => { if (!admitted()) { unavailable(); return } generation++; busy = false; needsFresh = true; hideMessage(); announce(query.value.trim() ? 'dirty' : 'idle', t('Submit the current search text to read matching messages.')); controls() }
    form.addEventListener('submit', event => { event.preventDefault(); void search(false) })
    query.addEventListener('input', edited); folder.addEventListener('change', edited)
    next.addEventListener('click', () => { void search(true) })
    clear.addEventListener('click', () => { if (!admitted()) { unavailable(); return } generation++; busy = false; needsFresh = false; active = null; messages = []; query.value = ''; hideMessage(); paintResults(); announce('idle', t('Search cleared. Enter text to search this mailbox.')) })
    if (!admitted()) { unavailable(); return }
    announce('idle', t('Enter search text to read matching messages.')); controls()
  })
}

export const MAIL_SEARCH_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const MAIL_SEARCH_FOLDER=${MAIL_SEARCH_FOLDER.toString()};const MAIL_SEARCH_CONTROL=${MAIL_SEARCH_CONTROL.toString()};const mailSearchObject=${mailSearchObject.toString()};const mailSearchText=${mailSearchText.toString()};const mailSearchUid=${mailSearchUid.toString()};const mailSearchQuery=${mailSearchQuery.toString()};const readMailSearchSummary=${readMailSearchSummary.toString()};const readMailSearchPage=${readMailSearchPage.toString()};const readMailSearchMessage=${readMailSearchMessage.toString()};return ${bindMailSearch.toString()};})()`
