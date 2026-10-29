import { randomBytes, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Domain, DnsRecordType, PhpSettings, ServiceUser } from '@xpanel/core'
import { isPhpVersion } from '@xpanel/os'
import { services } from '@xpanel/render'
import type { AuthenticatedCaller } from './auth.ts'
import { bindCertificates, runHostTask } from './lifecycle-transfer-execution.ts'
import type { TransferAgentCall, TransferExecutionDeps } from './lifecycle-transfer-execution.ts'
import { readReply } from './backup-file-restore-workspace.ts'
import type { CpanelImportPorts, CpanelImportRecord } from './transfer-workspace.ts'

export interface CpanelImportDeps extends Pick<TransferExecutionDeps, 'store' | 'agent' | 'createAccount' | 'applyAccount' | 'removeAccount' | 'defaultPhp' | 'audit' | 'pollMs'> {
  uploadDir: string
  maxBytes: number
  /** scheme-tagged hash for a mailbox password nobody knows ({ARGON2ID}…): the owner sets a new one */
  serviceHash: (password: string) => Promise<string>
}

const precondition = (message: string): never => fail('PRECONDITION_FAILED', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(object) : []
const unknownPassword = (): string => randomBytes(32).toString('base64url')
/** The parser expands ALL PRIVILEGES to every database privilege; the account model stores that as ALL PRIVILEGES and has no DELETE HISTORY. */
export const grantPrivileges = (list: readonly string[]): string[] =>
  services.MARIADB_PRIVILEGES.every(privilege => list.includes(privilege)) ? ['ALL PRIVILEGES'] : list.filter(privilege => privilege !== 'DELETE HISTORY')

/** Parents before children; cPanel subdomains and aliases name their parent domain. */
const parentsFirst = (domains: Record<string, unknown>[], placed: Set<string>): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [], rest = [...domains]
  while (rest.length) {
    const index = rest.findIndex(domain => domain.parent === null || placed.has(String(domain.parent)))
    if (index < 0) return precondition('a domain in the archive refers to a parent that is not imported')
    const [domain] = rest.splice(index, 1) as [Record<string, unknown>]
    placed.add(String(domain.name))
    out.push(domain)
  }
  return out
}

/**
 * Builds the reviewed cPanel account here: domains with their document roots and PHP version, databases and users
 * (new passwords required), mailboxes (new passwords required), zones with this server's name servers, cron jobs paused.
 * The host then restores the home with its mail, loads each dump and installs the certificates.
 */
