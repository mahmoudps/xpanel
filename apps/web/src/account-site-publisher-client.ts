/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues, Locale } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = canonicalFormatDisplayDateTime

const SITEPUB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SITEPUB_HASH = /^[0-9a-f]{64}$/
const SITEPUB_NAMES = ['index.html', 'index.htm', 'index.php']
export interface SitePublisherDraft { template: 'coming-soon' | 'maintenance' | 'business-card'; lang: Locale; title: string; message: string; email: string; phone: string }
export interface SitePublisherView {
  context: { accountId: string; domainId: string; domainName: string; path: string }
  revision: string
  files: { name: string; exists: boolean; hash: string | null; sizeBytes: number }[]
  recovery: { status: 'none' | 'prepared' | 'published' | 'restored'; createdAt: string | null }
  capabilities: { canPublish: boolean; canRollback: boolean }
  application: { status: 'read' | 'published' | 'rolled_back'; nativeQualified: false }
}
function sitepubObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function sitepubExact(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return sitepubObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function sitepubText(value: unknown, limit: number): value is string { return typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) }
function sitepubTime(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }

/** Every result stays pinned to the account, selected domain and operation that requested it. */
export function readSitePublisherView(raw: unknown, accountId: string, domainId: string, status: SitePublisherView['application']['status'] = 'read'): SitePublisherView {
  const bad = (): never => { throw new Error('invalid_site_publisher_reply') }
  if (!SITEPUB_ID.test(accountId) || !SITEPUB_ID.test(domainId) || !sitepubExact(raw, ['context', 'revision', 'files', 'recovery', 'capabilities', 'application'])) return bad()
  const context = raw.context, recovery = raw.recovery, capabilities = raw.capabilities, application = raw.application
  if (!sitepubExact(context, ['accountId', 'domainId', 'domainName', 'path']) || context.accountId !== accountId || context.domainId !== domainId || !sitepubText(context.domainName, 253) || !context.domainName || !sitepubText(context.path, 4096) || !context.path || context.path.startsWith('/') || context.path.includes('\\') || context.path.split('/').some(part => !part || ['.', '..', '.xpanel', '.trash'].includes(part)) || typeof raw.revision !== 'string' || !SITEPUB_HASH.test(raw.revision)) return bad()
  if (!Array.isArray(raw.files) || raw.files.length !== 3 || raw.files.some((file, index) => !sitepubExact(file, ['name', 'exists', 'hash', 'sizeBytes']) || file.name !== SITEPUB_NAMES[index] || typeof file.exists !== 'boolean' || typeof file.sizeBytes !== 'number' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 1048576 || (file.exists ? typeof file.hash !== 'string' || !SITEPUB_HASH.test(file.hash) : file.hash !== null || file.sizeBytes !== 0))) return bad()
  if (!sitepubExact(recovery, ['status', 'createdAt']) || !['none', 'prepared', 'published', 'restored'].includes(recovery.status as string) || !(recovery.createdAt === null || sitepubTime(recovery.createdAt)) || (recovery.status === 'none') !== (recovery.createdAt === null)) return bad()
  if (!sitepubExact(capabilities, ['canPublish', 'canRollback']) || capabilities.canPublish !== false || typeof capabilities.canRollback !== 'boolean' || !sitepubExact(application, ['status', 'nativeQualified']) || application.status !== status || application.nativeQualified !== false) return bad()
  if (recovery.status === 'prepared' && capabilities.canPublish || recovery.status === 'none' && capabilities.canRollback || recovery.status === 'restored' && capabilities.canRollback) return bad()
  if (status === 'published' && (recovery.status !== 'published' || !(raw.files[0] as { exists: boolean }).exists) || status === 'rolled_back' && recovery.status !== 'restored') return bad()
  return raw as unknown as SitePublisherView
}

