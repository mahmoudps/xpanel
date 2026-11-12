import { randomUUID } from 'node:crypto'
import { effectivePlan, fail } from '@xpanel/core'
import type { ExtendedFeaturesStore, ExtendedRouteHelpers } from '../extended-routes.ts'
import { passwordHashFromInput } from '../auth.ts'
import { assertAccountFeatures, requireDomainAccount } from '../authorization.ts'
import { passwordAllowed } from '../password-policy.ts'
import { validateForwarderInput } from './forwarder-validation.ts'
import { commitRoutingRevision, readMailRoutingStatus, reconcileApplied } from './routing-application.ts'

export type AddressImportCode = 'WEAK_PASSWORD' | 'LIMIT_EXCEEDED' | 'INVALID_ADDRESS' | 'CONFLICT' | 'FAILED'
interface StoredForwarder { id: string; accountId: string; sourceAddress: string; destinations: string[]; createdAt: string }
export interface AddressImportPorts {
  helpers: ExtendedRouteHelpers
  ext: Pick<ExtendedFeaturesStore, 'readOrDefault' | 'write'>
  requireAccountId: (caller: Awaited<ReturnType<ExtendedRouteHelpers['requireCaller']>>, requested: string | null | undefined, action: string) => Promise<string>
  readJsonBody: <T>(req: Request) => Promise<T>
  jsonResponse: (body: unknown, status?: number) => Response
}
const ROWS_MAX = 5000
const validRows = (rows: unknown): rows is string[][] => Array.isArray(rows) && rows.length <= ROWS_MAX && rows.every(row => Array.isArray(row) && row.length >= 1 && row.length <= 3 && row.every(col => typeof col === 'string' && col.length <= 1024))

