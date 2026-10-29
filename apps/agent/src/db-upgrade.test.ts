import { describe, expect, it } from 'vitest'
import { buildDbUpgradeJobPlan, handleDbUpgradeRoute, isMariadbPackage, readDbUpgrade, upstreamVersion } from './db-upgrade.ts'
import type { DbUpgradeRouteDeps } from './db-upgrade.ts'
import type { DbRun } from './db-engines.ts'

const show = 'Id=mariadb.service\nNames=mariadb.service mysql.service\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n'
const inst = (name: string, from: string, to: string) => `Inst ${name} [${from}] (${to} Debian-Security:12/stable-security [amd64])`
function host(simulation: string[], holds = ''): DbRun {
  return async argv => {
    if (argv[0] === '/usr/bin/dpkg-query') return { ok: true, code: 0, stdout: 'mariadb-server\t1:10.11.6-0+deb12u1\tinstall ok installed\n', stderr: '' }
    if (argv[0] === '/usr/bin/systemctl') return { ok: true, code: 0, stdout: argv.at(-1) === 'mariadb.service' ? show : show.replace(/mariadb\.service mysql\.service|mariadb\.service/g, argv.at(-1)!).replace('loaded', 'not-found').replace('enabled', ''), stderr: '' }
    if (argv[0] === '/usr/bin/apt-mark') return { ok: true, code: 0, stdout: holds, stderr: '' }
    if (argv[0] === '/usr/bin/apt-get') return { ok: true, code: 0, stdout: simulation.join('\n') + '\n', stderr: '' }
    return { ok: false, code: 1, stdout: '', stderr: '' }
  }
}
const pending = [inst('mariadb-server', '1:10.11.6-0+deb12u1', '1:10.11.11-0+deb12u1'), inst('mariadb-client', '1:10.11.6-0+deb12u1', '1:10.11.11-0+deb12u1'), inst('openssl', '3.0.11-1', '3.0.15-1')]
const sql = (version = '10.11.6-MariaDB-0+deb12u1') => ({ version: async () => version })
const now = () => new Date('2026-10-28T10:15:00Z')

