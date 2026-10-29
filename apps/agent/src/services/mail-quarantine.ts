import { createHash, randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import {
  QUARANTINE_PAGE_UIDS, QUARANTINE_RELEASE_MAX_BYTES, QUARANTINE_MAX_PENDING, QUARANTINE_REVISION, quarantineIdentity, parseQuarantineMutation,
} from '../../../../packages/core/src/mail-quarantine.ts'
import type { QuarantineScope, QuarantineLocator, QuarantineMessage, QuarantineAvailable, QuarantineReadResult, QuarantineMutation, QuarantineActionResult, QuarantineExpiryResult } from '../../../../packages/core/src/mail-quarantine.ts'
export { QUARANTINE_PAGE_UIDS, QUARANTINE_RELEASE_MAX_BYTES, QUARANTINE_MAX_PENDING, parseQuarantineMutation } from '../../../../packages/core/src/mail-quarantine.ts'
export type { QuarantineScope, QuarantineLocator, QuarantineMessage, QuarantinePolicy, QuarantineAvailable, QuarantineUnavailable, QuarantineReadResult, QuarantineMutation, QuarantineActionResult, QuarantineExpiryResult } from '../../../../packages/core/src/mail-quarantine.ts'
import type { AgentExecutor, ConfigTestResult } from '../executor.ts'
import {
  assertMailQuarantineArgv, QUARANTINE_FOLDERS, QUARANTINE_GUID, QUARANTINE_MAILBOX, QUARANTINE_UUID,
  QUARANTINE_STATUS_FIELDS, QUARANTINE_SUMMARY_FIELDS, QUARANTINE_RAW_FIELDS, QUARANTINE_ID_FIELDS,
  quarantineBayesPath, quarantineStagePath,
} from './mail-quarantine-commands.ts'

const MAX_JSON_BYTES = 2 * 1024 * 1024
const REVISION = QUARANTINE_REVISION
const jsonObject = quarantineIdentity.object
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uint = (value: unknown, allowZero = false): number => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= (allowZero ? 0 : 1) && number <= 4294967295
    ? number : fail('PRECONDITION_FAILED', 'quarantine source returned an invalid integer', { stateChanged: false })
}
const header = (value: unknown, maximum = 2048): string => {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > maximum) return fail('PRECONDITION_FAILED', 'quarantine source returned invalid headers', { stateChanged: false })
  return value.replace(/\r?\n[ \t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, ' ').trim()
}
const unixDate = (value: unknown): string | null => {
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 253402300799 ? new Date(seconds * 1000).toISOString() : null
}

/** Supplied only by trusted server configuration bound to the active account filter. */
export interface QuarantineNativeProfile extends QuarantineScope {
  serviceUserId: string
  accountUsername: string
  uid: number
  gid: number
  folder: typeof QUARANTINE_FOLDERS[number]
  activeFilterBinding: { revision: string; bayesPath: string; serviceUser: string }
  retentionDays: number
}
interface MailboxState { guid: string; uidValidity: number; uidNext: number; total: number }
export interface QuarantineServiceOptions {
  executor: AgentExecutor
  resolveProfile: (scope: QuarantineScope) => Promise<QuarantineNativeProfile | null>
  authorize: (scope: QuarantineScope, action: 'read' | 'release' | 'delete' | 'expire') => Promise<void>
  now?: () => Date
}

