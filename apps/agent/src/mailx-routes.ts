import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, isXpanelError, msgid } from '@xpanel/core'
import { services } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { parsePostconfMain } from './mail-server-observation.ts'
import {
  MAILX_DOVECONF_CHECK_ARGV, MAILX_DOVECOT_DIALECT_ARGV, MAILX_DOVECOT_RELOAD_ARGV, MAILX_MASTER_KEYS, MAILX_MASTER_UNSET_ARGV, MAILX_POSTCONF_MASTER_PARAMS_ARGV, mailxCertPaths, mailxMasterSetArgv,
  MAILX_ENGINE_UNITS, MAILX_MAPS, MAILX_POSTCONF_MAIN_ARGV, MAILX_POSTFIX_CHECK_ARGV, MAILX_POSTFIX_RELOAD_ARGV, MAILX_RSPAMD_TEST_ARGV,
  MAILX_SIEVE_DIR, MAILX_SPAMASSASSIN_TEST_ARGV, MAILX_VIRTUAL_ALIASES, isMailxLearnJobCommand, isMailxRetentionJobCommand, mailxArchiveExpungeArgv, mailxLearnArgv, mailxLearnFolder, mailxEngineReloadArgv, mailxPostconfSetArgv, mailxPostconfUnsetArgv,
} from '../../../packages/os/src/mailx-command.ts'
import type { MailxEngineUnit } from '../../../packages/os/src/mailx-command.ts'
import {
  MAILX_RSPAMD_SETTINGS, MAILX_SECTIONS, MAILX_SPAMASSASSIN_DIRS, isMailxInvalid, mailxMailboxEffects, renderMailxMailboxSettings, isMailxManagedText, mailxCompositeRevision, mailxStatePath, readMailxArchiveStored, readMailxStored, renderMailxDovecot, renderMailxPostfix, renderMailxSpam,
} from './mailx-policy.ts'
import type { MailxArchiveStored, MailxDovecotDialect, MailxEngine, MailxFile, MailxMailboxSpam, MailxSaved, MailxSection } from './mailx-policy.ts'
import {
  MAILFX_MILTERS, admitMailxMailboxRows, mailfxListAliasLine, mailfxMilterListed, mailfxSieveInputs, mailxStdout, mailxUnitState, readMailForwardingConfiguration, readMailfxLists, readMailxMailboxRows,
} from './mailfx-render.ts'
import type { MailxEngineState, MailxSnapshot } from './mailfx-render.ts'

export interface MailxCommandResult { ok: boolean; code: number | null; stdout: string; stderr: string }
export type MailxRun = (argv: string[]) => Promise<MailxCommandResult>
export interface MailxHostFiles { read(path: string): Promise<string | null>; write(file: MailxFile): Promise<void>; remove(path: string): Promise<void>; ensureMapDir(): Promise<void> }
export interface MailxAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface MailxRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Fresh authority of the active account's owner (or root), by username. */
  assertAccount: (username: string, action: string) => Promise<{ actor: string; accountId: string }>
  stateRoot: string
  /** Native Linux host executor only; null keeps every route unavailable instead of simulating Postfix. */
  run: MailxRun | null
  files: MailxHostFiles | null
  readSnapshot: () => Promise<MailxSnapshot>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  /** The host reconciler: renders the spam milter, mailbox Sieve policy scripts and mailing lists. Absent reports `unavailable`. */
  reconcile?: (actor: string) => Promise<{ status: 'noop' | 'applied' | 'failed' }>
  audit?: (entry: MailxAuditEntry) => Promise<unknown>
  now?: () => Date
}

const unchanged = { stateChanged: false }
const unknown = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Reads every saved section and account archive; a malformed file stops the apply for review instead of being skipped. */
export async function readMailxSaved(stateRoot: string): Promise<MailxSaved> {
  const sections = {} as { [S in MailxSection]: MailxSaved['sections'][S] }
  try {
    for (const section of MAILX_SECTIONS) {
      const raw = await readJsonIfExists<unknown>(join(stateRoot, ...mailxStatePath(section + '.json')))
      ;(sections as Record<string, unknown>)[section] = raw === null ? null : readMailxStored(section, raw)
    }
    const dir = join(stateRoot, ...mailxStatePath('archive'))
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    if (names.length > 10000) throw new Error('mailx_archive_limit')
    const archives: MailxArchiveStored[] = []
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!UUID.test(id)) throw new Error('mailx_archive_name')
      archives.push(readMailxArchiveStored(id, await readJsonIfExists<unknown>(join(dir, name))))
    }
    return { sections, archives }
  } catch (error) {
    if (isMailxInvalid(error) || error instanceof Error && error.message.startsWith('mailx_')) return fail('PRECONDITION_FAILED', 'saved mail policy requires review before it can be applied', { ...unchanged, reason: 'saved_policy_review' })
    throw error
  }
}