describe('MariaDB upgrade observation', () => {
  it('classifies MariaDB packages and upstream versions', () => {
    expect(['mariadb-server', 'mariadb-client-core:amd64', 'galera-4', 'libmariadb3', 'mysql-common'].every(name => isMariadbPackage('debian', name))).toBe(true)
    expect(isMariadbPackage('rhel', 'mariadb-server.x86_64')).toBe(true); expect(isMariadbPackage('debian', 'mariadbx')).toBe(false); expect(isMariadbPackage('debian', 'openssl')).toBe(false)
    expect(upstreamVersion('1:10.11.6-0+deb12u1')).toBe('10.11.6'); expect(upstreamVersion('10.11.6-MariaDB-0+deb12u1')).toBe('10.11.6'); expect(upstreamVersion(null)).toBeNull()
  })
  it('offers only pending MariaDB packages from the configured repositories', async () => {
    const observed = await readDbUpgrade({ family: 'debian', run: host(pending), sql: sql(), adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', jobs: true, now })
    expect(observed).toMatchObject({ state: 'read', reason: null, installed: { name: 'mariadb-server', version: '1:10.11.6-0+deb12u1' }, running: '10.11.6-MariaDB-0+deb12u1', unit: { unit: 'mariadb.service', active: 'active' }, blocked: [], canApply: true })
    expect(observed.packages.map(entry => entry.name)).toEqual(['mariadb-client', 'mariadb-server']); expect(observed.revision).toMatch(/^[0-9a-f]{64}$/)
  })
  it('keeps apply disabled when current, held, custom credentials, no job runner or no running server', async () => {
    expect((await readDbUpgrade({ family: 'debian', run: host([inst('openssl', '1', '2')]), sql: sql(), adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', jobs: true })).canApply).toBe(false)
    const held = await readDbUpgrade({ family: 'debian', run: host(pending, 'mariadb-server\n'), sql: sql(), adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', jobs: true })
    expect(held.blocked).toEqual(['mariadb-server']); expect(held.canApply).toBe(false)
    expect(await readDbUpgrade({ family: 'debian', run: host(pending), sql: sql(), adminDefaultsFile: '/root/custom.cnf', jobs: true })).toMatchObject({ reason: 'admin-credentials-unsupported', canApply: false })
    expect((await readDbUpgrade({ family: 'debian', run: host(pending), sql: sql(), adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', jobs: false })).canApply).toBe(false)
    expect((await readDbUpgrade({ family: 'debian', run: host(pending), sql: { version: async () => { throw new Error('down') } }, adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', jobs: true })).canApply).toBe(false)
    expect(await readDbUpgrade({ family: null, run: null, sql: null, adminDefaultsFile: null, jobs: true })).toMatchObject({ state: 'unavailable', reason: 'unsupported-host' })
  })
})

describe('MariaDB upgrade job', () => {
  it('backs up before upgrading and succeeds only when the new version runs and nothing is pending', async () => {
    const observed = await readDbUpgrade({ family: 'debian', run: host(pending), sql: sql(), adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', jobs: true, now })
    let version = '10.11.6-MariaDB-0+deb12u1'
    const plan = buildDbUpgradeJobPlan({ observed, now: now(), sql: { version: async () => version }, assertRoot: async () => undefined })
    expect(plan.steps.map(step => step.id)).toEqual(['prepare-backup', 'backup', 'upgrade-packages', 'restart', 'upgrade-tables'])
    expect(plan.steps.every(step => plan.policy(step.argv) && step.mutates)).toBe(true)
    expect(plan.steps[1]!.argv.at(-1)).toBe('--result-file=/var/backups/xpanel/mariadb-upgrade/pre-upgrade-20261028T101500Z.sql')
    expect(plan.steps[2]!.argv.slice(-2)).toEqual(['mariadb-client', 'mariadb-server'])
    const jobRun = (simulation: string[]) => async (argv: readonly string[]) => ({ ...await host(simulation)(argv), timedOut: false })
    expect((await plan.verify!(jobRun([inst('openssl', '1', '2')]))).ok).toBe(false)
    version = '10.11.11-MariaDB-0+deb12u1'
    expect((await plan.verify!(jobRun(pending))).ok).toBe(false)
    expect(await plan.verify!(jobRun([inst('openssl', '1', '2')]))).toMatchObject({ ok: true, detail: { expected: '10.11.11', pending: [] } })
    expect(() => buildDbUpgradeJobPlan({ observed: { ...observed, canApply: false }, now: now(), sql: sql(), assertRoot: async () => undefined })).toThrow()
  })
})

describe('MariaDB upgrade route', () => {
  const deps = (over: Partial<DbUpgradeRouteDeps> = {}): DbUpgradeRouteDeps & { plans: unknown[] } => {
    const plans: unknown[] = []
    return { plans, assertRoot: async () => ({ actor: 'root' }), family: 'debian', run: host(pending), sql: sql(), adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', now,
      submitJob: async (plan, actor) => { plans.push({ plan, actor }); return { id: 'job-1', kind: plan.kind } as never }, ...over }
  }
  const call = (path: string, d: DbUpgradeRouteDeps, method = 'GET', body?: unknown) => handleDbUpgradeRoute(new Request('http://agent' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://agent' + path), method, d)
  it('reads, then submits only the reviewed revision as a host job', async () => {
    const d = deps(), observed = await (await call('/host/databases/upgrade', d))!.json() as { revision: string }
    const response = await call('/host/databases/upgrade/apply', d, 'POST', { expectedRevision: observed.revision })
    expect(response!.status).toBe(202); expect(await response!.json()).toEqual({ job: { id: 'job-1', kind: 'database.mariadb.upgrade' } }); expect(d.plans).toHaveLength(1)
  })
  it('refuses stale revisions, extra fields, missing runner and changed authority', async () => {
    await expect(call('/host/databases/upgrade/apply', deps(), 'POST', { expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('/host/databases/upgrade/apply', deps(), 'POST', { expectedRevision: 'a'.repeat(64), force: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/databases/upgrade/apply', deps({ submitJob: null }), 'POST', { expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    let calls = 0
    const changing = deps({ assertRoot: async () => ({ actor: ++calls > 1 ? 'other' : 'root' }) })
    await expect(call('/host/databases/upgrade', changing)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await call('/host/databases/upgrade', deps(), 'POST'))!.status).toBe(405)
    await expect(call('/host/databases/upgrade?x=1', deps())).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
