import { fail, isXpanelError } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { TransferReview, TransferSession } from '@xpanel/lifecycle'
import type { AuthenticatedCaller } from './auth.ts'
import { httpsTransferSourceStreamTransport, httpsTransferSourceTransport } from './acct-transfer-discovery.ts'
import type { TransferSourceStreamTransport, TransferSourceTransport } from './acct-transfer-discovery.ts'
import { transferSourceBackupPath, verifyTransferManifest } from './acct-transfer-source.ts'
import type { TransferArchiveManifest } from './acct-transfer-source.ts'
import { readReply } from './backup-file-restore-workspace.ts'
import type { TransferProgressEvent, TransferWorkspacePorts } from './transfer-workspace.ts'

export interface TransferExecutionDeps {
  store: Pick<StateStore, 'listAccounts' | 'listDomains' | 'listPlans'>
  readToken: (id: string) => Promise<string | null>
  transport?: TransferSourceTransport
  streamTransport?: TransferSourceStreamTransport
  /** Agent POST /transfers/destination/accounts/<username>/archives with the streamed archive body. */
  importArchive: (caller: AuthenticatedCaller, username: string, body: ReadableStream<Uint8Array>, expected: { bytes: number; sha256: string }) => Promise<Response>
  /** Desired-state account, panel principal and host apply, as POST /api/accounts does. Its password is unusable until root resets it. */
  createAccount: (caller: AuthenticatedCaller, input: { username: string; primaryDomain: string; planId: string }) => Promise<{ id: string; username: string }>
  /** Agent POST /accounts/<username>/backups { op: 'restore', file }: the existing whole-home restore. */
  restoreArchive: (caller: AuthenticatedCaller, username: string, file: string) => Promise<Response>
  /** Agent POST /transfers/destination/accounts/<username>/verify { file }. */
  verifyArchive: (caller: AuthenticatedCaller, username: string, file: string) => Promise<Response>
  audit?: (caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed') => Promise<unknown>
}

/** Creating a 2 GiB home archive on the source can take minutes; the download has its own byte bound. */
export const TRANSFER_EXPORT_TIMEOUT_MS = 30 * 60_000
export const TRANSFER_DOWNLOAD_TIMEOUT_MS = 60 * 60_000
const precondition = (message: string): never => fail('PRECONDITION_FAILED', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const streamOf = (chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> => {
  const iterator = chunks[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value) },
    async cancel() { await iterator.return?.() },
  })
}
/** Phase messages stay plain: they are journaled in the session and shown to root. */
const reason = (error: unknown, fallback: string): string => isXpanelError(error) && error.message.length <= 300 ? error.message : fallback

/**
 * TransferWorkspacePorts.execution over the pinned HTTPS + Bearer channel. Per account: a signed archive manifest
 * from the source, a streamed download stored only after its size and SHA-256 match, a new account here, the
 * existing whole-home restore, then a comparison of the home with the archive. Only the primary domain is set
 * up here; other domains, mailbox logins and databases are reported in the audit record as not transferred.
 */