export type MailxArchiveRowState = 'eligible' | 'account-inactive' | 'domain-missing' | 'mailbox-missing'
/** Archive rows apply only while the account, its domain and the chosen mailbox still exist in the saved hosting state. */
export function admitMailxArchives(archives: readonly MailxArchiveStored[], snapshot: MailxSnapshot): { archives: MailxArchiveStored[]; rows: Map<string, MailxArchiveRowState> } {
  const rows = new Map<string, MailxArchiveRowState>()
  const admitted = archives.map(archive => {
    const account = snapshot.accounts.find(item => item.id === archive.accountId)
    const domains = archive.policy.domains.filter(row => {
      const domain = snapshot.domains.find(item => item.name === row.domain && item.accountId === archive.accountId)
      const mailbox = domain && snapshot.serviceUsers.find(user => user.accountId === archive.accountId && user.services.email && user.login.toLowerCase() === row.mailbox)
      const state: MailxArchiveRowState = !account || account.status !== 'active' ? 'account-inactive' : !domain ? 'domain-missing' : !mailbox ? 'mailbox-missing' : 'eligible'
      rows.set(archive.accountId + ' ' + row.domain, state)
      return state === 'eligible'
    })
    return { ...archive, policy: { domains } }
  })
  return { archives: admitted, rows }
}

const succeeded = async (run: MailxRun, argv: readonly string[]): Promise<boolean> => (await mailxStdout(run, argv)) !== null
async function postconf(run: MailxRun): Promise<Map<string, string> | null> {
  const text = await mailxStdout(run, MAILX_POSTCONF_MAIN_ARGV)
  if (text === null || Buffer.byteLength(text) > 1024 * 1024) return null
  try { return parsePostconfMain(text) } catch { return null }
}
/** The port 25 certificate override from postconf -P: none, one this applier rendered, or an administrator's own. */
type MasterTls = { state: 'read'; id: string | null } | { state: 'unmanaged' }
async function masterTls(run: MailxRun): Promise<MasterTls | null> {
  const text = await mailxStdout(run, MAILX_POSTCONF_MASTER_PARAMS_ARGV)
  if (text === null || Buffer.byteLength(text) > 1024 * 1024) return null
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const at = line.indexOf(' ='), key = at > 0 ? line.slice(0, at) : ''
    if ((MAILX_MASTER_KEYS as readonly string[]).includes(key)) values.set(key, line.slice(at + 2).trim())
  }
  const cert = values.get(MAILX_MASTER_KEYS[0]), key = values.get(MAILX_MASTER_KEYS[1])
  if (cert === undefined && key === undefined) return { state: 'read', id: null }
  const id = /^\/etc\/xpanel\/ssl\/([A-Za-z0-9_-]{1,64})\/fullchain\.pem$/.exec(cert ?? '')?.[1]
  return id && id !== 'default' && key === mailxCertPaths(id).keyFile ? { state: 'read', id } : { state: 'unmanaged' }
}
/** One section's Postfix plan alone, so a section's state names only the keys and tables it renders. */
const sectionPlan = (saved: MailxSaved, section: MailxSection, recipients: ReadonlyMap<string, readonly string[]>): ReturnType<typeof renderMailxPostfix> =>
  renderMailxPostfix({ sections: { ...Object.fromEntries(MAILX_SECTIONS.map(name => [name, null])), [section]: saved.sections[section] } as MailxSaved['sections'], archives: [] }, recipients)
const dovecotDialect = async (run: MailxRun): Promise<MailxDovecotDialect> => await succeeded(run, MAILX_DOVECOT_DIALECT_ARGV) ? '2.4' : '2.3'

/**
 * Known recipients of each backup MX domain, from the same saved state local delivery used: its mailboxes, forwarders
 * and admitted mailing lists. A domain forwarder accepts every address of the domain, so it becomes `@domain`.
 */