async function applyPlan(deps: CpanelImportDeps, caller: AuthenticatedCaller, record: CpanelImportRecord, planId: string, created: (accountId: string) => Promise<void>): Promise<Record<string, unknown>> {
  const plan = record.plan ?? precondition('the archive has not been reviewed')
  const source = object(plan.account) ? plan.account : precondition('the reviewed plan has no account')
  const username = String(source.username), primaryDomain = String(source.primaryDomain)
  if (await deps.store.getAccountByUsername(username)) precondition('an account named ' + username + ' exists here')
  const account = await deps.createAccount(caller, { username, primaryDomain, planId })
  await created(account.id)
  const fallback = await deps.defaultPhp()
  const php = (version: unknown): PhpSettings => typeof version === 'string' && isPhpVersion(version) ? { ...fallback, version } : fallback
  const domains = new Map<string, Domain>((await deps.store.listDomains()).filter(domain => domain.accountId === account.id).map(domain => [domain.name, domain]))
  const planned = records(plan.domains)
  const primary = planned.find(domain => domain.name === primaryDomain)
  const docRoot = (domain: Record<string, unknown>): string => {
    const relative = String(domain.docRoot ?? '')
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) return precondition('the document root of ' + String(domain.name) + ' is not inside the home')
    return account.home + '/' + relative
  }
  if (primary) await deps.store.updateDomain(domains.get(primaryDomain)!.id, { docRoot: docRoot(primary), php: php(primary.phpVersion), wildcard: primary.wildcard === true })
  for (const domain of parentsFirst(planned.filter(item => item.name !== primaryDomain), new Set([primaryDomain]))) {
    const name = String(domain.name), kind = domain.kind as Domain['kind']
    const created = await deps.store.createDomain({ accountId: account.id, name, kind, parentId: domain.parent ? domains.get(String(domain.parent))?.id ?? precondition('the parent of ' + name + ' is missing') : null,
      docRoot: kind === 'alias' ? domains.get(String(domain.parent))!.docRoot : docRoot(domain), siteType: 'php', upstream: null, redirect: null, php: php(domain.phpVersion), wildcard: domain.wildcard === true,
      certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' })
    domains.set(name, created)
  }
  const databases = new Map<string, string>()
  for (const db of records(plan.databases)) databases.set(String(db.name), (await deps.store.createDatabase({ accountId: account.id, name: String(db.name) })).id)
  for (const user of records(plan.dbUsers)) {
    const created = await deps.store.createDatabaseUser({ accountId: account.id, name: String(user.name), authPlugin: 'mysql_native_password', authString: services.mysqlNativePasswordHash(unknownPassword()) })
    for (const grant of records(user.grants)) {
      const privileges = grantPrivileges(Array.isArray(grant.privileges) ? grant.privileges.map(String) : [])
      if (databases.has(String(grant.database)) && privileges.length) await deps.store.setGrant({ databaseUserId: created.id, databaseId: databases.get(String(grant.database))!, privileges })
    }
  }
  const mailboxes = records(plan.mailboxes).filter(box => domains.has(String(box.address).split('@')[1] ?? ''))
  for (const box of mailboxes) await deps.store.createServiceUser({ accountId: account.id, login: String(box.address), services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: box.quotaMb as ServiceUser['mailboxQuotaMb'], ftpDir: '', passwordHash: await deps.serviceHash(unknownPassword()) })
  const nameservers = (await deps.store.getServerSettings())?.nameservers ?? []
  const zones = records(plan.dnsZones).filter(zone => domains.has(String(zone.zone)))
  for (const zone of zones) {
    const name = String(zone.zone), existing = await deps.store.getDnsZone(name)
    if (existing && existing.accountId !== account.id) precondition('the DNS zone ' + name + ' belongs to another account here')
    const kept = records(zone.records).filter(item => !(item.type === 'NS' && item.name === '@' && nameservers.length))
      .map(item => ({ id: randomUUID(), zone: name, name: String(item.name), type: item.type as DnsRecordType, ttl: Number(item.ttl), content: String(item.content), priority: item.priority === null || item.priority === undefined ? null : Number(item.priority) }))
    const ns = nameservers.map(server => ({ id: randomUUID(), zone: name, name: '@', type: 'NS' as DnsRecordType, ttl: 86_400, content: server.replace(/\.?$/, '.'), priority: null }))
    await deps.store.saveDnsZone({ id: existing?.id ?? randomUUID(), accountId: account.id, name, serial: Math.max(Number(new Date().toISOString().slice(0, 10).replaceAll('-', '')) * 100 + 1, (existing?.serial ?? 0) + 1), records: [...kept, ...ns] })
  }
  const cron = records(plan.cronJobs)
  await deps.store.saveCronJobs(account.id, cron.map(job => ({ id: randomUUID(), accountId: account.id, schedule: String(job.schedule), command: String(job.command), comment: 'Imported from cPanel; review before enabling', enabled: false })))
  await deps.applyAccount(caller, (await deps.store.getAccountByUsername(username)) ?? account)
  const certificates = records(plan.certificates).flatMap((cert, index) => {
    const names = Array.isArray(cert.names) ? cert.names.map(String) : []
    const owner = names.map(name => name.replace(/^\*\./, '')).find(name => domains.has(name))
    return cert.hasKey === true && owner && names.every(name => domains.has(name.replace(/^\*\./, ''))) ? [{ index, domain: owner }] : []
  })
  const restored = await runHostTask(deps.agent, caller, { kind: 'cpanel-restore', username, archive: record.id, sha256: record.sha256, databases: records(plan.databases).map(db => ({ sourceName: String(db.sourceName), target: String(db.name) })), certificates }, deps.pollMs ?? 3000)
  const bound = await bindCertificates(deps.store, account, restored.result.certificates)
  if (bound) await deps.applyAccount(caller, (await deps.store.getAccountByUsername(username)) ?? account)
  return { username, domains: [...domains.keys()].sort(), databases: [...databases.keys()], databaseUsers: records(plan.dbUsers).length, mailboxes: mailboxes.length, zones: zones.map(zone => String(zone.zone)),
    cronJobsPaused: cron.length, certificates: bound, home: restored.result.home ?? null, passwordResetRequired: true }
}

/** Removes only the account this import created (by id); an account that merely shares the username is never touched. */
const removeCreated = async (deps: CpanelImportDeps, caller: AuthenticatedCaller, accountId: string | null | undefined): Promise<boolean> => {
  const leftover = accountId ? await deps.store.getAccount(accountId) : null
  if (!leftover) return false
  await deps.removeAccount(caller, leftover)
  return true
}

const startTask = async (agent: TransferAgentCall, caller: AuthenticatedCaller, body: Record<string, unknown>): Promise<string> => {
  const response = await agent(caller, '/transfers/tasks', { method: 'POST', body })
  const reply = await readReply(response).catch(() => null) as { task?: { id?: unknown }; detail?: unknown } | null
  if (response.status !== 202 || typeof reply?.task?.id !== 'string') return precondition('the host refused the task' + (typeof reply?.detail === 'string' ? ': ' + reply.detail.slice(0, 200) : ''))
  return reply.task.id
}

export function createCpanelImportPorts(deps: CpanelImportDeps): CpanelImportPorts {
  return {
    uploadDir: deps.uploadDir,
    maxBytes: deps.maxBytes,
    startTask: (caller, body) => startTask(deps.agent, caller, body),
    readTask: async (caller, id) => {
      const response = await deps.agent(caller, '/transfers/tasks/' + id)
      const task = response.status === 200 ? (await readReply(response) as { task?: Record<string, unknown> } | null)?.task : null
      if (!object(task)) return precondition('the host task could not be read')
      return { state: String(task.state), result: object(task.result) ? task.result : null, error: typeof task.error === 'string' ? task.error : null }
    },
    apply: async (caller, record, input) => {
      let createdId: string | null = null
      try { return await applyPlan(deps, caller, record, input.planId, async id => { createdId = id; await input.onCreated?.(id) }) }
      catch (error) {
        let removed = false
        try { removed = await removeCreated(deps, caller, createdId) } catch { fail('PRECONDITION_FAILED', (error instanceof Error ? error.message : 'the import failed') + '; the partial account could not be removed, review it before retrying', { stateChanged: true, verificationRequired: true }) }
        await deps.audit?.(caller, removed ? 'transfer.cpanel.rolled_back' : 'transfer.cpanel.failed', 'transfer-import:' + record.id, { removed }, 'failed').catch(() => undefined)
        return fail('PRECONDITION_FAILED', (error instanceof Error ? error.message.slice(0, 300) : 'the import failed') + (removed ? '; the partial account was removed' : '; nothing was created here'), { stateChanged: false })
      }
    },
    recover: (caller, record) => removeCreated(deps, caller, record.createdAccountId),
    discard: async (caller, record) => {
      if (record.origin === 'upload') for (const suffix of ['.tar.gz', '.part']) await rm(join(deps.uploadDir, record.id + suffix), { force: true })
      else { const response = await deps.agent(caller, '/transfers/tasks/' + record.id, { method: 'DELETE' }); await response.body?.cancel().catch(() => undefined) }
    },
    sshKey: async caller => {
      const response = await deps.agent(caller, '/transfers/ssh-key')
      const reply = response.status === 200 ? await readReply(response) as Record<string, unknown> | null : null
      if (typeof reply?.publicKey !== 'string' || typeof reply.fingerprint !== 'string') return precondition('the transfer key could not be read')
      return { publicKey: reply.publicKey, fingerprint: reply.fingerprint }
    },
  }
}
