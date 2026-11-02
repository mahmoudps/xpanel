import { constants } from 'node:fs'
import { lstat, open, realpath, statfs } from 'node:fs/promises'
import { posix } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { fail, type Account, type RenderedFile } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { services, system } from '@xpanel/render'
import { assertProvisioningReply, canonicalProvisioningIdentity, parseProvisioningReconcileRequest, type AccountExecutionObservation } from '../../../packages/core/src/account-provisioning-contract.ts'
import type { AccountProvisioningObservationProvider } from './account-provisioning-runtime.ts'
import type { AgentExecutor } from './executor.ts'
import type { HostEffectAuthority } from './host-effect-authority.ts'
import { createRuntimeHost, readUnitStates } from './account-runtime.ts'
import type { DnsReconcileProvider } from './services/dns-native.ts'
import { DEFAULT_DNS_ZONE_DIR, DEFAULT_NAMED_ZONES_CONF, extractSoaSerial } from './services/dns.ts'
import { observeUserQuota, validateQuotaFilesystem } from './services/quota.ts'

type AvailableInput = Parameters<AccountProvisioningObservationProvider['assertAvailable']>[0]
type ObservationInput = Parameters<AccountProvisioningObservationProvider['observe']>[0]
type ProcName = 'stat' | 'status' | 'cgroup'
interface ProcessFiles { read(name: ProcName): Promise<string>; assertCurrent(): Promise<void>; close(): Promise<void> }
interface HomeHandle { assertCurrent(): Promise<void>; close(): Promise<void> }

/**
 * The missing HTTP producer must be supplied only by trusted startup composition.
 * It must bind THIS HTTP request to THIS live worker, not trust a PHP-returned PID,
 * a URI match in FPM status, or a configuration echo. No producer is implemented here.
 */
export interface HeldProvisioningHttpRequest {
  readonly requestBinding: string
  readonly challenge: string
  readonly status: number
  readonly pid: number
  assertCurrent(): Promise<void>
  close(): Promise<void>
}
export interface ReadonlyAccountObservationOptions {
  readonly executor: AgentExecutor
  readonly store: Pick<StateStore, 'listDomains'>
  readonly dns: Pick<DnsReconcileProvider, 'verify'>
  readonly assertHttpAvailable?: AccountProvisioningObservationProvider['assertAvailable']
  readonly openCorrelatedHttpRequest?: (input: AvailableInput & { readonly challenge: string }, context: HostEffectAuthority) => Promise<HeldProvisioningHttpRequest>
  /** Raw-file seams are trusted in-process test hooks, never RPC fields or proof objects. */
  readonly openProcessFiles?: (pid: number) => Promise<ProcessFiles>
  readonly openHome?: (account: Account) => Promise<HomeHandle>
  readonly now?: () => number
}

const observationFailed: (reason: string) => never = (reason) => fail('PRECONDITION_FAILED', 'account observation did not verify', { verificationRequired: true, reason })
const positive = (value: string | undefined): number => {
  if (value === undefined || !/^[0-9]+$/.test(value)) return observationFailed('invalid_process_identity')
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) return observationFailed('invalid_process_identity')
  return n
}
const canonicalPath = (value: string): boolean =>
  value.startsWith('/') && posix.normalize(value) === value && !value.includes('\\') && !/[\u0000-\u0020\u007f]/.test(value)

export interface ProvisioningProcessIdentity {
  readonly pid: number
  readonly parentPid: number
  readonly startTime: string
  readonly state: string
  readonly uids: readonly number[]
  readonly gids: readonly number[]
  readonly cgroup: string
}