export async function mailxRoutingRecipients(stateRoot: string, saved: MailxSaved, snapshot: MailxSnapshot): Promise<Map<string, string[]>> {
  const backup = (saved.sections.routing?.policy.domains ?? []).filter(row => row.mode === 'backup').map(row => row.domain), recipients = new Map<string, string[]>()
  if (!backup.length) return recipients
  const forwarding = await readMailForwardingConfiguration(stateRoot, snapshot)
  for (const domain of backup) {
    const at = '@' + domain, names = new Set<string>()
    for (const user of snapshot.serviceUsers) if (user.services.email && user.login.toLowerCase().endsWith(at)) names.add(user.login.toLowerCase())
    for (const item of forwarding.forwarders) if (item.sourceAddress.toLowerCase().endsWith(at)) names.add(item.sourceAddress.toLowerCase())
    for (const list of forwarding.lists) if (list.address.toLowerCase().endsWith(at)) names.add(list.address.toLowerCase())
    recipients.set(domain, forwarding.domainForwarders.some(item => item.sourceDomain === domain) ? [at] : [...names].sort())
  }
  return recipients
}
export interface MailxEngineObservation { units: Record<MailxEngineUnit, MailxEngineState>; engine: MailxEngine | null; unit: MailxEngineUnit | null; spamAssassinDir: string | null; wiring: 'wired' | 'not-wired' | 'unknown' }
async function observeEngine(run: MailxRun, files: MailxHostFiles, main: Map<string, string> | null): Promise<MailxEngineObservation> {
  const units = {} as Record<MailxEngineUnit, MailxEngineState>
  for (const unit of MAILX_ENGINE_UNITS) units[unit] = await mailxUnitState(run, unit)
  const unit = units['rspamd.service'] === 'active' ? 'rspamd.service' : (['spamassassin.service', 'spamd.service'] as const).find(name => units[name] === 'active') ?? null
  const engine: MailxEngine | null = unit === null ? null : unit === 'rspamd.service' ? 'rspamd' : 'spamassassin'
  let spamAssassinDir: string | null = null
  if (engine === 'spamassassin') for (const dir of MAILX_SPAMASSASSIN_DIRS) if (await files.read(dir + '/local.cf').catch(() => null) !== null) { spamAssassinDir = dir; break }
  // Wired only when both milter lists name the address the reconciler renders for this engine.
  const wiring = main === null || engine === null ? 'unknown' : mailfxMilterListed(main, MAILFX_MILTERS[engine]) ? 'wired' : 'not-wired'
  return { units, engine, unit, spamAssassinDir, wiring }
}

export type MailxSectionState = 'not-saved' | 'applied' | 'pending' | 'unavailable'
export interface MailxStatus {
  observedAt: string
  revision: string
  postfix: 'read' | 'unavailable'
  engine: MailxEngineObservation
  sections: Record<MailxSection, MailxSectionState>
  archive: { accounts: number; state: MailxSectionState; conflicts: ReturnType<typeof renderMailxPostfix>['conflicts'] }
}
async function spamFiles(saved: MailxSaved, engine: MailxEngineObservation): Promise<MailxFile[] | null> {
  const spam = saved.sections.spam
  if (!spam) return []
  if (!engine.engine || engine.engine === 'spamassassin' && !engine.spamAssassinDir) return null
  return renderMailxSpam(spam.policy, engine.engine, engine.spamAssassinDir ?? undefined)
}
/** rspamd settings for mailbox preferences; written only on rspamd, and kept managed (possibly empty) once xPanel wrote it. */
async function mailboxFile(engine: MailxEngineObservation, files: MailxHostFiles, rows: readonly MailxMailboxSpam[]): Promise<MailxFile | null> {
  if (engine.engine !== 'rspamd') return null
  const current = await files.read(MAILX_RSPAMD_SETTINGS).catch(() => null)
  return rows.length || current !== null && isMailxManagedText(current) ? renderMailxMailboxSettings(rows) : null
}
const filesMatch = async (files: MailxHostFiles, wanted: readonly MailxFile[]): Promise<boolean> => {
  for (const file of wanted) if (await files.read(file.path).catch(() => null) !== file.content) return false
  return true
}
/** Observed host effect per section: applied only when every rendered parameter and file reads back exactly. */
export async function observeMailx(run: MailxRun, files: MailxHostFiles, saved: MailxSaved, snapshot: MailxSnapshot, now: Date, recipients: ReadonlyMap<string, readonly string[]> = new Map()): Promise<MailxStatus> {
  const main = await postconf(run), engine = await observeEngine(run, files, main)
  const admitted = { ...saved, archives: admitMailxArchives(saved.archives, snapshot).archives }
  const plan = renderMailxPostfix(admitted, recipients), spam = await spamFiles(saved, engine)
  const keysFor: Record<string, string[]> = { relay: ['relayhost', 'smtp_sasl_auth_enable', 'smtp_sasl_password_maps', 'smtp_sasl_security_options', 'smtp_sasl_tls_security_options', 'smtp_tls_policy_maps'],
    bcc: ['always_bcc', 'recipient_bcc_maps', 'sender_bcc_maps'], marketing: ['smtpd_client_message_rate_limit', 'smtpd_client_recipient_rate_limit', 'smtpd_recipient_limit', 'default_destination_rate_delay', 'default_destination_concurrency_limit', 'anvil_rate_time_unit'] }
  const filesFor: Record<string, string[]> = { relay: [MAILX_MAPS.relaySasl, MAILX_MAPS.relayTls], bcc: [MAILX_MAPS.recipientBcc, MAILX_MAPS.senderBcc] }
  const state = async (keys: string[], paths: string[]): Promise<MailxSectionState> => main === null ? 'unavailable'
    : keys.every(key => !Object.hasOwn(plan.settings, key) || main.get(key) === plan.settings[key]) && await filesMatch(files, plan.files.filter(file => paths.includes(file.path))) ? 'applied' : 'pending'
  for (const section of ['server', 'routing'] as const) {
    const own = sectionPlan(saved, section, recipients)
    keysFor[section] = Object.keys(own.settings)
    filesFor[section] = own.files.map(file => file.path)
  }
  // The server section also owns the port 25 certificate override and its Dovecot file.
  const serverState = async (): Promise<MailxSectionState> => {
    const postfix = await state(keysFor.server!, [])
    if (postfix !== 'applied') return postfix
    const dovecot = renderMailxDovecot(saved, await dovecotDialect(run)), master = plan.master === undefined ? null : await masterTls(run)
    return (plan.master === undefined || master?.state === 'read' && master.id === plan.master) && (!dovecot || await filesMatch(files, [dovecot])) ? 'applied' : 'pending'
  }
  const sections = {} as Record<MailxSection, MailxSectionState>
  for (const section of MAILX_SECTIONS) sections[section] = !saved.sections[section] ? 'not-saved'
    : section === 'spam' ? spam === null ? 'unavailable' : await filesMatch(files, spam) ? 'applied' : 'pending'
      : section === 'server' ? await serverState() : await state(keysFor[section]!, filesFor[section] ?? [])
  const archiveRows = admitted.archives.some(item => item.policy.domains.some(row => row.incoming || row.outgoing))
  return { observedAt: now.toISOString(), revision: mailxCompositeRevision(saved), postfix: main === null ? 'unavailable' : 'read', engine,
    sections, archive: { accounts: saved.archives.length, state: !archiveRows ? 'not-saved' : await state(['recipient_bcc_maps', 'sender_bcc_maps'], filesFor.bcc!), conflicts: plan.conflicts } }
}