/** Native Dovecot operations; test executors never become proof of a live filter or delivery. */
export class MailQuarantineService {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, number>()
  private readonly options: QuarantineServiceOptions
  constructor(options: QuarantineServiceOptions) { this.options = options }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString() }
  private async lock<T>(scope: QuarantineScope, work: () => Promise<T>): Promise<T> {
    if (!scope || typeof scope.accountId !== 'string' || !QUARANTINE_UUID.test(scope.accountId) || typeof scope.mailbox !== 'string' || scope.mailbox.length > 254 || !QUARANTINE_MAILBOX.test(scope.mailbox)) return fail('VALIDATION', 'invalid quarantine scope', { stateChanged: false })
    const key = scope.accountId + ':' + scope.mailbox, previous = this.tails.get(key) ?? Promise.resolve()
    const count = this.pending.get(key) ?? 0
    if (count >= QUARANTINE_MAX_PENDING) return fail('LIMIT_EXCEEDED', 'quarantine mailbox queue is full', { stateChanged: false })
    this.pending.set(key, count + 1)
    let release!: () => void
    const ticket = previous.then(() => new Promise<void>(resolve => { release = resolve }))
    this.tails.set(key, ticket); await previous
    try { return await work() } finally {
      release(); if (this.tails.get(key) === ticket) this.tails.delete(key)
      const remaining = (this.pending.get(key) ?? 1) - 1
      if (remaining) this.pending.set(key, remaining); else this.pending.delete(key)
    }
  }
  private async profile(scope: QuarantineScope): Promise<QuarantineNativeProfile | null> {
    if (!QUARANTINE_UUID.test(scope.accountId) || !QUARANTINE_MAILBOX.test(scope.mailbox) || scope.mailbox.length > 254) return fail('VALIDATION', 'invalid quarantine scope', { stateChanged: false })
    const profile = await this.options.resolveProfile({ ...scope })
    if (!profile) return null
    if (profile.accountId !== scope.accountId || profile.mailbox !== scope.mailbox || !QUARANTINE_UUID.test(profile.serviceUserId) || !quarantineIdentity.username.test(profile.accountUsername)
      || !Number.isSafeInteger(profile.uid) || profile.uid < 20000 || !Number.isSafeInteger(profile.gid) || profile.gid < 20000
      || !QUARANTINE_FOLDERS.includes(profile.folder) || !Number.isSafeInteger(profile.retentionDays) || profile.retentionDays < 1 || profile.retentionDays > 365
      || !profile.activeFilterBinding || !REVISION.test(profile.activeFilterBinding.revision) || profile.activeFilterBinding.serviceUser !== profile.accountUsername
      || profile.activeFilterBinding.bayesPath !== quarantineBayesPath(scope.accountId)) return fail('PRECONDITION_FAILED', 'trusted quarantine filter profile is invalid', { stateChanged: false })
    return { accountId: profile.accountId, mailbox: profile.mailbox, serviceUserId: profile.serviceUserId, accountUsername: profile.accountUsername, uid: profile.uid, gid: profile.gid, folder: profile.folder, retentionDays: profile.retentionDays,
      activeFilterBinding: { revision: profile.activeFilterBinding.revision, bayesPath: profile.activeFilterBinding.bayesPath, serviceUser: profile.activeFilterBinding.serviceUser } }
  }
  private required(profile: QuarantineNativeProfile | null): QuarantineNativeProfile {
    return profile ?? fail('PRECONDITION_FAILED', 'quarantine requires an active per-account native filter profile', { stateChanged: false })
  }
  private async currentProfile(profile: QuarantineNativeProfile): Promise<void> {
    const current = this.required(await this.profile({ accountId: profile.accountId, mailbox: profile.mailbox }))
    if (current.serviceUserId !== profile.serviceUserId || current.accountUsername !== profile.accountUsername || current.uid !== profile.uid || current.gid !== profile.gid || current.folder !== profile.folder
      || current.retentionDays !== profile.retentionDays || current.activeFilterBinding.revision !== profile.activeFilterBinding.revision
      || current.activeFilterBinding.bayesPath !== profile.activeFilterBinding.bayesPath || current.activeFilterBinding.serviceUser !== profile.activeFilterBinding.serviceUser) {
      fail('CONFLICT', 'active quarantine filter binding changed', { stateChanged: false })
    }
  }
  private command(argv: string[]): Promise<ConfigTestResult> { return this.options.executor.runCommand(assertMailQuarantineArgv(argv)) }
  private async json(argv: string[]): Promise<Record<string, unknown>[]> {
    const result = await this.command(argv)
    if (!result.ok || result.code !== 0 || Buffer.byteLength(result.stdout) > MAX_JSON_BYTES) return fail('PRECONDITION_FAILED', 'quarantine source could not be read', { stateChanged: false })
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { return fail('PRECONDITION_FAILED', 'quarantine source returned invalid JSON', { stateChanged: false }) }
    if (!Array.isArray(parsed) || parsed.length > QUARANTINE_PAGE_UIDS || parsed.some(item => !jsonObject(item))) return fail('PRECONDITION_FAILED', 'quarantine source returned an invalid collection', { stateChanged: false })
    return parsed as Record<string, unknown>[]
  }
  private async status(profile: QuarantineNativeProfile, folder = profile.folder as string): Promise<MailboxState> {
    const rows = await this.json(['/usr/bin/doveadm', '-f', 'json', 'mailbox', 'status', '-u', profile.mailbox, QUARANTINE_STATUS_FIELDS, folder])
    const row = rows[0]
    if (rows.length !== 1 || !row || row.mailbox !== folder || typeof row.guid !== 'string' || !QUARANTINE_GUID.test(row.guid)) return fail('PRECONDITION_FAILED', 'quarantine mailbox identity is unavailable', { stateChanged: false })
    return { guid: row.guid, uidValidity: uint(row.uidvalidity), uidNext: uint(row.uidnext), total: uint(row.messages, true) }
  }
  private fetch(profile: QuarantineNativeProfile, fields: string, mailboxGuid: string, range: string, messageGuid?: string): Promise<Record<string, unknown>[]> {
    return this.json(['/usr/bin/doveadm', '-f', 'json', 'fetch', '-u', profile.mailbox, fields, 'mailbox-guid', mailboxGuid, 'uid', range, ...(messageGuid ? ['guid', messageGuid] : [])])
  }
  private sameMailbox(left: MailboxState, right: MailboxState): void {
    if (left.guid !== right.guid || left.uidValidity !== right.uidValidity) fail('CONFLICT', 'quarantine mailbox identity changed; reload before retrying', { stateChanged: false })
  }
  private project(profile: QuarantineNativeProfile, state: MailboxState, row: Record<string, unknown>): QuarantineMessage {
    if (row['mailbox-guid'] !== state.guid || typeof row.guid !== 'string' || !QUARANTINE_GUID.test(row.guid)) return fail('PRECONDITION_FAILED', 'quarantine source message identity is invalid', { stateChanged: false })
    const locator = { mailboxGuid: state.guid, uidValidity: state.uidValidity, uid: uint(row.uid), messageGuid: row.guid }
    const sizeBytes = uint(row['size.virtual'], true), from = header(row['hdr.from']), to = header(row['hdr.to']), subject = header(row['hdr.subject'])
    const reason = header(row['hdr.x-spam-status'], 4096), scoreText = header(row['hdr.x-spam-score']) || /\bscore=(-?\d+(?:\.\d+)?)/i.exec(reason)?.[1] || ''
    const score = /^-?\d+(?:\.\d+)?$/.test(scoreText) && Number.isFinite(Number(scoreText)) ? Number(scoreText) : null
    const receivedAt = unixDate(row['date.received.unixtime']), heldAt = unixDate(row['date.saved.unixtime'])
    const headers = [['From', from], ['To', to], ['Subject', subject], ['X-Spam-Score', scoreText], ['X-Spam-Status', reason]].map(([key, value]) => key + ': ' + value).join('\n')
    const value = { locator, from, to, subject, receivedAt, heldAt, sizeBytes, score, reason, headers, releaseEligible: sizeBytes <= QUARANTINE_RELEASE_MAX_BYTES }
    return { ...value, revision: digest({ scope: { accountId: profile.accountId, mailbox: profile.mailbox }, binding: this.binding(profile), ...value }) }
  }
  private binding(profile: QuarantineNativeProfile): string {
    return digest({ serviceUserId: profile.serviceUserId, username: profile.accountUsername, uid: profile.uid, gid: profile.gid, folder: profile.folder, filter: profile.activeFilterBinding, retentionDays: profile.retentionDays })
  }
  private async read(profile: QuarantineNativeProfile, beforeUid?: number): Promise<QuarantineAvailable> {
    if (beforeUid !== undefined && (!Number.isSafeInteger(beforeUid) || beforeUid < 1 || beforeUid > 4294967295)) return fail('VALIDATION', 'beforeUid must be a positive UID', { stateChanged: false })
    const state = await this.status(profile), end = Math.min(state.uidNext - 1, beforeUid === undefined ? state.uidNext - 1 : beforeUid - 1), start = Math.max(1, end - QUARANTINE_PAGE_UIDS + 1)
    const rows = end < 1 ? [] : await this.fetch(profile, QUARANTINE_SUMMARY_FIELDS, state.guid, start + ':' + end)
    const messages = rows.map(row => this.project(profile, state, row)).sort((a, b) => b.locator.uid - a.locator.uid)
    if (new Set(messages.map(message => message.locator.uid)).size !== messages.length || messages.some(message => message.locator.uid < start || message.locator.uid > end)) return fail('PRECONDITION_FAILED', 'quarantine source returned messages outside the requested window', { stateChanged: false })
    const observed = await this.status(profile)
    this.sameMailbox(state, observed)
    if (state.uidNext !== observed.uidNext || state.total !== observed.total) return fail('CONFLICT', 'quarantine changed during the read; reload the page', { stateChanged: false })
    await this.currentProfile(profile)
    const scope = { accountId: profile.accountId, mailbox: profile.mailbox }
    return { state: 'available', scope, source: { kind: 'dovecot', folder: profile.folder, observedAt: this.now() }, revision: digest({ scope, binding: this.binding(profile), state, start, end, messages: messages.map(message => message.revision) }),
      messages, totalMessages: state.total, nextBeforeUid: start > 1 ? start : null, policy: { retentionDays: profile.retentionDays, retentionMode: 'manual_expiry', senderAllowAvailable: false, digestAvailable: false } }
  }
  list(scope: QuarantineScope, options: { beforeUid?: number } = {}): Promise<QuarantineReadResult> {
    return this.lock(scope, async () => { await this.options.authorize(scope, 'read'); const profile = await this.profile(scope); return profile ? this.read(profile, options.beforeUid) : { state: 'unavailable', scope: { ...scope }, reason: 'native_profile_unavailable' } })
  }
  private async current(profile: QuarantineNativeProfile, input: QuarantineMutation): Promise<QuarantineMessage> {
    const state = await this.status(profile)
    if (state.guid !== input.locator.mailboxGuid || state.uidValidity !== input.locator.uidValidity) return fail('CONFLICT', 'quarantine mailbox identity changed', { stateChanged: false })
    const rows = await this.fetch(profile, QUARANTINE_SUMMARY_FIELDS, state.guid, String(input.locator.uid), input.locator.messageGuid)
    this.sameMailbox(state, await this.status(profile))
    if (rows.length !== 1) return fail('NOT_FOUND', 'held message is no longer present', { stateChanged: false })
    const message = this.project(profile, state, rows[0]!)
    if (message.revision !== input.expectedRevision || message.locator.uid !== input.locator.uid || message.locator.messageGuid !== input.locator.messageGuid) return fail('CONFLICT', 'held message changed; reload before retrying', { stateChanged: false })
    return message
  }
  private async inbox(profile: QuarantineNativeProfile, messageGuid: string): Promise<{ state: MailboxState; uids: number[] }> {
    const state = await this.status(profile, 'INBOX')
    const rows = await this.json(['/usr/bin/doveadm', '-f', 'json', 'fetch', '-u', profile.mailbox, QUARANTINE_ID_FIELDS, 'mailbox', 'INBOX', 'guid', messageGuid])
    const uids = rows.map(row => {
      if (row['mailbox-guid'] !== state.guid || row.guid !== messageGuid) return fail('PRECONDITION_FAILED', 'Inbox readback returned a different message', { stateChanged: false })
      return uint(row.uid)
    })
    this.sameMailbox(state, await this.status(profile, 'INBOX'))
    return { state, uids }
  }
  private async absent(profile: QuarantineNativeProfile, locator: QuarantineLocator): Promise<boolean> {
    const state = await this.status(profile)
    if (state.guid !== locator.mailboxGuid || state.uidValidity !== locator.uidValidity) return fail('CONFLICT', 'quarantine identity changed during readback')
    const rows = await this.fetch(profile, QUARANTINE_ID_FIELDS, state.guid, String(locator.uid), locator.messageGuid)
    this.sameMailbox(state, await this.status(profile))
    return rows.length === 0
  }
  private result(profile: QuarantineNativeProfile, input: QuarantineMutation): QuarantineActionResult {
    return { state: 'unknown', scope: { accountId: profile.accountId, mailbox: profile.mailbox }, locator: { ...input.locator }, sourceRevision: input.expectedRevision,
      correction: 'not_attempted', deliveredToInbox: false, sourcePresent: true, deleted: false, stateChanged: false, verificationRequired: true, observedAt: this.now() }
  }
  release(scope: QuarantineScope, request: QuarantineMutation): Promise<QuarantineActionResult> {
    const input = parseQuarantineMutation(request)
    return this.lock(scope, async () => {
      await this.options.authorize(scope, 'release')
      const profile = this.required(await this.profile(scope)), message = await this.current(profile, input)
      if (!message.releaseEligible) return fail('LIMIT_EXCEEDED', 'message exceeds the bounded quarantine learning size', { stateChanged: false })
      const rawRows = await this.fetch(profile, QUARANTINE_RAW_FIELDS, input.locator.mailboxGuid, String(input.locator.uid), input.locator.messageGuid), raw = rawRows[0]
      if (rawRows.length !== 1 || raw?.guid !== input.locator.messageGuid || raw?.['mailbox-guid'] !== input.locator.mailboxGuid || uint(raw?.uid) !== input.locator.uid
        || typeof raw.text !== 'string' || !raw.text.includes('\n\n') && !raw.text.includes('\r\n\r\n') || Buffer.byteLength(raw.text) > QUARANTINE_RELEASE_MAX_BYTES || /[\u0000\ufffd]/.test(raw.text)) return fail('PRECONDITION_FAILED', 'the exact held message could not be staged for learning', { stateChanged: false })
      const beforeInbox = await this.inbox(profile, input.locator.messageGuid), path = quarantineStagePath(scope.accountId, randomUUID()), result = this.result(profile, input)
      if (beforeInbox.uids.length !== 0) return fail('PRECONDITION_FAILED', 'a matching message is already in Inbox; inspect it before releasing the held copy', { stateChanged: false })
      let training = false, moving = false
      try {
        const base = `/var/lib/xpanel/mail-quarantine/${scope.accountId}`
        for (const directory of ['/var/lib/xpanel/mail-quarantine', base, base + '/stage']) await this.options.executor.runAction({ kind: 'ensure-dir', path: directory, mode: directory.endsWith('mail-quarantine') ? 0o711 : 0o710, owner: 'root', group: directory.endsWith('mail-quarantine') ? 'root' : profile.accountUsername })
        await this.options.executor.writeFile({ path, content: raw.text, mode: 0o440, owner: 'root', group: profile.accountUsername })
        if (await this.options.executor.readFile(path) !== raw.text) return fail('PRECONDITION_FAILED', 'quarantine learning staging readback failed', { stateChanged: false })
        await this.current(profile, input); await this.options.authorize(scope, 'release'); await this.currentProfile(profile)
        training = true
        const learned = await this.command(['/usr/sbin/runuser', '-u', profile.accountUsername, '--', '/usr/bin/sa-learn', '--ham', '--dbpath', profile.activeFilterBinding.bayesPath, path])
        const summary = /Learned tokens from ([0-9]+) message\(s\) \(([0-9]+) message\(s\) examined\)/.exec(learned.stdout)
        if (!learned.ok || learned.code !== 0 || !summary || Number(summary[1]) > 1 || Number(summary[2]) !== 1) { result.correction = 'unknown'; result.stateChanged = true; result.reason = 'correction_unverified'; return result }
        result.correction = 'applied'; result.stateChanged = true
        await this.current(profile, input); await this.options.authorize(scope, 'release'); await this.currentProfile(profile)
        moving = true
        await this.command(['/usr/bin/doveadm', 'move', '-u', profile.mailbox, 'INBOX', 'mailbox-guid', input.locator.mailboxGuid, 'uid', String(input.locator.uid), 'guid', input.locator.messageGuid])
        const absent = await this.absent(profile, input.locator), afterInbox = await this.inbox(profile, input.locator.messageGuid)
        this.sameMailbox(beforeInbox.state, afterInbox.state)
        const added = afterInbox.uids.filter(uid => !beforeInbox.uids.includes(uid))
        result.sourcePresent = !absent; result.deliveredToInbox = added.length === 1
        if (absent && added.length === 1) { result.state = 'released'; result.verificationRequired = false }
        else { result.state = 'partial'; result.reason = 'move_unverified' }
        return result
      } catch (error) {
        if (!training) throw error
        result.state = moving || result.correction !== 'applied' ? 'unknown' : 'partial'; result.stateChanged = true; result.correction = result.correction === 'applied' ? 'applied' : 'unknown'
        result.deliveredToInbox = moving ? null : false; result.sourcePresent = moving ? null : true; result.reason = moving ? 'move_unverified' : result.correction === 'applied' ? 'authorization_changed' : 'correction_unverified'
        return result
      } finally {
        result.observedAt = this.now()
        try { await this.options.executor.removePath(path) } catch {
          if (!training) fail('PRECONDITION_FAILED', 'quarantine staging cleanup requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          result.state = result.state === 'released' ? 'partial' : 'unknown'; result.verificationRequired = true; result.reason = 'cleanup_unverified'
        }
      }
    })
  }
  private async deleteCurrent(profile: QuarantineNativeProfile, input: QuarantineMutation): Promise<QuarantineActionResult> {
    await this.current(profile, input); await this.options.authorize({ accountId: profile.accountId, mailbox: profile.mailbox }, 'delete')
    await this.currentProfile(profile)
    const result = this.result(profile, input)
    try {
      result.stateChanged = true
      await this.command(['/usr/bin/doveadm', 'expunge', '-u', profile.mailbox, 'mailbox-guid', input.locator.mailboxGuid, 'uid', String(input.locator.uid), 'guid', input.locator.messageGuid])
      if (await this.absent(profile, input.locator)) { result.state = 'deleted'; result.deleted = true; result.sourcePresent = false; result.verificationRequired = false }
      else { result.state = 'partial'; result.reason = 'delete_unverified' }
    } catch { result.state = 'unknown'; result.deleted = null; result.sourcePresent = null; result.reason = 'delete_unverified' }
    result.observedAt = this.now()
    return result
  }
  delete(scope: QuarantineScope, request: QuarantineMutation): Promise<QuarantineActionResult> {
    const input = parseQuarantineMutation(request)
    return this.lock(scope, async () => { await this.options.authorize(scope, 'delete'); return this.deleteCurrent(this.required(await this.profile(scope)), input) })
  }
  expire(scope: QuarantineScope, expectedRevision: string, beforeUid?: number): Promise<QuarantineExpiryResult> {
    if (!REVISION.test(expectedRevision)) fail('VALIDATION', 'saved quarantine page revision is required', { stateChanged: false })
    return this.lock(scope, async () => {
      await this.options.authorize(scope, 'expire')
      const profile = this.required(await this.profile(scope)), page = await this.read(profile, beforeUid)
      if (page.revision !== expectedRevision) return fail('CONFLICT', 'quarantine page changed; reload before expiring messages', { stateChanged: false })
      const cutoff = Date.parse(this.now()) - profile.retentionDays * 86400000, results: QuarantineActionResult[] = []
      let interrupted = false
      for (const message of page.messages) if (message.heldAt !== null && Date.parse(message.heldAt) < cutoff) {
        try {
          const result = await this.deleteCurrent(profile, { locator: message.locator, expectedRevision: message.revision }); results.push(result)
          if (result.state !== 'deleted') { interrupted = true; break }
        } catch (error) { if (results.length === 0) throw error; interrupted = true; break }
      }
      return { state: !interrupted && results.every(result => result.state === 'deleted') ? 'expired' : 'partial', scope: { ...scope }, removed: results.filter(result => result.state === 'deleted').length, considered: page.messages.length, results }
    })
  }
}