/** Kernel formats only. The process name may contain spaces or parentheses. */
export function parseProvisioningProcessFiles(pid: number, raw: Readonly<Record<ProcName, string>>): ProvisioningProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2147483647) return observationFailed('invalid_process_pid')
  if (Object.values(raw).some(text => text.length > 65536 || text.includes('\0'))) return observationFailed('invalid_process_files')
  const start = raw.stat.indexOf('('), end = raw.stat.lastIndexOf(') ')
  if (start < 1 || end < start || raw.stat.slice(0, start).trim() !== String(pid)) return observationFailed('invalid_process_stat')
  const fields = raw.stat.slice(end + 2).trim().split(/\s+/)
  const state = fields[0], startTime = fields[19]
  if (state === undefined || !/^[RSDTtWXxZKPI]$/.test(state) || startTime === undefined || !/^[0-9]+$/.test(startTime)
    || BigInt(startTime) < 1n || BigInt(startTime) > 18446744073709551615n) return observationFailed('invalid_process_stat')
  const ids = (name: 'Uid' | 'Gid'): number[] => {
    const lines = raw.status.split('\n').filter(line => line.startsWith(name + ':'))
    if (lines.length !== 1) return observationFailed('ambiguous_process_credentials')
    const line = lines[0]
    if (line === undefined) return observationFailed('invalid_process_credentials')
    const values = line.slice(4).trim().split(/\s+/)
    if (values.length !== 4) return observationFailed('invalid_process_credentials')
    return values.map(positive)
  }
  const groups = raw.cgroup.split('\n').filter(line => line !== '')
  const line = groups[0]
  if (groups.length !== 1 || line === undefined || !line.startsWith('0::') || !canonicalPath(line.slice(3))) return observationFailed('unified_process_cgroup_required')
  return { pid, parentPid: positive(fields[1]), startTime, state, uids: ids('Uid'), gids: ids('Gid'), cgroup: line.slice(3) }
}

export function assertProvisioningProcessBinding(identity: ProvisioningProcessIdentity, account: Account, unit: string, mainPid: number): void {
  const expected = '/xpanel.slice/' + system.accountSliceName(account.uid) + '/' + unit
  if (identity.pid === mainPid || identity.parentPid !== mainPid || ['Z', 'X', 'x'].includes(identity.state)
    || identity.uids.length !== 4 || identity.uids.some(uid => uid !== account.uid)
    || identity.gids.length !== 4 || identity.gids.some(gid => gid !== account.gid)
    || identity.cgroup !== expected) observationFailed('process_does_not_match_account_unit')
}

const processBindingIdentity = (value: ProvisioningProcessIdentity) => ({
  pid: value.pid, parentPid: value.parentPid, startTime: value.startTime, uids: value.uids, gids: value.gids, cgroup: value.cgroup,
})

const requireNativeRoot = (): void => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) observationFailed('native_root_process_reader_required')
}

/** One --property flag per field: the generic argv rule admits no comma-separated list. */
export const unitIdentityShowArgv = (unit: string): string[] => ['/usr/bin/systemctl', 'show', '--no-pager',
  ...['Id', 'User', 'Group', 'MainPID', 'ControlGroup', 'ActiveState'].map(name => '--property=' + name), '--', unit]

/** Pin the proc directory: a later PID reuse cannot turn this handle into another task. */
export async function openNativeProvisioningProcess(pid: number): Promise<ProcessFiles> {
  requireNativeRoot()
  positive(String(pid))
  if ((await statfs('/proc')).type !== 0x9fa0) return observationFailed('procfs_required')
  const name = '/proc/' + pid
  const dir = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const original = await dir.stat().catch(async error => { await dir.close(); throw error })
  const assertCurrent = async (): Promise<void> => {
    const [held, named] = await Promise.all([dir.stat(), lstat(name)])
    if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink()
      || held.dev !== original.dev || held.ino !== original.ino || named.dev !== original.dev || named.ino !== original.ino) {
      observationFailed('process_directory_changed')
    }
  }
  try {
    await assertCurrent()
    return {
      async read(part) {
        await assertCurrent()
        const handle = await open('/proc/self/fd/' + dir.fd + '/' + part, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const chunks: Buffer[] = []; let size = 0
          for (;;) {
            const buffer = Buffer.alloc(4096), read = await handle.read(buffer, 0, buffer.length, null)
            if (!read.bytesRead) break
            size += read.bytesRead
            if (size > 65536) return observationFailed('process_file_too_large')
            chunks.push(buffer.subarray(0, read.bytesRead))
          }
          await assertCurrent()
          return Buffer.concat(chunks).toString('utf8')
        } finally { await handle.close() }
      },
      assertCurrent,
      close: () => dir.close(),
    }
  } catch (error) { await dir.close(); throw error }
}