export type MailxReconcileOutcome = 'applied' | 'unchanged' | 'failed' | 'unknown' | 'unavailable'
/** `failedCheck` names the configuration test that refused a rolled-back apply. */
export interface MailxApplyResult { outcome: 'applied' | 'unknown' | 'rolled-back' | 'nothing'; revision: string; verificationRequired: boolean; spam: 'applied' | 'unavailable' | 'not-saved' | 'rolled-back'; mailboxes: 'applied' | 'unavailable' | 'not-saved' | 'rolled-back'; reloads: string[]; reconcile?: MailxReconcileOutcome; failedCheck?: 'postfix' | 'dovecot' }
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const next = queue.then(task, task); queue = next.catch(() => undefined); return next }

/** Certificates the server section names must be saved, unexpired and present on the host before anything changes. */
async function admitCertificates(files: MailxHostFiles, saved: MailxSaved, snapshot: MailxSnapshot, now: Date): Promise<void> {
  const server = saved.sections.server?.policy
  for (const id of server ? [server.certificates.smtp, server.certificates.imap] : []) {
    if (id === null) continue
    const cert = snapshot.certificates?.find(item => item.id === id)
    if (!cert || Date.parse(cert.notAfter) <= now.getTime() || await files.read(mailxCertPaths(id).certFile).catch(() => null) === null) {
      return fail('PRECONDITION_FAILED', 'a chosen mail certificate is missing or expired, so nothing was changed', { ...unchanged, reason: 'certificate_missing', certificate: id })
    }
  }
}

/**
 * Writes the owned tables and the Dovecot file, sets the reviewed parameters and the port 25 certificate, then reloads.
 * `postfix check` and `doveconf -n` must pass before and after; a failed test restores every previous parameter, override
 * and file before anything is reloaded. The result is `applied` only when a re-read proves it.
 */