export function createTransferExecution(deps: TransferExecutionDeps): NonNullable<TransferWorkspacePorts['execution']> {
  const transport = deps.transport ?? httpsTransferSourceTransport, streamTransport = deps.streamTransport ?? httpsTransferSourceStreamTransport
  const channel = async (session: TransferSession): Promise<{ url: string; token: string; tlsFingerprint: string | null }> => {
    if (session.auth.kind !== 'api-token') return precondition('server transfers run over the source API token channel; SSH sources are unavailable')
    const token = await deps.readToken(session.auth.tokenId)
    if (!token) return precondition('the stored source credential no longer exists')
    return { url: session.auth.url, token, tlsFingerprint: session.auth.tlsFingerprint }
  }
  const planIds = async (review: TransferReview): Promise<Map<string, string>> => {
    const local = new Map((await deps.store.listPlans()).map(plan => [plan.name, plan.id]))
    if (review.plans.some(plan => plan.action !== 'map')) return precondition('map every selected source plan to a plan on this server; plans are not created during a transfer')
    const missing = review.accounts.filter(account => !local.has(account.plan))
    if (missing.length) return precondition('a reviewed account needs a plan that does not exist on this server')
    return local
  }
  const primaryOf = (session: TransferSession, source: string, dropped: readonly string[]): string => {
    const primary = session.inventory?.accounts.find(account => account.username === source)?.primaryDomain
    if (!primary || dropped.includes(primary)) return precondition('the primary domain of a reviewed account is dropped or missing; review the transfer again')
    return primary
  }
  return {
    admit: async (caller, session, review) => {
      if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root access is required', { stateChanged: false })
      await channel(session)
      await planIds(review)
      for (const account of review.accounts) primaryOf(session, account.source, account.droppedDomains)
    },
    run: async (caller, session, review, emit) => {
      const source = await channel(session), plans = await planIds(review)
      const hostname = session.source?.hostname ?? precondition('the transfer source is not connected')
      for (const account of review.accounts) {
        const progress = (phase: TransferProgressEvent['phase'], extra: Pick<TransferProgressEvent, 'bytes' | 'error'> = {}): Promise<void> => emit({ type: 'progress', account: account.source, phase, ...extra })
        let created = false, manifest: TransferArchiveManifest | null = null
        try {
          await progress('exporting')
          const primaryDomain = primaryOf(session, account.source, account.droppedDomains)
          const [accounts, domains] = await Promise.all([deps.store.listAccounts(), deps.store.listDomains()])
          if (accounts.some(item => item.username === account.target) || domains.some(domain => domain.name === primaryDomain)) precondition('this server already has the account name or its primary domain; nothing was changed')
          let reply
          try { reply = await transport({ ...source, url: source.url + transferSourceBackupPath(account.source), method: 'POST', body: '{}', timeoutMs: TRANSFER_EXPORT_TIMEOUT_MS, maxBytes: 64 * 1024 }) }
          catch { return precondition('the source could not be reached over the authenticated HTTPS channel') }
          if (reply.status !== 201 || reply.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') precondition('the source did not create an account archive')
          let raw: unknown
          try { raw = JSON.parse(reply.body) } catch { raw = null }
          manifest = verifyTransferManifest(raw, source.token, { source: hostname, username: account.source })
          await progress('copying')
          let download
          try { download = await streamTransport({ ...source, url: source.url + transferSourceBackupPath(account.source, manifest.file), timeoutMs: TRANSFER_DOWNLOAD_TIMEOUT_MS, maxBytes: manifest.bytes }) }
          catch { return precondition('the archive download could not start over the authenticated HTTPS channel') }
          if (download.status !== 200 || download.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/gzip') { await (download.body as AsyncIterable<Uint8Array> & { return?: () => Promise<unknown> })[Symbol.asyncIterator]().return?.(); precondition('the source did not send the archive') }
          const stored = await deps.importArchive(caller, account.target, streamOf(download.body), { bytes: manifest.bytes, sha256: manifest.sha256 })
          const receipt = stored.status === 201 ? await readReply(stored) : (await stored.body?.cancel().catch(() => undefined), null)
          if (!object(receipt) || typeof receipt.file !== 'string' || receipt.bytes !== manifest.bytes || receipt.sha256 !== manifest.sha256) precondition('the archive did not arrive with its signed size and SHA-256; nothing was restored')
          const file = (receipt as { file: string }).file
          await progress('importing', { bytes: manifest.bytes })
          // From here on this server changes: a failure leaves an account that needs review, never a silent rollback.
          created = true
          const local = await deps.createAccount(caller, { username: account.target, primaryDomain, planId: plans.get(account.plan)! })
          if (local.username !== account.target) precondition('the destination account could not be verified')
          await progress('reconciling')
          const restored = await deps.restoreArchive(caller, account.target, file)
          const restoreReply = restored.status === 200 ? await readReply(restored) : (await restored.body?.cancel().catch(() => undefined), null)
          if (!object(restoreReply) || !object(restoreReply.backup) || restoreReply.backup.file !== file) precondition('the home restore outcome could not be verified')
          const verified = await deps.verifyArchive(caller, account.target, file)
          const verifyReply = verified.status === 200 ? await readReply(verified) : (await verified.body?.cancel().catch(() => undefined), null)
          if (!object(verifyReply) || verifyReply.verified !== true || verifyReply.archiveSha256 !== manifest.sha256) precondition('the restored home does not match the archive')
          await progress('done', { bytes: manifest.bytes })
          await deps.audit?.(caller, 'transfer.account.imported', 'account:' + account.target, { source: account.source, archiveSha256: manifest.sha256, bytes: manifest.bytes, mailCompared: false, passwordResetRequired: true,
            notTransferred: { domains: account.domains.filter(domain => domain !== primaryDomain), databases: account.databases, mailboxLogins: account.mailboxes } }, 'ok').catch(() => undefined)
        } catch (error) {
          const message = created ? 'The account exists on this server, but its restore was not verified (' + reason(error, 'outcome unknown') + '). Review it before retrying.' : reason(error, 'the account could not be transferred; nothing was changed')
          await progress('failed', { error: message })
          await deps.audit?.(caller, 'transfer.account.failed', 'account:' + account.target, { source: account.source, stateChanged: created, verificationRequired: created, ...(manifest ? { archiveSha256: manifest.sha256 } : {}) }, 'failed').catch(() => undefined)
        }
      }
    },
  }
}