export async function openNativeProvisioningHome(account: Account): Promise<HomeHandle> {
  requireNativeRoot()
  if (!canonicalPath(account.home)) return observationFailed('invalid_account_home')
  const handle = await open(account.home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const initial = await handle.stat().catch(async error => { await handle.close(); throw error })
  const assertCurrent = async (): Promise<void> => {
    const [held, named, resolved] = await Promise.all([handle.stat(), lstat(account.home), realpath(account.home)])
    if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || resolved !== account.home
      || held.dev !== initial.dev || held.ino !== initial.ino || named.dev !== initial.dev || named.ino !== initial.ino
      || held.uid !== account.uid || held.gid !== account.gid || named.uid !== account.uid || named.gid !== account.gid
      || (held.mode & 0o7777) !== 0o750 || (named.mode & 0o7777) !== 0o750) observationFailed('account_home_changed')
  }
  try { await assertCurrent(); return { assertCurrent, close: () => handle.close() } }
  catch (error) { await handle.close(); throw error }
}

/**
 * Read-only composition of existing observations. The runtime still owns native
 * executor admission, active generation/drift checks and the credential/lease fence.
 * Main intentionally does not instantiate this until its HTTP producer is approved.
 */
export function createReadonlyAccountProvisioningObserver(options: ReadonlyAccountObservationOptions): AccountProvisioningObservationProvider {
  const now = options.now ?? (() => performance.now())
  const producer = () => {
    const available = options.assertHttpAvailable, openHttp = options.openCorrelatedHttpRequest
    if (typeof available !== 'function' || typeof openHttp !== 'function') return fail('SERVICE_UNAVAILABLE',
      'trusted account HTTP correlation is unavailable', { stateChanged: false, reason: 'account_http_correlation_unavailable' })
    return { available, openHttp }
  }
  const operation = (context: HostEffectAuthority) => {
    const end = now() + 15000
    const guard = async (): Promise<void> => {
      if (context.readOnly !== true || context.signal.aborted || now() >= end) observationFailed('observation_authority_or_deadline')
      await context.assertAuthority()
      if (context.signal.aborted || now() >= end) observationFailed('observation_authority_or_deadline')
    }
    const checked = async <T>(work: () => Promise<T>): Promise<T> => { await guard(); const value = await work(); await guard(); return value }
    return { guard, checked }
  }
  const bound = (input: AvailableInput): void => {
    const { authority } = parseProvisioningReconcileRequest(input.request)
    const actual = input.account
    let normalized: string
    try { normalized = services.normalizeZone(actual.primaryDomain) } catch { return observationFailed('invalid_account_domain') }
    if (normalized !== actual.primaryDomain) return observationFailed('invalid_account_domain')
    if (canonicalProvisioningIdentity(authority.account) !== canonicalProvisioningIdentity({
      id: actual.id, username: actual.username, ownerId: actual.ownerId, planId: actual.planId,
      uid: actual.uid, gid: actual.gid, home: actual.home, primaryDomain: actual.primaryDomain,
    })) observationFailed('account_binding_changed')
  }
  const primary = async (input: AvailableInput) => {
    const matches = (await options.store.listDomains({ accountId: input.account.id })).filter(domain =>
      domain.accountId === input.account.id && domain.name === input.account.primaryDomain && domain.kind === 'primary')
    const domain = matches[0]
    if (matches.length !== 1 || !domain || domain.php?.handler !== 'fpm') return observationFailed('observed_primary_fpm_domain_required')
    return domain
  }
  return {
    async assertAvailable(input, context) {
      const http = producer(), { checked } = operation(context)
      bound(input)
      await checked(() => primary(input))
      await checked(() => http.available(input, context))
    },
    async observe(input: ObservationInput, context) {
      const http = producer(), { checked, guard } = operation(context)
      bound(input)
      const domain = await checked(() => primary(input)), unit = system.fpmUnitName(input.account.username, domain.php.version)
      await checked(() => http.available(input, context))
      const generation = input.reconciliation.generation
      if (!generation || !['applied', 'noop'].includes(input.reconciliation.status) || generation.status !== 'active'
        || input.manifest.generationId !== generation.id || input.manifest.filesChecksum !== generation.checksum
        || input.manifest.stateChecksum !== input.request.authority.desired.checksum || !input.manifest.managedUnits.includes(unit)) {
        return observationFailed('generation_manifest_changed')
      }
      const run = (argv: string[]) => checked(() => options.executor.runCommand(argv))
      const readUnit = async (): Promise<number> => {
        const states = await checked(() => readUnitStates(createRuntimeHost(options.executor), [unit]))
        if (states.get(unit)?.load !== 'loaded' || states.get(unit)?.active !== 'active') return observationFailed('account_service_inactive')
        const result = await run(unitIdentityShowArgv(unit))
        const fields = new Map<string, string>()
        for (const line of result.stdout.trim().split('\n')) {
          const index = line.indexOf('=')
          if (index < 1 || fields.has(line.slice(0, index))) return observationFailed('ambiguous_account_unit')
          fields.set(line.slice(0, index), line.slice(index + 1))
        }
        if (!result.ok || result.code !== 0 || result.stderr.trim() || fields.size !== 6 || fields.get('Id') !== unit
          || fields.get('User') !== input.account.username || fields.get('Group') !== input.account.username
          || fields.get('ActiveState') !== 'active'
          || fields.get('ControlGroup') !== '/xpanel.slice/' + system.accountSliceName(input.account.uid) + '/' + unit) {
          return observationFailed('account_unit_identity_changed')
        }
        return positive(fields.get('MainPID'))
      }
      const mainPid = await readUnit()
      const mount = await run(['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', input.account.home])
      if (!mount.ok || mount.code !== 0 || mount.stderr.trim() || /[\r\n]/.test(mount.stdout.trim())) return observationFailed('account_mount_unavailable')
      const filesystem = validateQuotaFilesystem(mount.stdout.trim())
      const quota = await checked(() => observeUserQuota(run, filesystem))
      if (quota.status !== 'enabled') return observationFailed('account_quota_not_enforced')
      const zonePath = DEFAULT_DNS_ZONE_DIR + '/' + input.account.primaryDomain + '.zone'
      const files: RenderedFile[] = []
      for (const path of [zonePath, DEFAULT_NAMED_ZONES_CONF]) {
        const matches = input.manifest.files.filter(file => file.path === path), entry = matches[0]
        if (matches.length !== 1 || !entry) return observationFailed('account_dns_manifest_missing')
        const content = await checked(() => options.executor.readFile(path))
        if (content === null || Buffer.byteLength(content) !== entry.sizeBytes
          || createHash('sha256').update(content).digest('hex') !== entry.sha256) return observationFailed('account_dns_file_changed')
        files.push({ path, content, mode: entry.mode, owner: entry.owner, group: entry.group })
      }
      const zone = files.find(file => file.path === zonePath)
      if (!zone) return observationFailed('account_dns_manifest_missing')
      const parsed = services.parseBindZone(zone.content, { origin: input.account.primaryDomain })
      if (parsed.skipped.length) return observationFailed('account_dns_unparsed_records')
      const serial = extractSoaSerial(services.validateZone(parsed.records, { requireSoa: true }))
      if (serial < 1) return observationFailed('account_dns_serial_unavailable')
      // One account's zone against the whole active catalog, not the complete generation.
      await checked(() => options.dns.verify(files, [], 'zones'))
      let home: HomeHandle | undefined, response: HeldProvisioningHttpRequest | undefined, processFiles: ProcessFiles | undefined
      let value: AccountExecutionObservation | undefined, rejected = false, failure: unknown
      // Capture ownership before the post-acquisition guard can reject.
      const acquire = async <T>(work: () => Promise<T>, own: (value: T) => void): Promise<T> => {
        await guard()
        const acquired = await work()
        own(acquired)
        await guard()
        return acquired
      }
      try {
        const heldHome = await acquire(() => (options.openHome ?? openNativeProvisioningHome)(input.account), acquired => { home = acquired })
        await checked(() => heldHome.assertCurrent())
        const challenge = randomBytes(32).toString('hex')
        const heldResponse = await acquire(() => http.openHttp({ account: input.account, request: input.request, challenge }, context), acquired => { response = acquired })
        if (heldResponse.status !== 200 || heldResponse.challenge !== challenge || heldResponse.requestBinding !== input.request.binding
          || !Number.isSafeInteger(heldResponse.pid) || heldResponse.pid < 2 || typeof heldResponse.assertCurrent !== 'function' || typeof heldResponse.close !== 'function') {
          observationFailed('http_request_correlation_failed')
        }
        await checked(() => heldResponse.assertCurrent())
        const heldProcess = await acquire(() => (options.openProcessFiles ?? openNativeProvisioningProcess)(heldResponse.pid), acquired => { processFiles = acquired })
        const snapshot = async () => {
          const stat = await checked(() => heldProcess.read('stat')), status = await checked(() => heldProcess.read('status')),
            cgroup = await checked(() => heldProcess.read('cgroup'))
          await checked(() => heldProcess.assertCurrent())
          return parseProvisioningProcessFiles(heldResponse.pid, { stat, status, cgroup })
        }
        const before = await snapshot()
        assertProvisioningProcessBinding(before, input.account, unit, mainPid)
        if (await readUnit() !== mainPid) observationFailed('fpm_master_changed')
        await checked(() => heldHome.assertCurrent())
        const after = await snapshot()
        assertProvisioningProcessBinding(after, input.account, unit, mainPid)
        if (canonicalProvisioningIdentity(processBindingIdentity(before)) !== canonicalProvisioningIdentity(processBindingIdentity(after))) observationFailed('process_identity_changed')
        await checked(() => heldResponse.assertCurrent())
        const uid = after.uids[0], gid = after.gids[0]
        if (uid === undefined || gid === undefined) observationFailed('process_credentials_missing')
        value = { accountId: input.account.id, uid, gid, home: input.account.home,
          revision: input.request.authority.desired.revision, generationId: generation.id, generationChecksum: generation.checksum,
          sourceChecksum: input.request.authority.desired.checksum, cgroup: after.cgroup, services: [unit],
          quota: { enforced: true, filesystem: quota.filesystem }, dns: { zone: input.account.primaryDomain, serial, authoritative: true },
          php: { status: 200, uid, cgroup: after.cgroup } }
        const accepted = assertProvisioningReply(input.request, { binding: input.request.binding, outcome: 'known', reconciliation: input.reconciliation, execution: value })
        if (!accepted) observationFailed('execution_receipt_missing')
        await guard()
      } catch (error) { rejected = true; failure = error }
      const closed = await Promise.allSettled([
        () => processFiles?.close(), () => response?.close(), () => home?.close(),
      ].map(close => Promise.resolve().then(close)))
      if (rejected) throw failure
      if (closed.some(result => result.status === 'rejected')) observationFailed('observation_handle_release_failed')
      await guard()
      if (!value) return observationFailed('execution_receipt_missing')
      return value
    },
  }
}