export async function applyMailx(run: MailxRun, files: MailxHostFiles, saved: MailxSaved, snapshot: MailxSnapshot, confirm: () => Promise<void>, mailboxRows: readonly MailxMailboxSpam[] = [], now = new Date(),
  recipients: ReadonlyMap<string, readonly string[]> = new Map()): Promise<MailxApplyResult> {
  const revision = mailxCompositeRevision(saved)
  const plan = renderMailxPostfix({ ...saved, archives: admitMailxArchives(saved.archives, snapshot).archives }, recipients), dovecot = renderMailxDovecot(saved, await dovecotDialect(run))
  const before = await postconf(run)
  if (before === null) return fail('PRECONDITION_FAILED', 'Postfix parameters could not be read, so nothing was changed', { ...unchanged, reason: 'postconf_unavailable' })
  const engine = await observeEngine(run, files, before), section = await spamFiles(saved, engine) ?? [], ownRows = admitMailxMailboxRows(mailboxRows, snapshot), box = await mailboxFile(engine, files, ownRows)
  const spam = [...section, ...(box ? [box] : [])]
  const spamState: MailxApplyResult['spam'] = !saved.sections.spam ? 'not-saved' : section.length ? 'applied' : 'unavailable'
  const mailboxes: MailxApplyResult['mailboxes'] = box ? 'applied' : ownRows.length ? 'unavailable' : 'not-saved'
  if (!Object.keys(plan.settings).length && !plan.files.length && !spam.length && !dovecot && plan.master === undefined) return { outcome: 'nothing', revision, verificationRequired: false, spam: spamState, mailboxes, reloads: [] }
  let masterBefore: string | null = null
  if (plan.master !== undefined) {
    const master = await masterTls(run)
    if (master === null) return fail('PRECONDITION_FAILED', 'master.cf overrides could not be read, so nothing was changed', { ...unchanged, reason: 'postconf_unavailable' })
    if (master.state === 'unmanaged') return fail('CONFLICT', 'a port 25 certificate override not managed by xPanel is in master.cf; remove it or merge it by hand', { ...unchanged, reason: 'unmanaged_override' })
    masterBefore = master.id
  }
  await admitCertificates(files, saved, snapshot, now)
  const previous = new Map<string, string | null>()
  for (const file of [...plan.files, ...spam, ...(dovecot ? [dovecot] : [])]) {
    const current = await files.read(file.path)
    if (!isMailxManagedText(current)) return fail('CONFLICT', 'a configuration file not managed by xPanel is in the way; move it aside or merge it by hand', { ...unchanged, reason: 'unmanaged_file', path: file.path })
    previous.set(file.path, current)
  }
  const dovecotChanged = !!dovecot && previous.get(dovecot.path) !== dovecot.content, masterChanged = plan.master !== undefined && plan.master !== masterBefore
  if (!await succeeded(run, MAILX_POSTFIX_CHECK_ARGV)) return fail('PRECONDITION_FAILED', 'postfix check already fails on this host, so nothing was changed', { ...unchanged, reason: 'postfix_check_failed' })
  if (dovecotChanged && !await succeeded(run, MAILX_DOVECONF_CHECK_ARGV)) return fail('PRECONDITION_FAILED', 'doveconf already fails on this host, so nothing was changed', { ...unchanged, reason: 'dovecot_check_failed' })
  await confirm()
  const keys = Object.keys(plan.settings), absent = keys.filter(key => !before.has(key)), reloads: string[] = []
  const restore = async (paths: readonly MailxFile[]): Promise<void> => {
    for (const file of paths) { const old = previous.get(file.path) ?? null; if (old === null) await files.remove(file.path); else await files.write({ ...file, content: old }) }
  }
  const setMaster = async (id: string | null): Promise<boolean> => succeeded(run, id === null ? MAILX_MASTER_UNSET_ARGV : mailxMasterSetArgv(id))
  const rollback = async (): Promise<boolean> => {
    try {
      await restore(plan.files)
      const kept = Object.fromEntries(keys.filter(key => before.has(key)).map(key => [key, before.get(key)!]))
      if (Object.keys(kept).length && !await succeeded(run, mailxPostconfSetArgv(kept))) return false
      if (absent.length && !await succeeded(run, mailxPostconfUnsetArgv(absent))) return false
      if (masterChanged && !await setMaster(masterBefore)) return false
      if (dovecotChanged) { await restore([dovecot!]); if (!await succeeded(run, MAILX_DOVECONF_CHECK_ARGV) || !await succeeded(run, MAILX_DOVECOT_RELOAD_ARGV)) return false }
      return await succeeded(run, MAILX_POSTFIX_CHECK_ARGV) && await succeeded(run, MAILX_POSTFIX_RELOAD_ARGV)
    } catch { return false }
  }
  const rolledBack = async (failedCheck: 'postfix' | 'dovecot', message: string): Promise<MailxApplyResult> =>
    await rollback() ? { outcome: 'rolled-back', revision, verificationRequired: false, spam: spamState, mailboxes, reloads, failedCheck } : fail('SERVICE_UNAVAILABLE', message, unknown)
  try {
    if (plan.files.length) await files.ensureMapDir()
    for (const file of plan.files) await files.write(file)
    if (keys.length && !await succeeded(run, mailxPostconfSetArgv(plan.settings))) return await rolledBack('postfix', 'Postfix parameters were not set and the rollback could not be verified')
    if (masterChanged && !await setMaster(plan.master!)) return await rolledBack('postfix', 'the port 25 certificate was not set and the rollback could not be verified')
    if (!await succeeded(run, MAILX_POSTFIX_CHECK_ARGV)) return await rolledBack('postfix', 'postfix check failed and the rollback could not be verified')
    if (dovecotChanged) {
      await files.write(dovecot!)
      if (!await succeeded(run, MAILX_DOVECONF_CHECK_ARGV)) return await rolledBack('dovecot', 'doveconf failed and the rollback could not be verified')
    }
    if (!await succeeded(run, MAILX_POSTFIX_RELOAD_ARGV)) return fail('SERVICE_UNAVAILABLE', 'Postfix did not confirm the reload; inspect the mail service', unknown)
    reloads.push('postfix')
    if (dovecotChanged) {
      if (!await succeeded(run, MAILX_DOVECOT_RELOAD_ARGV)) return fail('SERVICE_UNAVAILABLE', 'Dovecot did not confirm the reload; inspect the mail service', unknown)
      reloads.push('dovecot')
    }
    let spamResult: MailxApplyResult['spam'] = spamState, mailboxResult: MailxApplyResult['mailboxes'] = mailboxes, rolledSpam = false
    if (spam.length && engine.unit) {
      for (const file of spam) await files.write(file)
      if (!await succeeded(run, engine.engine === 'rspamd' ? MAILX_RSPAMD_TEST_ARGV : MAILX_SPAMASSASSIN_TEST_ARGV)) { await restore(spam); rolledSpam = true; if (section.length) spamResult = 'rolled-back'; if (box) mailboxResult = 'rolled-back' }
      else if (await succeeded(run, mailxEngineReloadArgv(engine.unit))) reloads.push(engine.engine!)
      else return fail('SERVICE_UNAVAILABLE', 'the spam filter did not confirm the reload; inspect the service', unknown)
    }
    const after = await postconf(run), master = plan.master === undefined ? null : await masterTls(run)
    const verified = after !== null && keys.every(key => after.get(key) === plan.settings[key]) && await filesMatch(files, plan.files) && (rolledSpam || await filesMatch(files, spam))
      && (plan.master === undefined || master?.state === 'read' && master.id === plan.master) && (!dovecot || await filesMatch(files, [dovecot]))
    return { outcome: verified ? 'applied' : 'unknown', revision, verificationRequired: !verified, spam: spamResult, mailboxes: mailboxResult, reloads }
  } catch (error) {
    if (isXpanelError(error) && error.detail?.stateChanged !== false) throw error
    return fail('SERVICE_UNAVAILABLE', 'mail policy apply outcome requires inspection', unknown)
  }
}

