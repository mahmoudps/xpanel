import { randomUUID } from 'node:crypto'
import { DB_NAME_MAX, fail, isXpanelError } from '@xpanel/core'
import type { Account, DnsRecordType, Domain, Id, PhpSettings } from '@xpanel/core'
import { isPhpVersion } from '@xpanel/os'
import type { StateStore } from '@xpanel/state'
import type { ReviewAccount, TransferReview, TransferSession } from '@xpanel/lifecycle'
import type { AuthenticatedCaller } from './auth.ts'
import { httpsTransferSourceTransport } from './acct-transfer-discovery.ts'
import type { TransferSourceTransport } from './acct-transfer-discovery.ts'
import { transferSourcePackagePath, verifyTransferManifest } from './acct-transfer-source.ts'
import type { TransferAccountBundle, TransferPackageManifest } from './acct-transfer-source.ts'
import { readReply } from './backup-file-restore-workspace.ts'
import type { TransferAccountResult, TransferProgressEvent, TransferWorkspacePorts } from './transfer-workspace.ts'

/** callAgent bound to the API: JSON in, Response out. */
export type TransferAgentCall = (caller: AuthenticatedCaller, path: string, init?: { method?: string; body?: unknown }) => Promise<Response>

export interface TransferExecutionDeps {
  store: Pick<StateStore, 'listAccounts' | 'listDomains' | 'listPlans' | 'listFeatureLists' | 'getAccount' | 'getAccountByUsername' |'getServerSettings' | 'getDnsZone' | 'createPlan' | 'createDomain' | 'updateDomain'
    | 'createDatabase' | 'createDatabaseUser' | 'setGrant' | 'createServiceUser' | 'saveDnsZone' | 'saveCronJobs' | 'saveCertificateBinding'>
  readToken: (id: string) => Promise<string | null>
  transport?: TransferSourceTransport
  agent: TransferAgentCall
  /** Desired-state account, panel principal (password unusable until reset) and host apply, as POST /api/accounts. */
  createAccount: (caller: AuthenticatedCaller, input: { username: string; primaryDomain: string; planId: string }) => Promise<Account>
  /** Host apply of the account's current desired state, with revision readback. */
  applyAccount: (caller: AuthenticatedCaller, account: Account) => Promise<unknown>
  /** The verified account purge of DELETE /api/accounts/<id>: the rollback of a failed account. */
  removeAccount: (caller: AuthenticatedCaller, account: Account) => Promise<void>
  /** this server's default PHP, the fallback for versions it does not ship */
  defaultPhp: () => Promise<PhpSettings>
  audit?: (caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed') => Promise<unknown>
  /** Poll interval for source packaging and host tasks. */
  pollMs?: number
}

/** Packaging a large home on the source and copying it can take a long time; each wait has its own bound. */
export const TRANSFER_STEP_TIMEOUT_MS = 6 * 60 * 60_000
const precondition = (message: string): never => fail('PRECONDITION_FAILED', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** Phase messages stay plain: they are journaled in the session and shown to root. */
export const transferReason = (error: unknown, fallback: string): string => isXpanelError(error) && error.message.length <= 300 ? error.message : fallback
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Starts a host task and waits for its outcome; a failed or interrupted task fails with its own message. */
export async function runHostTask(agent: TransferAgentCall, caller: AuthenticatedCaller, body: Record<string, unknown>, pollMs: number): Promise<{ id: string; result: Record<string, unknown> }> {
  const started = await agent(caller, '/transfers/tasks', { method: 'POST', body })
  const reply = started.status === 202 ? await readReply(started) as { task?: { id?: unknown } } | null : null
  if (started.status !== 202) {
    const problem = await readReply(started).catch(() => null) as { detail?: unknown; message?: unknown } | null
    return precondition('the host could not start the ' + String(body.kind) + ' task' + (typeof problem?.detail === 'string' ? ': ' + problem.detail.slice(0, 200) : ''))
  }
  const id = typeof reply?.task?.id === 'string' ? reply.task.id : precondition('the host did not return a task')
  const deadline = Date.now() + TRANSFER_STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const read = await agent(caller, '/transfers/tasks/' + id)
    const task = read.status === 200 ? (await readReply(read) as { task?: Record<string, unknown> } | null)?.task : null
    if (!object(task)) return precondition('the host task could not be read')
    if (task.state === 'succeeded' && object(task.result)) return { id, result: task.result }
    if (task.state === 'failed' || task.state === 'interrupted') return precondition(typeof task.error === 'string' ? task.error : 'the host task failed')
    await sleep(pollMs)
  }
  return precondition('the host task did not finish in time')
}

/** source_x -> target_x for databases and database users when the account is renamed. */
export const renamePrefixed = (name: string, source: string, target: string, max = DB_NAME_MAX): string => {
  if (!name.startsWith(source + '_')) return precondition(name + ' does not carry the account prefix')
  const renamed = target + name.slice(source.length)
  return renamed.length <= max ? renamed : precondition(renamed + ' would exceed the database name limit; rename the account to a shorter name')
}
const rebaseHome = (path: string, from: string, to: string): string =>
  path === from ? to : path.startsWith(from + '/') ? to + path.slice(from.length) : precondition('a path is outside the source account home')
/** Zone records for this server: A records that pointed at the source account move to the new address, apex NS name this server's name servers. */
export const transferZoneRecords = (zone: string, records: TransferAccountBundle['zones'][number]['records'], move: { from: string; to: string }, nameservers: readonly string[]) => {
  const kept = records.filter(record => !(record.type === 'NS' && record.name === '@' && nameservers.length))
    .map(record => ({ id: randomUUID(), zone, name: record.name, type: record.type as DnsRecordType, ttl: record.ttl, priority: record.priority, content: record.type === 'A' && record.content === move.from ? move.to : record.content }))
  return [...kept, ...(records.some(record => record.type === 'NS' && record.name === '@') ? nameservers.map(ns => ({ id: randomUUID(), zone, name: '@', type: 'NS' as DnsRecordType, ttl: 86_400, priority: null, content: ns.replace(/\.?$/, '.') })) : [])]
}
/** Parents before children, so every subdomain and alias finds its parent here. */
const parentsFirst = <T extends { name: string; parent: string | null }>(items: readonly T[], placed: Set<string>): T[] => {
  const out: T[] = [], rest = [...items]
  while (rest.length) {
    const index = rest.findIndex(item => item.parent === null || placed.has(item.parent))
    if (index < 0) return precondition('a domain refers to a parent that is not transferred')
    const [item] = rest.splice(index, 1) as [T]
    placed.add(item.name)
    out.push(item)
  }
  return out
}
const zoneSerial = (previous: number | undefined): number => {
  const today = Number(new Date().toISOString().slice(0, 10).replaceAll('-', '')) * 100 + 1
  return Math.max(today, (previous ?? 0) + 1)
}

/** Writes the source account's desired state onto the new account: domains, PHP, databases, users, mailboxes, zones and cron. */
async function applyBundle(deps: TransferExecutionDeps, account: Account, bundle: TransferAccountBundle, review: ReviewAccount): Promise<Omit<TransferAccountResult, 'home' | 'certificates' | 'rolledBack'>> {
  const source = bundle.account.username, target = account.username, dropped = new Set(review.droppedDomains), fallback = (await deps.defaultPhp()).version
  const php = (settings: PhpSettings): PhpSettings => isPhpVersion(settings.version) ? settings : { ...settings, version: fallback }
  const domains = new Map<string, Domain>((await deps.store.listDomains()).filter(domain => domain.accountId === account.id).map(domain => [domain.name, domain]))
  const wanted = bundle.domains.filter(domain => !dropped.has(domain.name))
  const primary = wanted.find(domain => domain.name === account.primaryDomain) ?? precondition('the primary domain is not in the transfer package')
  const primaryRecord = domains.get(primary.name) ?? precondition('the new account has no primary domain')
  await deps.store.updateDomain(primaryRecord.id, { docRoot: rebaseHome(primary.docRoot, bundle.account.home, account.home), siteType: primary.siteType, upstream: primary.upstream, redirect: primary.redirect, php: php(primary.php), wildcard: primary.wildcard, ...(primary.indexFiles ? { indexFiles: primary.indexFiles } : {}) })
  for (const domain of parentsFirst(wanted.filter(item => item.name !== primary.name), new Set([primary.name]))) {
    const created = await deps.store.createDomain({ accountId: account.id, name: domain.name, kind: domain.kind, parentId: domain.parent ? domains.get(domain.parent)?.id ?? precondition('the parent of ' + domain.name + ' is missing') : null,
      docRoot: rebaseHome(domain.docRoot, bundle.account.home, account.home), siteType: domain.siteType, upstream: domain.upstream, redirect: domain.redirect, php: php(domain.php), wildcard: domain.wildcard,
      certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...(domain.indexFiles ? { indexFiles: domain.indexFiles } : {}) })
    domains.set(created.name, created)
  }
  const databases = new Map<string, Id>()
  for (const db of bundle.databases) databases.set(db.name, (await deps.store.createDatabase({ accountId: account.id, name: renamePrefixed(db.name, source, target) })).id)
  for (const user of bundle.databaseUsers) {
    const name = user.name === source ? target : renamePrefixed(user.name, source, target, 80)
    const created = await deps.store.createDatabaseUser({ accountId: account.id, name, authString: user.authString, authPlugin: user.authPlugin })
    for (const grant of user.grants) if (databases.has(grant.database)) await deps.store.setGrant({ databaseUserId: created.id, databaseId: databases.get(grant.database)!, privileges: grant.privileges })
  }
  const mailboxes = bundle.mailboxes.filter(box => domains.has(box.login.split('@')[1] ?? ''))
  for (const box of mailboxes) await deps.store.createServiceUser({ accountId: account.id, login: box.login, services: box.services, mailboxQuotaMb: box.mailboxQuotaMb, ftpDir: box.ftpDir, passwordHash: box.passwordHash })
  const nameservers = (await deps.store.getServerSettings())?.nameservers ?? []
  const zones = bundle.zones.filter(zone => domains.has(zone.name))
  for (const zone of zones) {
    const existing = await deps.store.getDnsZone(zone.name)
    if (existing && existing.accountId !== account.id) precondition('the DNS zone ' + zone.name + ' belongs to another account here')
    await deps.store.saveDnsZone({ id: existing?.id ?? randomUUID(), accountId: account.id, name: zone.name, serial: zoneSerial(existing?.serial), records: transferZoneRecords(zone.name, zone.records, { from: bundle.account.ipv4, to: account.ipv4 }, nameservers) })
  }
  await deps.store.saveCronJobs(account.id, bundle.cron.map(job => ({ ...job, id: randomUUID(), accountId: account.id, command: job.command.replaceAll(bundle.account.home + '/', account.home + '/') })))
  return {
    domains: [...domains.keys()].sort(), droppedDomains: [...dropped].sort(), databases: [...databases.keys()].map(name => renamePrefixed(name, source, target)),
    databaseUsers: bundle.databaseUsers.length, mailboxes: mailboxes.length, zones: zones.map(zone => zone.name), cronJobs: bundle.cron.length,
    php: [...new Set(wanted.map(domain => php(domain.php).version))].sort(), plan: review.plan,
  }
}

/** Binds the candidate certificates the host wrote; each one serves the domain it was installed for. */
export async function bindCertificates(store: TransferExecutionDeps['store'], account: Account, installed: unknown): Promise<number> {
  if (!Array.isArray(installed)) return 0
  const domains = new Map((await store.listDomains()).filter(domain => domain.accountId === account.id).map(domain => [domain.name, domain.id]))
  let bound = 0
  for (const cert of installed) {
    if (!object(cert) || typeof cert.domain !== 'string' || !domains.has(cert.domain)) continue
    await store.saveCertificateBinding({ id: cert.id as string, accountId: account.id, names: cert.names as string[], source: 'upload', challenge: null, notBefore: (cert.notBefore as string | null) ?? null, notAfter: cert.notAfter as string,
      autoRenew: false, certPath: cert.certPath as string, keyPath: cert.keyPath as string, chainPath: null, fingerprintSha256: (cert.fingerprintSha256 as string | null) ?? null }, domains.get(cert.domain)!)
    bound++
  }
  return bound
}

/** Plan named in the review: a local plan, or the source plan created here under its reviewed name. */
async function planFor(deps: TransferExecutionDeps, review: TransferReview, account: ReviewAccount, bundle: TransferAccountBundle): Promise<string> {
  const local = (await deps.store.listPlans()).find(plan => plan.name === account.plan)
  if (local) return local.id
  if (!review.plans.some(plan => plan.target === account.plan && plan.action !== 'map')) return precondition('plan ' + account.plan + ' does not exist on this server')
  const features = (await deps.store.listFeatureLists({ ownerId: null }))[0] ?? precondition('this server has no feature list for a new plan')
  return (await deps.store.createPlan({ ...bundle.plan, name: account.plan, ownerId: null, featureListId: features.id })).id
}

/**
 * TransferWorkspacePorts.execution over the pinned HTTPS + Bearer channel. Accounts run one at a time: the source
 * packages the account (home with mail, one dump per database, certificates and its desired state), this host copies
 * every artifact and checks its signed size and SHA-256, the account is rebuilt here, then the home is restored and
 * compared, the databases are loaded and the certificates installed. A failure after the account exists removes it.
 */
export function createTransferExecution(deps: TransferExecutionDeps): NonNullable<TransferWorkspacePorts['execution']> {
  const transport = deps.transport ?? httpsTransferSourceTransport
  const pollMs = deps.pollMs ?? 3000
  const channel = async (session: TransferSession): Promise<{ url: string; token: string; tlsFingerprint: string | null }> => {
    if (session.auth.kind !== 'api-token') return precondition('server transfers run over the source API token channel; SSH sources are unavailable')
    const token = await deps.readToken(session.auth.tokenId)
    if (!token) return precondition('the stored source credential no longer exists')
    return { url: session.auth.url, token, tlsFingerprint: session.auth.tlsFingerprint }
  }
  const sourceJson = async (source: Awaited<ReturnType<typeof channel>>, path: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> => {
    let reply
    try { reply = await transport({ ...source, url: source.url + path, method, ...(method === 'POST' ? { body: '{}' } : {}), timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 }) }
    catch { return precondition('the source could not be reached over the authenticated HTTPS channel') }
    if (![200, 202].includes(reply.status) || reply.contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return precondition('the source refused the package request (' + reply.status + ')')
    try { return JSON.parse(reply.body) } catch { return precondition('the source reply was not JSON') }
  }
  const audit = (caller: AuthenticatedCaller, action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok') => deps.audit?.(caller, action, target, detail, outcome).catch(() => undefined)

  /** Removes only the account this run created (by id); an account that merely shares the target username is never touched. */
  const removeCreated = async (caller: AuthenticatedCaller, accountId: string | null | undefined): Promise<boolean> => {
    const leftover = accountId ? await deps.store.getAccount(accountId) : null
    if (!leftover) return false
    await deps.removeAccount(caller, leftover)
    return true
  }

  return {
    admit: async (caller, session, review) => {
      if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root access is required', { stateChanged: false })
      await channel(session)
      const local = new Set((await deps.store.listPlans()).map(plan => plan.name))
      for (const account of review.accounts) if (!local.has(account.plan) && !review.plans.some(plan => plan.target === account.plan && plan.action !== 'map')) precondition('plan ' + account.plan + ' of ' + account.source + ' does not exist here')
    },
    /** Rollback of an account that was in flight when the API stopped: the partial account this run created is removed. */
    recover: async (caller, _account, result) => removeCreated(caller, result?.createdAccountId),
    run: async (caller, session, review, emit, shouldStop) => {
      const hostname = session.source?.hostname ?? precondition('the transfer source is not connected')
      for (const account of review.accounts) {
        // after a restart the accounts already finished (or rolled back) are not run again
        if (session.progress[account.source]?.phase !== 'pending') continue
        if (await shouldStop()) return
        const target = 'account:' + account.target
        const progress = (phase: TransferProgressEvent['phase'], extra: Pick<TransferProgressEvent, 'bytes' | 'error'> = {}, result?: TransferAccountResult): Promise<void> => emit({ type: 'progress', account: account.source, phase, ...extra }, result)
        let packageId: string | null = null, fetchId: string | null = null, source: Awaited<ReturnType<typeof channel>> | null = null, createdId: string | null = null
        try {
          if (await deps.store.getAccountByUsername(account.target)) precondition('this server already has an account named ' + account.target + '; nothing was changed')
          source = await channel(session)
          await progress('exporting')
          const started = await sourceJson(source, transferSourcePackagePath(account.source), 'POST') as { package?: unknown }
          packageId = typeof started?.package === 'string' && /^[0-9a-f-]{36}$/.test(started.package) ? started.package : precondition('the source did not start a package')
          let manifest: TransferPackageManifest | null = null
          for (const deadline = Date.now() + TRANSFER_STEP_TIMEOUT_MS; !manifest;) {
            const polled = await sourceJson(source, transferSourcePackagePath(account.source, packageId)) as Record<string, unknown>
            if (polled?.state === 'ready') manifest = verifyTransferManifest(polled, source.token, { source: hostname, username: account.source, package: packageId })
            else if (polled?.state === 'failed') precondition('the source could not package the account: ' + String(polled.error).slice(0, 200))
            else if (Date.now() > deadline) precondition('the source did not finish packaging in time')
            else await sleep(pollMs)
          }
          await audit(caller, 'transfer.account.exported', target, { source: account.source, artifacts: manifest.artifacts.length })
          await progress('copying')
          const bytes = manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)
          const fetched = await runHostTask(deps.agent, caller, { kind: 'fetch', username: account.target, url: source.url + transferSourcePackagePath(account.source, packageId), token: source.token, tlsFingerprint: source.tlsFingerprint, artifacts: manifest.artifacts }, pollMs)
          fetchId = fetched.id
          await audit(caller, 'transfer.account.copied', target, { source: account.source, bytes })
          const bundle = manifest.bundle
          const primaryDomain = account.domains.includes(bundle.account.primaryDomain) ? bundle.account.primaryDomain : precondition('the primary domain of ' + account.source + ' is dropped; it cannot be transferred')
          const local = await deps.createAccount(caller, { username: account.target, primaryDomain, planId: await planFor(deps, review, account, bundle) })
          createdId = local.id
          // the created identity is persisted with the phase, so a restart rolls back this account and no other
          await progress('importing', { bytes }, { createdAccountId: local.id } as TransferAccountResult)
          const applied = await applyBundle(deps, local, bundle, account)
          await deps.applyAccount(caller, (await deps.store.getAccountByUsername(account.target)) ?? local)
          await audit(caller, 'transfer.account.state_applied', target, { source: account.source, domains: applied.domains.length, databases: applied.databases.length, mailboxes: applied.mailboxes, zones: applied.zones.length, cronJobs: applied.cronJobs })
          await progress('reconciling')
          const dbMap = bundle.databases.map(db => ({ artifact: db.artifact, target: renamePrefixed(db.name, account.source, account.target) }))
          const certs = bundle.certificates.flatMap(cert => {
            const owner = cert.names.map(name => name.replace(/^\*\./, '')).find(name => applied.domains.includes(name))
            return owner && cert.names.every(name => applied.domains.includes(name.replace(/^\*\./, ''))) ? [{ cert: cert.cert, key: cert.key, domain: owner }] : []
          })
          const restored = await runHostTask(deps.agent, caller, { kind: 'restore', username: account.target, fetch: fetchId, databases: dbMap, certificates: certs }, pollMs)
          fetchId = null
          const certificates = await bindCertificates(deps.store, local, restored.result.certificates)
          if (certificates) await deps.applyAccount(caller, (await deps.store.getAccountByUsername(account.target)) ?? local)
          const result: TransferAccountResult = { ...applied, home: { bytes: manifest.artifacts.find(artifact => artifact.name === 'home.tar.gz')!.bytes, compared: true }, certificates, rolledBack: false,
            databases: (restored.result.databases as { name: string; tables: number }[] | undefined)?.map(db => db.name) ?? applied.databases }
          await audit(caller, 'transfer.account.imported', target, { source: account.source, ...result })
          await progress('done', { bytes }, result)
        } catch (error) {
          let rolledBack = false, rollbackFailed = false
          try { rolledBack = await removeCreated(caller, createdId) } catch { rollbackFailed = true }
          const why = transferReason(error, 'the account could not be transferred')
          const message = rollbackFailed ? why + '. The partial account could not be removed; review ' + account.target + ' before retrying.'
            : rolledBack ? why + '. The partial account was removed; nothing of it remains here.' : why + '. Nothing was changed here.'
          await audit(caller, rolledBack ? 'transfer.account.rolled_back' : 'transfer.account.failed', target, { source: account.source, stateChanged: rollbackFailed, verificationRequired: rollbackFailed }, 'failed')
          await progress('failed', { error: message }, { rolledBack, rollbackFailed } as TransferAccountResult)
        } finally {
          if (fetchId) await deps.agent(caller, '/transfers/tasks/' + fetchId, { method: 'DELETE' }).then(response => response.body?.cancel()).catch(() => undefined)
          if (source && packageId) await transport({ ...source, url: source.url + transferSourcePackagePath(account.source, packageId), method: 'DELETE', timeoutMs: 30_000, maxBytes: 64 * 1024 }).catch(() => undefined)
        }
      }
    },
  }
}
