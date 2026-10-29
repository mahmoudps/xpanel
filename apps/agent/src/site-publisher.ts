import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { readFileSync } from 'node:fs'
import { catalogFromEntries, createTranslator, fail, isLocale, isUuid, isXpanelError, localeDirection, msgid, parsePo, SOURCE_LOCALE, validateDomainName, type Locale, type Translate } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import type { FileEntry, FileText, JailedFileManager } from './file-manager.ts'

export const SITE_PUBLISHER_TEMPLATES = ['coming-soon', 'maintenance', 'business-card'] as const
export const SITE_PUBLISHER_INDEXES = ['index.html', 'index.htm', 'index.php'] as const
export type SitePublisherDraft = { template: typeof SITE_PUBLISHER_TEMPLATES[number]; lang: Locale; title: string; message: string; email: string; phone: string }
export interface SitePublisherTarget { accountId: string; domainId: string; domainName: string; path: string }
export interface SitePublisherView {
  context: SitePublisherTarget
  revision: string
  files: { name: string; exists: boolean; hash: string | null; sizeBytes: number }[]
  recovery: { status: 'none' | 'prepared' | 'published' | 'restored'; createdAt: string | null }
  capabilities: { canPublish: boolean; canRollback: boolean }
  application: { status: 'read' | 'published' | 'rolled_back'; nativeQualified: false }
}
type Files = Pick<JailedFileManager, 'list' | 'readText' | 'writeTextChecked' | 'mkdir'>
type Original = { name: typeof SITE_PUBLISHER_INDEXES[number]; exists: boolean; hash: string | null; sizeBytes: number; mode: number }
type Journal = { version: 1; accountId: string; domainId: string; path: string; id: string; createdAt: string; status: 'prepared' | 'published' | 'restored'; publishedHash: string; originals: Original[] }
type Snapshot = { files: (FileText | null)[]; entries: FileEntry[]; journal: Journal | null; journalFile: FileText | null; revision: string }
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export const sitePublisherHash = (content: string): string => createHash('sha256').update(content).digest('hex')
const HASH = /^[0-9a-f]{64}$/
const text = (value: unknown, limit: number, multiline = false): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > limit || (multiline ? /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/ : /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/).test(value)) return fail('VALIDATION', 'site publisher text is invalid', unchanged)
  return value.trim()
}
export function parseSitePublisherDraft(value: unknown): SitePublisherDraft {
  if (!object(value) || !exact(value, ['template', 'lang', 'title', 'message', 'email', 'phone']) || !SITE_PUBLISHER_TEMPLATES.includes(value.template as SitePublisherDraft['template']) || !isLocale(value.lang)) return fail('VALIDATION', 'choose a built-in template and language', unchanged)
  const title = text(value.title, 120), message = text(value.message, 2000, true), email = text(value.email, 254), phone = text(value.phone, 40)
  if (!title || !message || email && !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email) || phone && !/^[+0-9() .-]{1,40}$/.test(phone)) return fail('VALIDATION', 'enter a title, message and valid optional contact details', unchanged)
  return { template: value.template as SitePublisherDraft['template'], lang: value.lang as Locale, title, message, email, phone }
}
const escape = (value: string): string => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
const TEMPLATE_LABELS: Readonly<Record<SitePublisherDraft['template'], string>> = { 'coming-soon': msgid('Coming soon'), maintenance: msgid('Under maintenance'), 'business-card': msgid('Welcome') }
const translators = new Map<Locale, Translate>()
// shortcut: the generated page reads the web UI catalog of this release on first use; move it to a shared catalog package if the agent renders more copy.
const pageTranslator = (locale: Locale): Translate => {
  let translate = translators.get(locale)
  if (!translate) {
    translate = createTranslator(locale, locale === SOURCE_LOCALE ? new Map() : catalogFromEntries(parsePo(readFileSync(new URL(`../../web/src/locales/${locale}.po`, import.meta.url), 'utf8')).entries))
    translators.set(locale, translate)
  }
  return translate
}
export function renderSitePublisherDraft(value: unknown): { html: string; hash: string } {
  const draft = parseSitePublisherDraft(value)
  const label = escape(pageTranslator(draft.lang)(TEMPLATE_LABELS[draft.template]))
  const html = '<!doctype html>\n<html lang="' + draft.lang + '" dir="' + localeDirection(draft.lang) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><title>' + escape(draft.title) + '</title><style>html{font-family:system-ui,sans-serif;color:#172436;background:#f4f7fa}body{margin:0;min-height:100vh;display:grid;place-items:center}main{box-sizing:border-box;width:min(42rem,calc(100% - 32px));padding:24px;border:1px solid #d8e1eb;border-radius:16px;background:#fff}small{color:#45617f}h1{font-size:clamp(2rem,6vw,3rem);line-height:1.2;margin:32px 0 0}p{white-space:pre-wrap;line-height:1.65;margin:8px 0 0;overflow-wrap:anywhere}address{font-style:normal;display:grid;gap:16px;margin-block-start:24px}a{color:#185e99}bdi{unicode-bidi:isolate}@media(max-width:600px){main{padding:16px}}</style></head><body><main><small>' + label + '</small><h1>' + escape(draft.title) + '</h1><p>' + escape(draft.message) + '</p>' + (draft.email || draft.phone ? '<address>' + (draft.email ? '<a href="mailto:' + escape(draft.email) + '"><bdi dir="ltr">' + escape(draft.email) + '</bdi></a>' : '') + (draft.phone ? '<span><bdi dir="ltr">' + escape(draft.phone) + '</bdi></span>' : '') + '</address>' : '') + '</main></body></html>\n'
  return { html, hash: sitePublisherHash(html) }
}
export function deriveSitePublisherTarget(account: Account, domain: Domain): SitePublisherTarget {
  if (!isUuid(account.id) || !isUuid(domain.id) || domain.accountId !== account.id) return fail('NOT_FOUND', 'domain not found', unchanged)
  if (account.status !== 'active' || domain.suspended || domain.kind === 'alias' || !['static', 'php'].includes(domain.siteType) || domain.redirect || domain.upstream) return fail('PRECONDITION_FAILED', 'choose an active file-backed domain', unchanged)
  const home = account.home, docRoot = domain.docRoot
  if (!posix.isAbsolute(home) || !posix.isAbsolute(docRoot) || posix.normalize(home) !== home || posix.normalize(docRoot) !== docRoot || /[\\\u0000-\u001f\u007f]/.test(home + docRoot)) return fail('PRECONDITION_FAILED', 'domain document root is not canonical', unchanged)
  const path = posix.relative(home, docRoot)
  if (!path || path === '..' || path.startsWith('../') || posix.isAbsolute(path) || path.split('/').some(part => !part || ['.', '..', '.trash', '.xpanel'].includes(part))) return fail('PRECONDITION_FAILED', 'document root must be a separate directory inside the account home', unchanged)
  return { accountId: account.id, domainId: domain.id, domainName: validateDomainName(domain.name), path }
}
/** All tenant I/O uses the descriptor-confined account runner; the caller holds its lifecycle lease. */
export class SitePublisherWorkspace {
  private readonly root: string
  private readonly statePath: string
  constructor(privateTarget: SitePublisherTarget, files: Files, authorize: () => Promise<void>) {
    this.target = privateTarget; this.files = files; this.authorize = authorize
    this.root = '.xpanel/site-publisher/' + privateTarget.domainId; this.statePath = this.root + '/state.json'
  }
  private readonly target: SitePublisherTarget
  private readonly files: Files
  private readonly authorize: () => Promise<void>
  private async read(path: string): Promise<FileText | null> {
    try { return await this.files.readText(path) } catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return null; throw error }
  }
  private parseJournal(file: FileText | null): Journal | null {
    if (!file) return null
    const invalid = (): never => fail('PRECONDITION_FAILED', 'site publisher recovery record requires inspection', unchanged)
    let value: unknown
    try { value = file.sizeBytes <= 8192 ? JSON.parse(file.content) : null } catch { return invalid() }
    if (!object(value) || !exact(value, ['version', 'accountId', 'domainId', 'path', 'id', 'createdAt', 'status', 'publishedHash', 'originals']) || value.version !== 1 || value.accountId !== this.target.accountId || value.domainId !== this.target.domainId || value.path !== this.target.path || typeof value.id !== 'string' || !/^\d{8}T\d{9}Z-[0-9a-f]{16}$/.test(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !['prepared', 'published', 'restored'].includes(value.status as string) || typeof value.publishedHash !== 'string' || !HASH.test(value.publishedHash) || !Array.isArray(value.originals) || value.originals.length !== 3) return invalid()
    for (const [i, item] of value.originals.entries()) if (!object(item) || !exact(item, ['name', 'exists', 'hash', 'sizeBytes', 'mode']) || item.name !== SITE_PUBLISHER_INDEXES[i] || typeof item.exists !== 'boolean' || (item.exists ? typeof item.hash !== 'string' || !HASH.test(item.hash) : item.hash !== null || item.sizeBytes !== 0) || !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0 || (item.sizeBytes as number) > 1024 * 1024 || !Number.isSafeInteger(item.mode) || (item.mode as number) <= 0 || ((item.mode as number) & ~0o640) !== 0) return invalid()
    return value as unknown as Journal
  }
  private async snapshot(): Promise<Snapshot> {
    const entries = await this.files.list(this.target.path, { showHidden: true })
    for (const name of SITE_PUBLISHER_INDEXES) { const entry = entries.find(item => item.name === name); if (entry && (entry.kind !== 'file' || entry.mode <= 0 || (entry.mode & ~0o640) !== 0)) return fail('PRECONDITION_FAILED', 'an index file is a link, directory or has unsupported permissions', unchanged) }
    const files: (FileText | null)[] = []
    for (const name of SITE_PUBLISHER_INDEXES) files.push(await this.read(this.target.path + '/' + name))
    const journalFile = await this.read(this.statePath), journal = this.parseJournal(journalFile)
    const revision = sitePublisherHash(JSON.stringify({ target: this.target, files, journal: journalFile }))
    return { entries, files, journal, journalFile, revision }
  }
  private matchesOriginal(file: FileText | null, original: Original): boolean { return original.exists ? !!file && sitePublisherHash(file.content) === original.hash && file.sizeBytes === original.sizeBytes : file === null }
  private recoverable(snapshot: Snapshot): boolean {
    const journal = snapshot.journal
    return !!journal && journal.status !== 'restored' && snapshot.files.every((file, i) => this.matchesOriginal(file, journal.originals[i]!) || (i === 0 ? !!file && sitePublisherHash(file.content) === journal.publishedHash : file === null))
  }
  private view(snapshot: Snapshot, status: SitePublisherView['application']['status']): SitePublisherView {
    const journal = snapshot.journal, recoverable = this.recoverable(snapshot)
    const published = journal?.status === 'published' && snapshot.files.every((file, i) => i === 0 ? !!file && sitePublisherHash(file.content) === journal.publishedHash : file === null)
    return { context: this.target, revision: snapshot.revision, files: snapshot.files.map((file, i) => ({ name: SITE_PUBLISHER_INDEXES[i]!, exists: file !== null, hash: file ? sitePublisherHash(file.content) : null, sizeBytes: file?.sizeBytes ?? 0 })), recovery: { status: journal?.status ?? 'none', createdAt: journal?.createdAt ?? null }, capabilities: { canPublish: this.documentRootRecoveryAvailable() && (!journal || journal.status === 'restored' || published), canRollback: recoverable }, application: { status, nativeQualified: false } }
  }
  // Index preimages cannot establish complete document-root recovery or 30-day retention.
  private documentRootRecoveryAvailable(): boolean { return false }
  async inspect(): Promise<SitePublisherView> { const snapshot = await this.snapshot(); await this.authorize(); return this.view(snapshot, 'read') }
  private async checked(path: string, content: string | null, before: FileText | null, mode = 0o640): Promise<FileText | null> {
    await this.authorize()
    const ack = await this.files.writeTextChecked(path, content, before, mode), after = await this.read(path)
    if (content === null ? ack !== null || after !== null : !ack || !after || after.content !== content || after.sizeBytes !== Buffer.byteLength(content) || after.mtime !== ack.mtime) return fail('SERVICE_UNAVAILABLE', 'site publisher write could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    return after
  }
  private async directories(path: string): Promise<void> {
    const parts = path.split('/'); let parent = ''
    for (const part of parts) {
      const entry = (await this.files.list(parent, { showHidden: true })).find(item => item.name === part)
      const next = parent ? parent + '/' + part : part
      if (!entry) { await this.authorize(); await this.files.mkdir(next, 0o750) }
      else if (entry.kind !== 'directory') return fail('PRECONDITION_FAILED', 'backup directory is not a safe directory', unchanged)
      parent = next
    }
  }
  private async restore(snapshot: Snapshot): Promise<void> {
    const journal = snapshot.journal
    if (!journal || !this.recoverable(snapshot)) return fail('CONFLICT', 'the index files changed outside this publication; recovery requires inspection', unchanged)
    const originals: (FileText | null)[] = []
    for (const original of journal.originals) {
      const backup = original.exists ? await this.read(this.root + '/' + journal.id + '/' + original.name) : null
      if (!this.matchesOriginal(backup, original)) return fail('PRECONDITION_FAILED', 'an index backup could not be verified; current files were kept', unchanged)
      originals.push(backup)
    }
    for (let i = 0; i < 3; i++) if (!this.matchesOriginal(snapshot.files[i]!, journal.originals[i]!)) await this.checked(this.target.path + '/' + SITE_PUBLISHER_INDEXES[i], originals[i]?.content ?? null, snapshot.files[i]!, journal.originals[i]!.mode)
    const after = await this.snapshot()
    if (!after.files.every((file, i) => this.matchesOriginal(file, journal.originals[i]!))) return fail('SERVICE_UNAVAILABLE', 'index recovery requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    await this.checked(this.statePath, JSON.stringify({ ...journal, status: 'restored' }), after.journalFile)
  }
  async publish(expectedRevision: string, draft: SitePublisherDraft, now = new Date()): Promise<SitePublisherView> {
    await this.authorize()
    if (!this.documentRootRecoveryAvailable()) return fail('PRECONDITION_FAILED', 'publishing requires verified complete document-root backup and recovery with 30-day retention outside the document root', unchanged)
    const generated = renderSitePublisherDraft(draft), before = await this.snapshot()
    if (before.revision !== expectedRevision) return fail('CONFLICT', 'index files changed; reload before publishing', unchanged)
    if (!this.view(before, 'read').capabilities.canPublish) return fail('PRECONDITION_FAILED', 'recover the prior publication before publishing again', unchanged)
    const id = now.toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(8).toString('hex')
    await this.directories(this.root + '/' + id)
    const originals: Original[] = []
    for (const [i, name] of SITE_PUBLISHER_INDEXES.entries()) {
      const file = before.files[i]!, mode = before.entries.find(entry => entry.name === name)?.mode ?? 0o640
      originals.push({ name, exists: file !== null, hash: file ? sitePublisherHash(file.content) : null, sizeBytes: file?.sizeBytes ?? 0, mode })
      if (file) await this.checked(this.root + '/' + id + '/' + name, file.content, null, mode)
    }
    const journal: Journal = { version: 1, accountId: this.target.accountId, domainId: this.target.domainId, path: this.target.path, id, createdAt: now.toISOString(), status: 'prepared', publishedHash: generated.hash, originals }
    // Persist the complete verified backup before touching any live index.
    await this.checked(this.statePath, JSON.stringify(journal), before.journalFile)
    try {
      for (let i = 1; i < 3; i++) if (before.files[i]) await this.checked(this.target.path + '/' + SITE_PUBLISHER_INDEXES[i], null, before.files[i]!)
      await this.checked(this.target.path + '/index.html', generated.html, before.files[0]!)
      const written = await this.snapshot()
      if (!written.files[0] || sitePublisherHash(written.files[0].content) !== generated.hash || written.files[1] || written.files[2]) return fail('SERVICE_UNAVAILABLE', 'published indexes could not be verified')
      await this.checked(this.statePath, JSON.stringify({ ...journal, status: 'published' }), written.journalFile)
      const after = await this.snapshot(); await this.authorize()
      if (!this.view(after, 'read').capabilities.canPublish || after.journal?.status !== 'published') return fail('SERVICE_UNAVAILABLE', 'publication verification was lost')
      return this.view(after, 'published')
    } catch (error) {
      try { await this.restore(await this.snapshot()) } catch { return fail('SERVICE_UNAVAILABLE', 'publication outcome requires inspection; retained backups may be recovered after reload', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
      return fail('SERVICE_UNAVAILABLE', 'publication failed and the previous indexes were restored', { stateChanged: false, rolledBack: true })
    }
  }
  async rollback(expectedRevision: string): Promise<SitePublisherView> {
    const before = await this.snapshot()
    if (before.revision !== expectedRevision) return fail('CONFLICT', 'index files changed; reload before recovery', unchanged)
    await this.restore(before)
    const after = await this.snapshot(); await this.authorize()
    return this.view(after, 'rolled_back')
  }
}