async function reconcileMail(ctx: MailxRouteContext, actor: string): Promise<MailxReconcileOutcome> {
  if (!ctx.reconcile) return 'unavailable'
  try { const result = await ctx.reconcile(actor); return result.status === 'applied' ? 'applied' : result.status === 'noop' ? 'unchanged' : 'failed' }
  catch (error) { return isXpanelError(error) && error.detail?.stateChanged === false ? 'failed' : 'unknown' }
}

const ROUTE = /^\/host\/mailx\/(?:(state|apply)|accounts\/([a-z][a-z0-9]{0,15})\/(archive|apply|retention|mailboxes|lists|learn))$/
const MAX_BODY = 4096
async function readBody(req: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  if (text.length > MAX_BODY) return fail('VALIDATION', 'mail policy request exceeds its bound', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) return fail('VALIDATION', 'unsupported mail policy request field', unchanged)
  const record = body as Record<string, unknown>
  if (keys.includes('revision') && (typeof record.revision !== 'string' || !/^[0-9a-f]{64}$/.test(record.revision))) return fail('VALIDATION', 'the saved policy revision is required', unchanged)
  return record
}

/** Root applies the whole saved policy; an account owner may re-apply it for their archive and run their own retention. */
export async function handleMailxRoute(req: Request, url: URL, method: string, ctx: MailxRouteContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, rootOp, username, accountOp] = match
  const op = rootOp ?? accountOp!, action = 'mail.policy.' + op
  const authorize = async () => username ? ctx.assertAccount(username, action) : { ...await ctx.assertRoot(action), accountId: null as string | null }
  const first = await authorize()
  const reading = op === 'state' || op === 'archive' || op === 'mailboxes' || op === 'lists'
  if (method !== (reading ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: reading ? 'GET' : 'POST' } })
  if (url.search) return fail('VALIDATION', 'mail policy routes accept no selectors', unchanged)
  const body = reading ? null : await readBody(req, op === 'retention' ? ['revision', 'domain'] : op === 'learn' ? ['mailbox', 'direction'] : ['revision'])
  if (op === 'learn' && (typeof body!.mailbox !== 'string' || body!.mailbox.length > 254 || !['spam', 'ham'].includes(String(body!.direction)))) return fail('VALIDATION', 'a mailbox and the spam or ham direction are required', unchanged)
  if (!ctx.run || !ctx.files) return fail('PRECONDITION_FAILED', 'mail policy requires the native Linux host executor', unchanged)
  const run = ctx.run, files = ctx.files, now = ctx.now ?? (() => new Date())
  const confirm = async (): Promise<string> => {
    const fresh = await authorize()
    return fresh.actor === first.actor && fresh.accountId === first.accountId ? fresh.actor : fail('FORBIDDEN', 'mail policy authority changed', unchanged)
  }
  if (op === 'mailboxes') {
    const snapshot = await ctx.readSnapshot(), { rows, review } = await readMailxMailboxRows(ctx.stateRoot)
    const main = await postconf(run), engine = await observeEngine(run, files, main), admitted = admitMailxMailboxRows(rows, snapshot)
    const box = await mailboxFile(engine, files, admitted), applied = box !== null && await filesMatch(files, [box])
    const own = snapshot.serviceUsers.filter(user => user.accountId === first.accountId && user.services.email).map(user => user.login.toLowerCase()).sort().slice(0, 1000)
    const sieve = new Map(mailfxSieveInputs(admitted.filter(row => own.includes(row.mailbox)), snapshot).map(input => [input.address, input]))
    const sieveApplied = new Map<string, boolean>()
    for (const [mailbox, input] of sieve) {
      const at = mailbox.lastIndexOf('@')
      sieveApplied.set(mailbox, await files.read(`${MAILX_SIEVE_DIR}/${mailbox.slice(at + 1)}/${mailbox.slice(0, at)}.sieve`).catch(() => null) === services.renderMailboxPolicySieveScript(input))
    }
    await confirm()
    // rspamd carries the allowlist, filtering and score effects; the mailbox Sieve script carries blocked senders and Junk.
    const native = (row: MailxMailboxSpam): 'not-saved' | 'applied' | 'pending' | 'unavailable' => {
      const effects = mailxMailboxEffects(row), parts: string[] = []
      if (effects.allowlist || effects.filtering || effects.score) parts.push(engine.engine !== 'rspamd' ? 'unavailable' : applied ? 'applied' : 'pending')
      if (sieve.has(row.mailbox)) parts.push(sieveApplied.get(row.mailbox) ? 'applied' : 'pending')
      return !parts.length ? 'not-saved' : parts.includes('pending') ? 'pending' : parts.includes('unavailable') ? 'unavailable' : 'applied'
    }
    return json({ observedAt: now().toISOString(), engine: { engine: engine.engine, wiring: engine.wiring }, jobsAvailable: !!ctx.submitJob,
      mailboxes: own.map(mailbox => {
        const row = admitted.find(item => item.mailbox === mailbox), foreign = !row && (review.includes(mailbox) || rows.some(item => item.mailbox === mailbox))
        return { mailbox, preference: foreign ? 'review' : row ? 'saved' : 'none', effects: row ? mailxMailboxEffects(row) : null, native: row ? native(row) : 'not-saved' }
      }) })
  }
  if (op === 'lists') {
    const snapshot = await ctx.readSnapshot(), forwarding = await readMailForwardingConfiguration(ctx.stateRoot, snapshot)
    const { lists, rows } = await readMailfxLists(ctx.stateRoot, snapshot, forwarding)
    const aliases = await files.read(MAILX_VIRTUAL_ALIASES).catch(() => null), live = aliases === null ? null : new Set(aliases.split('\n'))
    await confirm()
    // Delivering only when the live alias table holds the exact rendered line for the list.
    return json({ observedAt: now().toISOString(), aliases: live === null ? 'unavailable' : 'read',
      lists: rows.filter(row => row.accountId === first.accountId).slice(0, 1000).map(row => {
        const delivered = lists.find(item => item.address === row.address.toLowerCase())
        return { address: row.address, members: row.members, state: row.state === 'pending' && delivered && live?.has(mailfxListAliasLine(delivered)) ? 'delivering' : row.state }
      }) })
  }
  if (reading) {
    const saved = await readMailxSaved(ctx.stateRoot), snapshot = await ctx.readSnapshot()
    const status = await observeMailx(run, files, saved, snapshot, now(), await mailxRoutingRecipients(ctx.stateRoot, saved, snapshot))
    await confirm()
    if (!username) return json(status)
    const own = saved.archives.find(item => item.accountId === first.accountId), rows = admitMailxArchives(saved.archives, snapshot).rows
    return json({ observedAt: status.observedAt, revision: status.revision, postfix: status.postfix, state: status.archive.state, jobsAvailable: !!ctx.submitJob,
      domains: (own?.policy.domains ?? []).map(row => ({ domain: row.domain, admission: rows.get(own!.accountId + ' ' + row.domain) ?? 'domain-missing',
        conflicts: status.archive.conflicts.filter(item => item.accountId === own!.accountId && item.domain === row.domain).map(item => item.direction) })) })
  }
  if (op === 'learn') {
    const mailbox = body!.mailbox as string, direction = body!.direction as 'spam' | 'ham'
    const admitted = async (): Promise<{ home: string }> => {
      const snapshot = await ctx.readSnapshot(), account = snapshot.accounts.find(item => item.id === first.accountId)
      const user = snapshot.serviceUsers.find(item => item.accountId === first.accountId && item.services.email && item.login.toLowerCase() === mailbox)
      return account && account.status === 'active' && user ? account : fail('NOT_FOUND', 'mailbox not found', unchanged)
    }
    const account = await admitted(), engine = await observeEngine(run, files, await postconf(run))
    if (!engine.engine) return fail('PRECONDITION_FAILED', 'no supported spam filter is running, so nothing was trained', { ...unchanged, reason: 'no_spam_filter' })
    if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
    let argv: string[]
    try { argv = mailxLearnArgv(engine.engine, direction, mailxLearnFolder(account.home, mailbox, direction)) } catch { return fail('PRECONDITION_FAILED', 'this mailbox has no reviewed Maildir location', { ...unchanged, reason: 'maildir_unsupported' }) }
    const plan: HostJobPlan = { kind: 'mail.spam.learn', summary: `Spam filter training from ${mailbox}`, accountId: first.accountId,
      fingerprint: { mailbox, direction, engine: engine.engine }, detail: { mailbox, direction, engine: engine.engine },
      steps: [{ id: 'learn', title: direction === 'spam' ? msgid('Train the spam filter with the Junk folder of {mailbox}') : msgid('Train the spam filter with the Inbox of {mailbox}'), titleValues: { mailbox }, argv, timeoutMs: 1_800_000, mutates: true }],
      policy: isMailxLearnJobCommand, beforeStep: async () => { await confirm(); await admitted() } }
    const actor = await confirm()
    let job: HostJobView
    try { job = await ctx.submitJob(plan, actor) } catch (error) { if (isXpanelError(error)) throw error; return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review host jobs before retrying', unknown) }
    await ctx.audit?.({ actor, action: 'mail.spam.learn_submitted', target: 'mailbox:' + mailbox, outcome: 'ok', detail: { jobId: job.id, direction, engine: engine.engine } }).catch(() => {})
    return json({ job: { id: job.id, kind: job.kind, status: job.status } }, 202)
  }
  return serial(async () => {
    const saved = await readMailxSaved(ctx.stateRoot)
    if (mailxCompositeRevision(saved) !== body!.revision) return fail('CONFLICT', 'saved mail policy changed; reload before applying', unchanged)
    const snapshot = await ctx.readSnapshot()
    if (op === 'retention') {
      const own = saved.archives.find(item => item.accountId === first.accountId), row = own?.policy.domains.find(item => item.domain === body!.domain)
      if (!row) return fail('NOT_FOUND', 'archive domain not found', unchanged)
      if (row.retentionDays === 0) return fail('PRECONDITION_FAILED', 'this archive keeps messages without a retention period', { ...unchanged, reason: 'retention_unlimited' })
      if (admitMailxArchives([own!], snapshot).rows.get(own!.accountId + ' ' + row.domain) !== 'eligible') return fail('PRECONDITION_FAILED', 'the archive mailbox is no longer available', { ...unchanged, reason: 'archive_mailbox_missing' })
      if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
      const argv = mailxArchiveExpungeArgv(row.mailbox, row.retentionDays), revision = body!.revision as string
      const plan: HostJobPlan = { kind: 'mail.archive.retention', summary: `Archive retention for ${row.domain}`, accountId: own!.accountId,
        fingerprint: { domain: row.domain, mailbox: row.mailbox, retentionDays: row.retentionDays, revision }, detail: { domain: row.domain, retentionDays: row.retentionDays },
        steps: [{ id: 'expunge', title: msgid('Remove archived messages older than {days} days from {mailbox}'), titleValues: { days: String(row.retentionDays), mailbox: row.mailbox }, argv, timeoutMs: 1_800_000, mutates: true }],
        policy: isMailxRetentionJobCommand,
        beforeStep: async () => { await confirm(); if (mailxCompositeRevision(await readMailxSaved(ctx.stateRoot)) !== revision) fail('CONFLICT', 'archive policy changed after the job was queued', unchanged) } }
      const actor = await confirm()
      let job: HostJobView
      try { job = await ctx.submitJob(plan, actor) } catch (error) { if (isXpanelError(error)) throw error; return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review host jobs before retrying', unknown) }
      await ctx.audit?.({ actor, action: 'mail.archive.retention_submitted', target: 'domain:' + row.domain, outcome: 'ok', detail: { jobId: job.id, retentionDays: row.retentionDays } }).catch(() => {})
      return json({ job: { id: job.id, kind: job.kind, status: job.status } }, 202)
    }
    let actor = first.actor
    const applied = await applyMailx(run, files, saved, snapshot, async () => { actor = await confirm() }, (await readMailxMailboxRows(ctx.stateRoot)).rows, now(), await mailxRoutingRecipients(ctx.stateRoot, saved, snapshot))
    // The milter, mailbox Sieve scripts and lists live in reconciler-owned renders, so they apply through a generation.
    const reconcile = await reconcileMail(ctx, await confirm())
    const result: MailxApplyResult = reconcile === 'unknown' ? { ...applied, outcome: 'unknown', verificationRequired: true, reconcile } : { ...applied, reconcile }
    await ctx.audit?.({ actor, action: 'mail.policy.applied', target: username ? 'account:' + username : 'server:mail-policy', outcome: result.outcome === 'applied' || result.outcome === 'nothing' ? reconcile === 'failed' ? 'failed' : 'ok' : 'failed', detail: { outcome: result.outcome, spam: result.spam, mailboxes: result.mailboxes, reloads: result.reloads, reconcile, ...(result.failedCheck ? { failedCheck: result.failedCheck } : {}) } }).catch(() => {})
    return json(result)
  })
}