export function readSitePublisherPreview(raw: unknown): { html: string; hash: string } {
  if (!sitepubExact(raw, ['html', 'hash']) || typeof raw.html !== 'string' || raw.html.length > 32768 || !/^<!doctype html>/i.test(raw.html) || typeof raw.hash !== 'string' || !SITEPUB_HASH.test(raw.hash)
    || /<(?:script|iframe|object|embed|base|link|form)\b|\bon[a-z]+\s*=|\b(?:src|srcset|action)\s*=|javascript\s*:|@import|url\s*\(/i.test(raw.html)) throw new Error('invalid_site_publisher_preview')
  return { html: raw.html, hash: raw.hash }
}

export function sitePublisherUncertain(error: unknown): boolean {
  const value = sitepubObject(error) ? error : {}, detail = sitepubObject(value.details) ? value.details : sitepubObject(value.detail) ? value.detail : {}
  if ([value, detail].some(part => part.stateChanged === true || part.unknownOutcome === true || part.verificationRequired === true)) return true
  if ([value, detail].some(part => part.stateChanged === false)) return false
  return typeof value.status !== 'number' || value.status >= 500
}

function bindAccountSitePublisher(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-site-publisher]').forEach(root => {
    if (root.dataset.sitepubBound === 'true') return
    root.dataset.sitepubBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? '', find = <T extends HTMLElement>(name: string): T => root.querySelector<T>('[data-sitepub-' + name + ']')!
    const domain = find<HTMLSelectElement>('domain'), template = find<HTMLSelectElement>('template'), lang = find<HTMLSelectElement>('lang'), title = find<HTMLInputElement>('title'), message = find<HTMLTextAreaElement>('message'), email = find<HTMLInputElement>('email'), phone = find<HTMLInputElement>('phone')
    const status = find('status'), files = find('files'), path = find('path'), recovery = find('recovery'), created = find('created'), previewNote = find('preview-note'), frame = find<HTMLIFrameElement>('frame')
    const refresh = find<HTMLButtonElement>('refresh'), preview = find<HTMLButtonElement>('preview'), publish = find<HTMLButtonElement>('publish'), rollback = find<HTMLButtonElement>('rollback')
    if (![domain, template, lang, title, message, email, phone, status, files, path, recovery, created, previewNote, frame, refresh, preview, publish, rollback].every(Boolean)) return
    const eligible = (): boolean => root.isConnected && root.dataset.sitepubManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const drafts = [template, lang, title, message, email, phone]
    let view: SitePublisherView | null = null, busy = false, confirming = false, review = false, previewed: { signature: string; hash: string } | null = null
    const draft = (): SitePublisherDraft => ({ template: template.value as SitePublisherDraft['template'], lang: lang.value as SitePublisherDraft['lang'], title: title.value.trim(), message: message.value.trim(), email: email.value.trim(), phone: phone.value.trim() })
    const signature = (): string => JSON.stringify(draft())
    const note = (state: string, text: string): void => { status.dataset.state = state; status.textContent = text; status.setAttribute('role', ['failed', 'invalid', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      const unavailable = !eligible(), waiting = busy || confirming, blocked = unavailable || waiting || review || !view
      domain.disabled = unavailable || waiting; refresh.disabled = unavailable || waiting || !SITEPUB_ID.test(domain.value)
      for (const field of drafts) field.disabled = blocked
      preview.disabled = blocked
      publish.disabled = blocked || !view?.capabilities.canPublish || !previewed || previewed.signature !== signature()
      rollback.disabled = blocked || !view?.capabilities.canRollback
      root.setAttribute('aria-busy', String(waiting))
    }
    const clearPreview = (): void => { previewed = null; frame.removeAttribute('srcdoc'); frame.hidden = true; previewNote.textContent = t('Create a preview to see the generated page here.') }
    const paint = (): void => {
      path.textContent = view?.context.path ?? t(msgctxt('account-site-publisher-client', 'Not read'))
      const labels = { none: t('No publisher backup'), prepared: t('Interrupted operation: recovery required'), published: t('Published; backup available'), restored: t('Latest backup restored') }
      recovery.textContent = view ? labels[view.recovery.status] : t(msgctxt('account-site-publisher-client', 'Not read')); created.replaceChildren()
      if (view?.recovery.createdAt) { const time = document.createElement('time'); time.dateTime = view.recovery.createdAt; time.textContent = formatDisplayDateTime(view.recovery.createdAt); created.append(time) }
      else created.textContent = t('Not available')
      files.textContent = ''
      if (!view) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 3; cell.textContent = t('The current index files have not been read.'); row.append(cell); files.append(row) }
      for (const file of view?.files ?? []) {
        const row = document.createElement('tr')
        for (const [text, technical] of [[file.name, true], [file.exists ? t('Present') : t('Absent'), false], [String(file.sizeBytes), true]] as const) { const cell = document.createElement('td'), content = document.createElement(technical ? 'bdi' : 'span'); if (technical) content.dir = 'ltr'; content.textContent = text; cell.append(content); row.append(cell) }
        files.append(row)
      }
      if (view && !view.capabilities.canPublish && status.dataset.state === 'read') note('read', t('Current files were read. Preview is available; publishing requires verified complete-site backup and recovery.'))
      lock()
    }
    const request = (method: string, suffix = '', body?: unknown): Promise<unknown> => !send || !eligible() || !SITEPUB_ID.test(domain.value) ? Promise.reject({ stateChanged: false }) : body === undefined ? send(method, '/api/domains/' + domain.value + '/site-publisher' + suffix) : send(method, '/api/domains/' + domain.value + '/site-publisher' + suffix, body)
    const read = async (): Promise<void> => {
      if (busy || confirming || !eligible() || !SITEPUB_ID.test(domain.value)) return
      const selected = domain.value; busy = true; clearPreview(); note('reading', t('Reading current files…')); lock()
      try { view = readSitePublisherView(await request('GET'), accountId, selected); review = false; note('read', view.recovery.status === 'prepared' ? t('A previous operation stopped. Restore its backup before publishing again.') : t('Current files were read. Preview a page before publishing.')) }
      catch { view = null; note('failed', t('The current files could not be verified. Read them again before continuing.')) }
      finally { busy = false; paint() }
    }
    const validate = (): boolean => {
      const value = draft()
      if (!['coming-soon', 'maintenance', 'business-card'].includes(value.template) || !['en', 'ar'].includes(value.lang) || !value.title || value.title.length > 120 || !value.message || value.message.length > 2000 || value.email.length > 254 || value.phone.length > 40 || value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) { note('invalid', t('Enter a title and message within their limits, and a valid optional contact email.')); return false }
      return true
    }
    const makePreview = async (): Promise<void> => {
      if (preview.disabled || !validate()) return
      const selected = domain.value, captured = signature(); busy = true; clearPreview(); note('reading', t('Generating the static preview…')); lock()
      try { const result = readSitePublisherPreview(await request('POST', '/preview', draft())); if (domain.value !== selected || signature() !== captured) throw new Error('preview_changed'); frame.srcdoc = result.html; frame.hidden = false; previewed = { signature: captured, hash: result.hash }; previewNote.textContent = t('This is the exact generated page. Publishing replaces the current index files after saving a backup.'); note('previewed', t('Preview ready. Review the page before publishing.')) }
      catch { clearPreview(); note('failed', t('The preview could not be verified. Nothing was published.')) }
      finally { busy = false; lock() }
    }
    const mutate = async (operation: 'publish' | 'rollback'): Promise<void> => {
      if (!view || (operation === 'publish' ? publish.disabled : rollback.disabled) || !askDialog) { if (!askDialog) note('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      const selected = domain.value, before = view, captured = signature(), expectedHash = previewed?.hash
      confirming = true; lock()
      let confirmed = false
      try { confirmed = await askDialog({ title: operation === 'publish' ? t('Publish this page?') : t('Restore the latest backup?'), body: operation === 'publish' ? t('The previewed page will replace the index files for {domain}. Existing files are backed up first.', { domain: before.context.domainName }) : t('Restore the saved index files for {domain} and remove the publisher page.', { domain: before.context.domainName }), danger: true, confirm: operation === 'publish' ? t('Publish page') : t('Restore backup') }) === true }
      catch { confirmed = false }
      finally { confirming = false; lock() }
      if (!confirmed || !eligible() || domain.value !== selected || view !== before || review || operation === 'publish' && (captured !== signature() || !expectedHash)) return
      busy = true; note('saving', operation === 'publish' ? t('Publishing and verifying saved files…') : t('Restoring and verifying saved files…')); lock()
      try {
        const result = readSitePublisherView(await request('POST', '/' + operation, { expectedRevision: before.revision, ...(operation === 'publish' ? { draft: draft() } : {}) }), accountId, selected, operation === 'publish' ? 'published' : 'rolled_back')
        if (result.revision === before.revision || operation === 'publish' && result.files[0]?.hash !== expectedHash) throw new Error('invalid_site_publisher_ack')
        const observed = readSitePublisherView(await request('GET'), accountId, selected)
        if (observed.revision !== result.revision || JSON.stringify(observed.files) !== JSON.stringify(result.files) || JSON.stringify(observed.recovery) !== JSON.stringify(result.recovery)) throw new Error('invalid_site_publisher_readback')
        view = observed; review = false; clearPreview(); note('saved', operation === 'publish' ? t('The page was published and the saved files were read back.') : t('The latest backup was restored and the files were read back.'))
      } catch (error) {
        const value = sitepubObject(error) ? error : {}, conflict = value.code === 'CONFLICT' || value.status === 409
        review = conflict || sitePublisherUncertain(error)
        if (review) clearPreview()
        note(conflict ? 'stale' : review ? 'uncertain' : 'failed', conflict ? t('The files changed. Read current files before trying again.') : review ? t('The result is uncertain. Read current files and review the recovery state before another action.') : t('The request was refused. No change was confirmed.'))
      } finally { busy = false; paint() }
    }
    for (const control of drafts) control.addEventListener(control instanceof HTMLSelectElement ? 'change' : 'input', () => { if (previewed && previewed.signature !== signature()) clearPreview(); lock() })
    domain.addEventListener('change', () => { view = null; review = false; clearPreview(); paint(); void read() })
    refresh.addEventListener('click', () => { void read() }); preview.addEventListener('click', () => { void makePreview() }); publish.addEventListener('click', () => { void mutate('publish') }); rollback.addEventListener('click', () => { void mutate('rollback') })
    if (!send || !eligible() || !SITEPUB_ID.test(accountId) || !SITEPUB_ID.test(domain.value)) { for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')) control.disabled = true; note('unavailable', t('Site publishing is unavailable here. Nothing was read or changed.')); return }
    paint(); void read()
  })
}

export const ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const SITEPUB_ID=${SITEPUB_ID.toString()};const SITEPUB_HASH=${SITEPUB_HASH.toString()};const SITEPUB_NAMES=${JSON.stringify(SITEPUB_NAMES)};const sitepubObject=${sitepubObject.toString()};const sitepubExact=${sitepubExact.toString()};const sitepubText=${sitepubText.toString()};const sitepubTime=${sitepubTime.toString()};const readSitePublisherView=${readSitePublisherView.toString()};const readSitePublisherPreview=${readSitePublisherPreview.toString()};const sitePublisherUncertain=${sitePublisherUncertain.toString()};return ${bindAccountSitePublisher.toString()};})()`
