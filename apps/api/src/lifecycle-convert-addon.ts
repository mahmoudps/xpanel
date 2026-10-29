import { randomBytes, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, ShellAccess } from '@xpanel/core'
import { createUserPrincipal, deletePrincipal, findPrincipalByAccountId } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateSnapshot } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { readReply } from './backup-file-restore-workspace.ts'
import type { ConvertAddonPlan } from './acct-convert-addon.ts'

/** StateStore.convertAddonDomain / revertAddonConversion (packages/state/src/store.ts). */
export interface AddonConversionStore {
  convertAddonDomain(input: { sourceAccountId: string; domainId: string; username: string; planId: string; passwordHash: string; contactEmail: string; shell: ShellAccess }, opts: { expectedRevision: number }): Promise<{ account: Account; domains: string[]; serviceUsers: string[]; zones: string[]; certificates: string[] }>
  revertAddonConversion(input: { accountId: string; sourceAccountId: string; domains: readonly Domain[] }): Promise<{ domains: string[] }>
  getRevision(): Promise<number>
  getAccount(id: string): Promise<Account | null>
}
export interface ConvertAddonExecutionPorts {
  store: AddonConversionStore
  db: Db
  hashPassword: (password: string) => Promise<string>
  /** applyAccountConfiguration of POST /api/accounts: host apply, then the state revision must still be the expected one. */
  applyConfiguration: (caller: AuthenticatedCaller, account: Account, action: 'create' | 'update', expectedRevision: number) => Promise<unknown>
  /** Agent POST /transfers/convert-addon/(copy|cleanup). */
  callFiles: (caller: AuthenticatedCaller, op: 'copy' | 'cleanup', body: Record<string, unknown>) => Promise<Response>
  /** ExtendedFeaturesStore 'transfers/convert-addon.json'. */
  readJournal: () => Promise<unknown>
  writeJournal: (value: unknown) => Promise<unknown>
  emitAudit: (entry: { actor: string; principalId: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed' }) => Promise<unknown>
  now?: () => Date
}
export type ConversionStage = 'prepared' | 'state-moved' | 'host-applied' | 'files-copied' | 'source-cleaned'
export interface ConversionJournalEntry {
  id: string; startedAt: string; updatedAt: string; actor: string; domain: string; source: string; target: string; accountId: string | null
  stage: ConversionStage; outcome: 'running' | 'completed' | 'refused' | 'rolled-back' | 'unknown'
  files: { files: number; bytes: number; digest: string } | null; reason: string | null
}
const JOURNAL_LIMIT = 200
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Strict journal reader: nothing saved is an empty journal; anything else unreadable stops new conversions. */
export function readConversionJournal(raw: unknown): ConversionJournalEntry[] {
  if (raw === null) return []
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.conversions) || raw.conversions.length > JOURNAL_LIMIT
    || !raw.conversions.every(item => object(item) && typeof item.id === 'string' && typeof item.stage === 'string' && typeof item.outcome === 'string' && typeof item.domain === 'string')) {
    return fail('PRECONDITION_FAILED', 'the addon conversion journal requires review', { stateChanged: false })
  }
  return raw.conversions as unknown as ConversionJournalEntry[]
}

// shortcut: in-process serialization; one API process owns the conversion journal file.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

/**
 * Journaled conversion of a reviewed addon domain into its own account. Order: one atomic desired-state move
 * (store), host apply and panel identity, confined copy of the document root and Maildirs with readback, then the
 * copied-from trees go to the source trash. A failure before the source cleanup reverts the state move; anything
 * that cannot be proven is reported as unknown with the stage it reached.
 */