/** Address Importer: each row reports its own outcome with a stable code; one apply follows for the whole import. */
export async function handleAddressImport(req: Request, ports: AddressImportPorts): Promise<Response> {
  const { helpers, ext, requireAccountId, readJsonBody, jsonResponse } = ports
  const caller = await helpers.requireCaller(req)
  const body = await readJsonBody<{
    csv?: string
    rows?: string[][]
    accountId?: string
    kind?: 'mailboxes' | 'forwarders' | 'auto'
  }>(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body) || (body.rows === undefined ? typeof body.csv !== 'string' : !validRows(body.rows) || body.csv !== undefined || body.kind === undefined || body.kind === 'auto')) return fail('VALIDATION', 'csv must be a string, or rows a table with a chosen import type')
  if (body.kind !== undefined && !['mailboxes', 'forwarders', 'auto'].includes(body.kind)) return fail('VALIDATION', 'kind must be mailboxes, forwarders or auto')
  if (body.accountId !== undefined && (typeof body.accountId !== 'string' || !body.accountId.trim())) return fail('VALIDATION', 'accountId must be a nonempty string')
  const csvText = (body.csv ?? '').trim()
  if (!csvText && !body.rows?.length) return fail('VALIDATION', 'csv content is required')

  const accountId = await requireAccountId(caller, body.accountId, 'mail.import_csv')

  // The page maps columns itself and sends a table, so a password may hold a comma; csv stays the plain comma form of the API.
  const table: { row: number; cols: string[] }[] = body.rows ? body.rows.map((cols, index) => ({ row: index + 1, cols: cols.map(col => col.trim()) })) : csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((line, index) => ({ row: index + 1, cols: line.split(',').map((c) => c.trim()) }))
    .filter(({ row, cols }) => !(row === 1 && /^(email|address|username|source)\b/i.test(cols[0] ?? '')))

  const importedMailboxes: { email: string; quotaMb: number }[] = []
  const importedForwarders: { sourceAddress: string; destination: string }[] = []
  let importRevision: number | null = null
  const errors: { row: number; code: AddressImportCode; error: string }[] = []
  const includesForwarders = body.kind === 'forwarders' || table.some(({ cols }) => body.kind !== 'mailboxes' && (cols[1] ?? '').includes('@') && !cols[2])
  if (includesForwarders) {
    const account = await helpers.store.getAccount(accountId)
    if (!account) return fail('NOT_FOUND', 'mail account not found')
    await assertAccountFeatures(helpers.store, caller, account, ['forwarders'])
  }

  const target = await helpers.store.getAccount(accountId), targetPlan = target ? await helpers.store.getPlan(target.planId) : null
  const mailboxCap = target && targetPlan ? effectivePlan(targetPlan, target).caps.mailboxes : 0
  let mailboxCount = (await helpers.store.listServiceUsers(accountId)).filter(user => user.services.email).length
  const accountDomains = new Set((await helpers.store.listDomains()).filter(domain => domain.accountId === accountId).map(domain => domain.name))

  for (const { row, cols } of table) {
    const col0 = (cols[0] ?? '').toLowerCase()
    const col1 = cols[1] ?? ''
    const col2 = cols[2] ?? ''

    const isForwarder =
      body.kind === 'forwarders' || (body.kind !== 'mailboxes' && col1.includes('@') && !col2)
    let forwarderInput: ReturnType<typeof validateForwarderInput> | null = null
    if (isForwarder) {
      try { forwarderInput = validateForwarderInput({ sourceAddress: col0, destination: col1 }) }
      catch { errors.push({ row, code: 'INVALID_ADDRESS', error: 'Invalid forwarder source or destination address' }); continue }
    }
    if (!col0.includes('@')) {
      errors.push({ row, code: 'INVALID_ADDRESS', error: 'Invalid email address in column 1' })
      continue
    }

    const mailboxDomain = col0.split('@')[1]!
    // Earlier rows are saved by now, so a domain outside the account fails only its own row. Unknown and foreign domains read alike.
    if (!accountDomains.has(mailboxDomain)) { errors.push({ row, code: 'INVALID_ADDRESS', error: 'This domain is not on the account' }); continue }
    const sourceAccount = await requireDomainAccount(helpers.store, caller, mailboxDomain, 'mail.import_csv', accountId)
    if (sourceAccount.id !== accountId) return fail('NOT_FOUND', 'mail domain not found')

    if (isForwarder && forwarderInput) {
      const lease = await helpers.store.getWriterLock().acquire()
      try {
        const forwarderAccount = await requireDomainAccount(helpers.store, caller, mailboxDomain, 'mail.import_csv', accountId)
        await assertAccountFeatures(helpers.store, caller, forwarderAccount, ['forwarders'])
        const forwarders = await ext.readOrDefault<StoredForwarder[]>('mail/forwarders.json', [])
        const accountForwarders = forwarders.filter(item => item.accountId === accountId)
        if (accountForwarders.some(item => item.sourceAddress.toLowerCase() === forwarderInput.sourceAddress)) {
          errors.push({ row, code: 'CONFLICT', error: 'A forwarder for this source already exists' }); continue
        }
        const plan = await helpers.store.getPlan(forwarderAccount.planId), cap = plan ? effectivePlan(plan, forwarderAccount).caps.forwarders : 0
        if (cap !== 'unlimited' && accountForwarders.length >= cap) {
          errors.push({ row, code: 'LIMIT_EXCEEDED', error: 'The account forwarder limit has been reached' }); continue
        }
        forwarders.push({
          id: randomUUID(),
          accountId,
          sourceAddress: forwarderInput.sourceAddress,
          destinations: forwarderInput.destinations,
          createdAt: new Date().toISOString(),
        })
        await lease.assertFencingToken()
        await ext.write('mail/forwarders.json', forwarders)
        importRevision = await commitRoutingRevision(lease)
        importedForwarders.push({ sourceAddress: forwarderInput.sourceAddress, destination: forwarderInput.destinations[0]! })
      } finally { await lease.release() }
    } else {
      if (mailboxCap !== 'unlimited' && mailboxCount >= mailboxCap) { errors.push({ row, code: 'LIMIT_EXCEEDED', error: 'The account mailbox limit has been reached' }); continue }
      if (!passwordAllowed(col1, 'mail')) { errors.push({ row, code: 'WEAK_PASSWORD', error: 'The password does not meet the mail password strength rule' }); continue }
      const quotaMb = Number(col2) > 0 ? Number(col2) : 1024
      try {
        await helpers.store.createServiceUser({
          accountId,
          login: col0,
          passwordHash: await passwordHashFromInput({ password: col1 }, { service: ['mail'], ...(helpers.serviceHashScheme && { scheme: helpers.serviceHashScheme }) }),
          services: { email: true, ftp: false, webdisk: false },
          mailboxQuotaMb: quotaMb,
          ftpDir: 'public_html',
        })
      } catch {
        errors.push({ row, code: 'FAILED', error: 'Mailbox could not be created; check credentials, domain and account limits' })
        continue
      }
      mailboxCount++
      importedMailboxes.push({ email: col0, quotaMb })
    }
  }

  // one apply for the whole import; a failed test is reported, the imported rows stay saved for review
  let application: { state: string; reason: string | null; revision: number } | undefined
  let nativeApplied = false
  if (importRevision !== null || importedMailboxes.length > 0) {
    let failedApply: string | null = null
    try {
      const reconcile = await helpers.triggerReconcile(caller)
      if (reconcile?.body.status === 'failed') failedApply = String(reconcile.body.error ?? 'mail configuration test failed').slice(0, 500)
      nativeApplied = reconcileApplied(reconcile)
    } catch { /* the status read below reports the host state */ }
    if (importRevision !== null) {
      const status = await readMailRoutingStatus(helpers.store, helpers.db, failedApply)
      application = { ...status.record('forwarder', '', { domain: importedForwarders[0]!.sourceAddress.split('@')[1]! }), revision: importRevision }
    }
  }
  await helpers.emitAudit({
    actor: caller.principal.username,
    action: 'mail.import_csv',
    target: 'mail:csv-import',
    detail: {
      mailboxesCount: importedMailboxes.length,
      forwardersCount: importedForwarders.length,
      ...(application ? { application } : {}),
      nativeApplied,
      errorsCount: errors.length,
    },
    outcome: 'ok',
    principalId: caller.principal.id,
  })
  return jsonResponse({
    ok: true,
    importedMailboxes,
    importedForwarders,
    ...(application ? { application } : {}),
    nativeApplied,
    errors,
    summary: {
      mailboxesImported: importedMailboxes.length,
      forwardersImported: importedForwarders.length,
      errorCount: errors.length,
    },
  })
}