export function executeAddonConversion(caller: AuthenticatedCaller, plan: ConvertAddonPlan, snapshot: Pick<StateSnapshot, 'revision' | 'domains' | 'accounts'>, ports: ConvertAddonExecutionPorts): Promise<Response> {
  return serial(async () => {
    const now = () => (ports.now?.() ?? new Date()).toISOString()
    // An unreadable journal stops here, before anything changes; earlier unknown outcomes stay listed for review.
    readConversionJournal(await ports.readJournal())
    if (snapshot.revision === undefined) return fail('PRECONDITION_FAILED', 'the reviewed state revision is unavailable', { stateChanged: false })
    const entry: ConversionJournalEntry = { id: randomUUID(), startedAt: now(), updatedAt: now(), actor: caller.principal.username, domain: plan.source.domain, source: plan.source.username, target: plan.target.username,
      accountId: null, stage: 'prepared', outcome: 'running', files: null, reason: null }
    const record = async (patch: Partial<ConversionJournalEntry>): Promise<void> => {
      Object.assign(entry, patch, { updatedAt: now() })
      const current = readConversionJournal(await ports.readJournal()).filter(item => item.id !== entry.id)
      await ports.writeJournal({ version: 1, conversions: [...current, { ...entry }].slice(-JOURNAL_LIMIT) })
    }
    const audit = (action: string, outcome: 'ok' | 'failed', detail: Record<string, unknown>) => ports.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target: 'domain:' + plan.source.domain,
      detail: { conversion: entry.id, source: plan.source.username, target: plan.target.username, stage: entry.stage, ...detail }, outcome }).catch(() => undefined)
    const unknown = async (reason: string): Promise<never> => {
      await record({ outcome: 'unknown', reason }).catch(() => undefined)
      await audit('transfer.convert_addon.unknown', 'failed', { reason })
      return fail('SERVICE_UNAVAILABLE', 'the conversion outcome requires review; see the conversion journal', { stateChanged: true, unknownOutcome: true, verificationRequired: true, stage: entry.stage, conversion: entry.id, reason })
    }
    await record({})
    const source = snapshot.accounts.find(account => account.id === plan.source.accountId)
    const originals = snapshot.domains.filter(domain => plan.domains.some(item => item.id === domain.id))
    if (!source || originals.length !== plan.domains.length || !plan.target.home || !plan.target.documentRoot) { await record({ outcome: 'refused', reason: 'review_incomplete' }); return fail('CONFLICT', 'the reviewed state changed; preview again', { stateChanged: false }) }

    const passwordHash = await ports.hashPassword(randomBytes(32).toString('base64url'))
    let moved: Awaited<ReturnType<AddonConversionStore['convertAddonDomain']>>
    try { moved = await ports.store.convertAddonDomain({ sourceAccountId: source.id, domainId: plan.source.domainId, username: plan.target.username, planId: plan.target.planId, passwordHash, contactEmail: plan.target.username + '@' + plan.source.domain, shell: 'jailed' }, { expectedRevision: snapshot.revision }) }
    catch (error) {
      // The store journal restores every preimage on an ordinary failure; only an unproven publication is unknown.
      if (!isXpanelError(error) || error.code === 'SERVICE_UNAVAILABLE') return unknown('state_move_unproven')
      await record({ outcome: 'refused', reason: error.code })
      throw error
    }
    await record({ stage: 'state-moved', accountId: moved.account.id })

    const rollBack = async (reason: string, hostApplied: boolean): Promise<never> => {
      try {
        const principal = await findPrincipalByAccountId(ports.db, moved.account.id)
        if (principal) await deletePrincipal(ports.db, principal.id)
        await ports.store.revertAddonConversion({ accountId: moved.account.id, sourceAccountId: source.id, domains: originals })
        if (hostApplied) {
          const current = await ports.store.getAccount(source.id)
          if (!current) return unknown('source_account_missing_after_revert')
          await ports.applyConfiguration(caller, current, 'update', await ports.store.getRevision())
        }
      } catch { return unknown(reason + '; rollback_unproven') }
      await record({ outcome: 'rolled-back', reason })
      await audit('transfer.convert_addon.rolled_back', 'failed', { reason, hostApplied })
      // The Linux user and home of the new account stay on the host: termination needs the target-bound purge.
      return fail('PRECONDITION_FAILED', 'the conversion failed and its saved state was rolled back', { stateChanged: hostApplied, rolledBack: true, verificationRequired: hostApplied, reason, conversion: entry.id, ...(hostApplied ? { hostResidue: plan.target.home } : {}) })
    }

    try { await ports.applyConfiguration(caller, moved.account, 'create', snapshot.revision + 1) } catch { return rollBack('host_apply_failed', true) }
    try { await createUserPrincipal(ports.db, { username: moved.account.username, passwordHash, accountId: moved.account.id, forcePasswordChange: true }) } catch { return rollBack('panel_identity_failed', true) }
    await record({ stage: 'host-applied' })

    const fromHome = (path: string): string => posix.relative(source.home, path)
    const items = [{ from: fromHome(plan.source.docRoot), to: posix.relative(plan.target.home, plan.target.documentRoot) }, ...plan.domains.map(domain => ({ from: 'mail/' + domain.name, to: 'mail/' + domain.name }))]
    let copy: Response
    try { copy = await ports.callFiles(caller, 'copy', { source: source.username, target: moved.account.username, items }) } catch { return unknown('file_copy_transport_unknown') }
    const copied = await readReply(copy).catch(() => null)
    if (copy.status !== 200) {
      const details = object(copied) && object(copied.details) ? copied.details : {}
      return details.stateChanged === false ? rollBack('file_copy_refused', true) : unknown('file_copy_unproven')
    }
    if (!object(copied) || !Number.isSafeInteger(copied.files) || !Number.isSafeInteger(copied.bytes) || typeof copied.digest !== 'string' || !Array.isArray(copied.skipped)) return unknown('file_copy_reply_unverified')
    await record({ stage: 'files-copied', files: { files: copied.files as number, bytes: copied.bytes as number, digest: copied.digest } })

    const skipped = new Set(copied.skipped as unknown[])
    let cleanup: Response
    try { cleanup = await ports.callFiles(caller, 'cleanup', { source: source.username, paths: items.filter(item => !skipped.has(item.from)).map(item => item.from) }) } catch { return unknown('source_cleanup_transport_unknown') }
    const cleaned = await readReply(cleanup).catch(() => null)
    if (cleanup.status !== 200 || !object(cleaned) || cleaned.complete !== true) return unknown('source_cleanup_incomplete')
    await record({ stage: 'source-cleaned', outcome: 'completed' })
    await audit('transfer.convert_addon.completed', 'ok', { domains: moved.domains, mailUsers: moved.serviceUsers.length, zones: moved.zones, certificates: moved.certificates.length, files: entry.files })
    return Response.json({ converted: true, conversion: entry.id, account: { id: moved.account.id, username: moved.account.username, primaryDomain: moved.account.primaryDomain },
      moved: { domains: moved.domains, serviceUsers: moved.serviceUsers, zones: moved.zones, certificates: moved.certificates.length }, files: entry.files,
      sourceCleanup: 'moved-to-trash', passwordResetRequired: true }, { headers: { 'cache-control': 'no-store' } })
  })
}
