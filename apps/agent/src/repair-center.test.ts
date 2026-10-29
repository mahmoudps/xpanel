import { describe, expect, it, vi } from 'vitest'
import {
  APT_CHECK_ARGV, APT_FIX_BROKEN_ARGV, APT_FIX_BROKEN_NO_REMOVE_ARGV, APT_FIX_PREVIEW_ARGV, DNF_CHECK_ARGV, DPKG_AUDIT_ARGV, DPKG_CONFIGURE_PENDING_ARGV, RPMDB_VERIFY_ARGV, DNF_CACHE_CHECK_ARGV, DNF_CACHE_CLEAN_ARGV, DNF_CACHE_REFRESH_ARGV,
} from '../../../packages/os/src/repair-command.ts'
import {
  boundedEvidence, buildRepairJobPlan, parseAptCheck, parseAptSimulation, parseDnfCheck, parseDnfCache, parseDpkgAudit, previewRepair, removalFingerprint, runRepairDiagnostics,
} from './repair-center.ts'
import type { RepairCommandResult, RepairRun } from './repair-center.ts'
import { RPM_INSTALLED_IDENTITY_ARGV, RPMDB_REBUILD_ARGV } from '../../../packages/os/src/ops-package-recovery-command.ts'
import { sourceMessage } from '@xpanel/core'
import { translator } from '../../web/src/i18n.ts'

const out = (stdout: string, code = 0, stderr = ''): RepairCommandResult => ({ ok: code === 0, code, stdout, stderr })
const head = 'Reading package lists...\nBuilding dependency tree...\nReading state information...\n'
const fixtures = {
  dpkgHealthy: out(''),
  dpkgInterrupted: out('The following packages are only half configured, probably due to problems\nconfiguring them the first time.  The configuration should be retried using\ndpkg --configure <package> or the configure menu option in dselect:\n nginx-common         small, powerful, scalable web/proxy server - common files\n nginx                small, powerful, scalable web/proxy server\n\n', 1),
  dpkgUnpacked: out('The following packages have been unpacked but not yet configured.\nThey must be configured using dpkg --configure or the configure\nmenu option in dselect for them to work:\n php8.3-fpm:amd64     server-side, HTML-embedded scripting language (FPM-CGI binary)\n\n'),
  dpkgReinstall: out('The following packages are in a mess due to serious problems during\ninstallation.  They must be reinstalled for them (and any packages\nthat depend on them) to function properly:\n libfoo1              foo library\n\n'),
  dpkgLocked: out('Another process has locked the database for writing, and might currently be\nmodifying it, some of the following problems might just be due to that.\n\nThe following packages have been unpacked but not yet configured.\nThey must be configured using dpkg --configure or the configure\nmenu option in dselect for them to work:\n nginx                web server\n\n'),
  aptHealthy: out(head),
  aptBroken: out(head + "You might want to run 'apt-get -f install' to correct these.\nThe following packages have unmet dependencies:\n php8.3-fpm : Depends: php8.3-common (= 8.3.12-1) but 8.3.11-1 is installed\n              Depends: libpcre2-8-0 (>= 10.42) but it is not going to be installed\n", 100, 'E: Unmet dependencies. Try using -f.\n'),
  aptBlocked: out('', 100, "E: dpkg was interrupted, you must manually run 'dpkg --configure -a' to correct the problem.\n"),
  aptLocked: out('', 100, 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 4242 (apt-get)\n'),
  simulateNoRemovals: out(head + 'Correcting dependencies... Done\nThe following packages will be upgraded:\n  libpcre2-8-0\n1 upgraded, 0 newly installed, 0 to remove and 12 not upgraded.\nInst libpcre2-8-0 [10.40-1] (10.42-1 Debian:12.5/stable [amd64])\nConf libpcre2-8-0 (10.42-1 Debian:12.5/stable [amd64])\n'),
  simulateRemovals: out(head + 'Correcting dependencies... Done\nThe following packages will be REMOVED:\n  php8.3-fpm\nThe following NEW packages will be installed:\n  php8.3-common\n0 upgraded, 1 newly installed, 1 to remove and 0 not upgraded.\nRemv php8.3-fpm [8.3.11-1]\nInst php8.3-common (8.3.12-1 Debian:12.5/stable [amd64])\nConf php8.3-common (8.3.12-1 Debian:12.5/stable [amd64])\n'),
  simulateUnresolvable: out(head + 'Correcting dependencies... failed.\n', 100, 'E: Unable to correct problems, you have held broken packages.\n'),
  dnfHealthy: out(''),
  dnfProblems: out('php-fpm-8.1.27-1.el9.x86_64 has missing requires of php-common(x86-64) = 8.1.27-1.el9\nnginx-1:1.20.1-14.el9.x86_64 is a duplicate with nginx-1:1.20.1-16.el9.x86_64\n', 1, 'Error: Check discovered 2 problem(s)\n'),
}

const runner = (table: Record<string, RepairCommandResult | Error>): RepairRun & { calls: string[] } => {
  const calls: string[] = []
  const run = async (argv: readonly string[]): Promise<RepairCommandResult> => {
    calls.push(argv.join(' '))
    const result = table[argv.join(' ')]
    if (!result) throw new Error('unexpected command ' + argv.join(' '))
    if (result instanceof Error) throw result
    return result
  }
  return Object.assign(run, { calls })
}
const key = (argv: readonly string[]): string => argv.join(' ')

describe('package diagnostic parsers', () => {
  it('reads dpkg --audit: clean, configurable, reinstall-only, locked and malformed', () => {
    expect(parseDpkgAudit(fixtures.dpkgHealthy)).toEqual({ state: 'ok' })
    expect(parseDpkgAudit(fixtures.dpkgInterrupted)).toEqual({ state: 'problem', detail: { packages: ['nginx', 'nginx-common'], configurable: ['nginx', 'nginx-common'], reinstallOnly: false } })
    expect(parseDpkgAudit(fixtures.dpkgUnpacked)).toMatchObject({ state: 'problem', detail: { packages: ['php8.3-fpm:amd64'], reinstallOnly: false } })
    expect(parseDpkgAudit(fixtures.dpkgReinstall)).toMatchObject({ state: 'problem', detail: { packages: ['libfoo1'], configurable: [], reinstallOnly: true } })
    expect(parseDpkgAudit(fixtures.dpkgLocked)).toEqual({ state: 'unavailable', reason: 'locked' })
    expect(parseDpkgAudit(out('unexpected text without packages\n'))).toEqual({ state: 'unavailable', reason: 'malformed' })
    expect(parseDpkgAudit(out('The following packages are odd:\n\t<script>\n'))).toEqual({ state: 'unavailable', reason: 'malformed' })
    expect(parseDpkgAudit(out('', 0, 'dpkg: warning: parsing file near line 4\n'))).toEqual({ state: 'unavailable', reason: 'command-failed' })
    expect(parseDpkgAudit(out('', 2, 'dpkg: error: unable to access the dpkg database'))).toEqual({ state: 'unavailable', reason: 'command-failed' })
    expect(parseDpkgAudit({ ...fixtures.dpkgHealthy, timedOut: true })).toEqual({ state: 'unavailable', reason: 'command-failed' })
  })

  it('treats a localized dpkg explanation as configurable rather than reinstall-only', () => {
    expect(parseDpkgAudit(out('Die folgenden Pakete sind nur halb konfiguriert:\n nginx                Webserver\n\n'))).toMatchObject({ state: 'problem', detail: { configurable: ['nginx'], reinstallOnly: false } })
  })

  it('reads apt-get check: clean, unmet dependencies, blocked by dpkg, locked and unknown failures', () => {
    expect(parseAptCheck(fixtures.aptHealthy)).toEqual({ state: 'ok' })
    expect(parseAptCheck(fixtures.aptBroken)).toEqual({ state: 'problem', detail: { packages: ['php8.3-fpm'] } })
    expect(parseAptCheck(fixtures.aptBlocked)).toEqual({ state: 'unavailable', reason: 'blocked-by-dpkg' })
    expect(parseAptCheck(fixtures.aptLocked)).toEqual({ state: 'unavailable', reason: 'locked' })
    expect(parseAptCheck(out('', 100, 'E: The package cache file is corrupted\n'))).toEqual({ state: 'unavailable', reason: 'command-failed' })
    expect(parseAptCheck(out(head, 0, 'E: contradictory\n'))).toEqual({ state: 'unavailable', reason: 'malformed' })
    expect(parseAptCheck(out(head, 1))).toEqual({ state: 'unavailable', reason: 'command-failed' })
  })

  it('reads the apt -f install simulation with removals counted and cross-checked', () => {
    expect(parseAptSimulation(fixtures.simulateNoRemovals)).toEqual({ state: 'ready', plan: { install: ['libpcre2-8-0'], remove: [], configure: ['libpcre2-8-0'] } })
    expect(parseAptSimulation(fixtures.simulateRemovals)).toEqual({ state: 'ready', plan: { install: ['php8.3-common'], remove: ['php8.3-fpm'], configure: ['php8.3-common'] } })
    expect(parseAptSimulation(out(fixtures.simulateRemovals.stdout.replace('1 to remove', '0 to remove')))).toEqual({ state: 'unavailable', reason: 'malformed' })
    expect(parseAptSimulation(out(head + 'Inst <img src=x>\n'))).toEqual({ state: 'unavailable', reason: 'malformed' })
    expect(parseAptSimulation(out(head + 'Purg php8.3-fpm [8.3.11-1]\n'))).toEqual({ state: 'ready', plan: { install: [], remove: ['php8.3-fpm'], configure: [] } })
    expect(parseAptSimulation(fixtures.simulateUnresolvable)).toEqual({ state: 'unavailable', reason: 'unresolvable' })
    expect(parseAptSimulation(fixtures.aptBlocked)).toEqual({ state: 'unavailable', reason: 'blocked-by-dpkg' })
  })

  it('reads dnf check: clean, problems, contradictory and malformed output', () => {
    expect(parseDnfCheck(fixtures.dnfHealthy)).toEqual({ state: 'ok' })
    expect(parseDnfCheck(fixtures.dnfProblems)).toEqual({ state: 'problem', detail: { packages: ['nginx-1:1.20.1-14.el9.x86_64', 'php-fpm-8.1.27-1.el9.x86_64'] } })
    expect(parseDnfCheck(out('something\n', 0))).toEqual({ state: 'unavailable', reason: 'malformed' })
    expect(parseDnfCheck(out('garbled\n', 1))).toEqual({ state: 'unavailable', reason: 'malformed' })
    expect(parseDnfCheck(out('', 1, 'Error: Check discovered 3 problem(s)\n'))).toEqual({ state: 'problem', detail: { packages: [] } })
    expect(parseDnfCheck(out('', 3, 'Error: rpmdb open failed\n'))).toEqual({ state: 'unavailable', reason: 'command-failed' })
  })

  it('bounds and sanitizes evidence', () => {
    const evidence = boundedEvidence(['\u001b[31mred\u001b[0m\u202e\u0000line', 'x'.repeat(20000)])
    expect(evidence.startsWith('redline')).toBe(true)
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(8192)
    expect(evidence.endsWith('[truncated]')).toBe(true)
    expect(boundedEvidence(['é'.repeat(5000)]).includes('\ufffd')).toBe(false)
  })
})

describe('repair diagnostics report', () => {
  const debianTable = () => ({ [key(DPKG_AUDIT_ARGV)]: fixtures.dpkgInterrupted, [key(APT_CHECK_ARGV)]: fixtures.aptBlocked })
  const now = () => new Date('2026-10-27T10:00:00.000Z')

  it('reports Debian package, service configuration and drift diagnostics truthfully', async () => {
    const run = runner(debianTable())
    const report = await runRepairDiagnostics({
      family: 'debian', run, now,
      configTests: [{ name: 'nginx', argv: ['/usr/sbin/nginx', '-t'] }, { name: 'apache', argv: ['/usr/sbin/apachectl', 'configtest'] }, { name: 'sshd', argv: ['/usr/sbin/sshd', '-t'] }, { name: 'Bad Name', argv: ['/x'] }],
      runTest: async test => test.name === 'nginx' ? out('syntax ok') : test.name === 'apache' ? out('', 1, 'AH00526: Syntax error on line 4') : out('', 1, 'spawn /usr/sbin/sshd ENOENT'),
      drift: async () => ({ hasDrift: true, manifestMissing: false, generationId: 7, items: [{ path: '/etc/nginx/nginx.conf', reason: 'content_mismatch' }] }),
    })
    expect(run.calls).toEqual([key(DPKG_AUDIT_ARGV), key(APT_CHECK_ARGV)])
    expect(report.observedAt).toBe('2026-10-27T10:00:00.000Z')
    expect(report.diagnostics.map(d => [d.id, d.state, d.repair.id, d.repair.kind, d.repair.available])).toEqual([
      ['dpkg-interrupted', 'problem', 'dpkg-configure', 'job', true],
      ['apt-broken-dependencies', 'unavailable', 'apt-fix-broken', 'job', false],
      ['service-config:nginx', 'ok', 'configuration-generations', 'existing-workflow', false],
      ['service-config:apache', 'problem', 'configuration-generations', 'existing-workflow', true],
      ['service-config:sshd', 'unavailable', 'configuration-generations', 'existing-workflow', false],
      ['configuration-drift', 'problem', 'configuration-generations', 'existing-workflow', true],
    ])
    expect(report.diagnostics[1]!.repair.reason).toBe('blocked_by_dpkg')
    expect(report.diagnostics[3]!.repair.href).toBe('/whm/services/web')
    expect(report.diagnostics[3]!.evidence).toContain('AH00526')
    expect(report.diagnostics[5]!.evidence).toContain('content_mismatch /etc/nginx/nginx.conf')
    // Every cause is a catalog message whose Arabic translation exists and uses ASCII digits.
    for (const diagnostic of report.diagnostics) { const arabic = translator('ar')(diagnostic.cause); expect(diagnostic.cause).toBeTruthy(); expect(arabic).not.toBe(sourceMessage(diagnostic.cause)); expect(/[\u0660-\u0669\u06f0-\u06f9]/.test(arabic)).toBe(false) }
  })

  it('never reports ok when a command throws or no reader is connected', async () => {
    const report = await runRepairDiagnostics({ family: 'debian', run: runner({ [key(DPKG_AUDIT_ARGV)]: new Error('spawn failed'), [key(APT_CHECK_ARGV)]: new Error('spawn failed') }), now })
    expect(report.diagnostics.map(d => d.state)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(report.diagnostics[2]!.id).toBe('configuration-drift')
    const rhel = await runRepairDiagnostics({ family: 'rhel', run: runner({ [key(DNF_CHECK_ARGV)]: fixtures.dnfProblems, [key(RPMDB_VERIFY_ARGV)]: out(''), [key(DNF_CACHE_CHECK_ARGV)]: out('') }), now, drift: async () => ({ hasDrift: false, manifestMissing: false, generationId: null, items: [] }) })
    expect(rhel.diagnostics.map(d => [d.id, d.state, d.repair.available, d.repair.reason])).toEqual([['rpm-database-integrity', 'ok', false, 'no_problem'], ['dnf-package-problems', 'problem', false, 'rhel_repair_not_reviewed'], ['dnf-metadata-cache', 'ok', false, 'no_problem'], ['configuration-drift', 'unavailable', false, 'diagnostic_unavailable']])
    await expect(runRepairDiagnostics({ family: 'arch' as never, run: runner({}) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('keeps a stable revision across observation time and changes it with host state', async () => {
    const first = await runRepairDiagnostics({ family: 'debian', run: runner(debianTable()), now })
    const again = await runRepairDiagnostics({ family: 'debian', run: runner(debianTable()), now: () => new Date('2026-10-27T11:00:00.000Z') })
    const changed = await runRepairDiagnostics({ family: 'debian', run: runner({ ...debianTable(), [key(DPKG_AUDIT_ARGV)]: fixtures.dpkgHealthy }), now })
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(again.revision).toBe(first.revision)
    expect(changed.revision).not.toBe(first.revision)
  })
})

describe('bounded RHEL metadata repair', () => {
  const missing = out('', 1, "Error: Cache-only enabled but no cache for 'baseos'\n"), revision = 'a'.repeat(64)
  const table = { [key(RPMDB_VERIFY_ARGV)]: out(''), [key(DNF_CHECK_ARGV)]: out(''), [key(DNF_CACHE_CHECK_ARGV)]: missing }
  const recovery = (restored = true) => {
    const snapshot = { observedRevision: revision, snapshotRevision: 'b'.repeat(64), assertLeaseAndPackagesUnchanged: vi.fn(async () => {}), restoreAndVerify: vi.fn(async () => restored), release: vi.fn(async () => {}) }
    const begin = vi.fn(async (input: { expectedRevision: string; currentRevision(): Promise<string> }) => { expect(await input.currentRevision()).toBe(input.expectedRevision); return snapshot })
    const authorize = vi.fn(async () => {})
    return { snapshot, begin, authorize, plan: () => buildRepairJobPlan({ repairId: 'dnf-cache-refresh', family: 'rhel', observedRevision: revision, cacheRecovery: { begin }, currentRevision: async () => revision, authorize }) }
  }
  it('classifies only a known missing cache and keeps unknown or locked observations unavailable', () => {
    expect(parseDnfCache(out(''))).toEqual({ state: 'ok' }); expect(parseDnfCache(missing).state).toBe('problem')
    for (const result of [out('', 200, 'locked'), out('unrecognized', 1), { ...out(''), timedOut: true }, out('', 0, 'warning')]) expect(parseDnfCache(result).state).toBe('unavailable')
  })
  it('disables metadata mutation without recovery and refuses it when RPM integrity is unverified', async () => {
    const unavailable = await runRepairDiagnostics({ family: 'rhel', run: runner(table) })
    expect(unavailable.diagnostics.find(item => item.id === 'dnf-metadata-cache')?.repair).toMatchObject({ available: false, reason: 'cache_recovery_unavailable' })
    const available = await runRepairDiagnostics({ family: 'rhel', run: runner(table), cacheRecoveryAvailable: true })
    expect(available.diagnostics.find(item => item.id === 'dnf-metadata-cache')?.repair.available).toBe(true)
    const corrupt = await runRepairDiagnostics({ family: 'rhel', run: runner({ ...table, [key(RPMDB_VERIFY_ARGV)]: out('', 1, 'database disk image is malformed') }), cacheRecoveryAvailable: true })
    expect(corrupt.diagnostics.find(item => item.id === 'dnf-metadata-cache')?.repair).toMatchObject({ available: false, reason: 'rpm_recovery_unavailable' })
    expect(await previewRepair({ repairId: 'dnf-cache-refresh', family: 'rhel', run: runner(table), cacheRecoveryAvailable: true })).toMatchObject({ state: 'ready', source: 'dnf-cache-only', counts: { install: 0, remove: 0, configure: 0 } })
    expect(() => buildRepairJobPlan({ repairId: 'dnf-cache-refresh', family: 'rhel', observedRevision: revision })).toThrow()
  })
  it('snapshots before commands, rechecks authority per step and verifies metadata without package changes', async () => {
    const t = recovery(), plan = t.plan()
    expect(plan.steps.map(step => step.argv)).toEqual([[...DNF_CACHE_CLEAN_ARGV], [...DNF_CACHE_REFRESH_ARGV]])
    expect(plan.policy(['/usr/bin/rpmdb', '--rebuilddb'])).toBe(false)
    await plan.beforeStep!(plan.steps[0]!); await plan.beforeStep!(plan.steps[1]!)
    expect(t.begin).toHaveBeenCalledTimes(1); expect(t.authorize).toHaveBeenCalledTimes(4)
    const result = { ...out(''), timedOut: false }
    expect(await plan.verify!(async () => result)).toMatchObject({ ok: true, detail: { installedPackagesChanged: false } })
    expect(await plan.finalize!(async () => result, plan.steps.map(step => ({ id: step.id, result })))).toMatchObject({ ok: true, detail: { cacheRecovery: 'not_required' } })
    expect(t.snapshot.restoreAndVerify).not.toHaveBeenCalled(); expect(t.snapshot.release).toHaveBeenCalledTimes(1)
  })
  it('restores a partial or interrupted job once and retains recovery when restoration cannot be verified', async () => {
    for (const restored of [true, false]) {
      const t = recovery(restored), plan = t.plan(); await plan.beforeStep!(plan.steps[0]!)
      expect(await plan.finalize!(async () => ({ ...out(''), timedOut: false }), [{ id: plan.steps[0]!.id, result: null }])).toMatchObject({ ok: restored, detail: { cacheRecovery: restored ? 'restored' : 'recovery_required' } })
      expect(t.snapshot.restoreAndVerify).toHaveBeenCalledTimes(1); expect(t.snapshot.release).toHaveBeenCalledTimes(restored ? 1 : 0)
    }
  })
  it('runs no mutating command after lost authority or an unverified snapshot', async () => {
    const t = recovery(); t.authorize.mockRejectedValue(new Error('root revoked'))
    await expect(t.plan().beforeStep!({ id: 'dnf-cache-clean', argv: DNF_CACHE_CLEAN_ARGV, title: 'Metadata', timeoutMs: 1, mutates: true })).rejects.toThrow('root revoked')
    expect(t.begin).not.toHaveBeenCalled()
    t.authorize.mockResolvedValue(undefined); t.snapshot.observedRevision = 'c'.repeat(64)
    await expect(t.plan().beforeStep!({ id: 'dnf-cache-clean', argv: DNF_CACHE_CLEAN_ARGV, title: 'Metadata', timeoutMs: 1, mutates: true })).rejects.toThrow()
  })
})

describe('repair preview and job plans', () => {
  it('previews the apt simulation and the dpkg configuration list', async () => {
    const apt = await previewRepair({ repairId: 'apt-fix-broken', family: 'debian', run: runner({ [key(APT_FIX_PREVIEW_ARGV)]: fixtures.simulateRemovals }) })
    expect(apt).toMatchObject({ state: 'ready', source: 'apt-simulation', remove: ['php8.3-fpm'], counts: { install: 1, remove: 1, configure: 1 }, removalFingerprint: removalFingerprint(['php8.3-fpm']) })
    const dpkg = await previewRepair({ repairId: 'dpkg-configure', family: 'debian', run: runner({ [key(DPKG_AUDIT_ARGV)]: fixtures.dpkgInterrupted }) })
    expect(dpkg).toMatchObject({ state: 'ready', source: 'dpkg-audit', configure: ['nginx', 'nginx-common'], counts: { install: 0, remove: 0, configure: 2 } })
    expect(await previewRepair({ repairId: 'dpkg-configure', family: 'debian', run: runner({ [key(DPKG_AUDIT_ARGV)]: fixtures.dpkgReinstall }) })).toMatchObject({ state: 'unavailable', reason: 'reinstall_required' })
    expect(await previewRepair({ repairId: 'apt-fix-broken', family: 'debian', run: runner({ [key(APT_FIX_PREVIEW_ARGV)]: fixtures.simulateUnresolvable }) })).toMatchObject({ state: 'unavailable', reason: 'unresolvable', remove: [] })
    expect(await previewRepair({ repairId: 'apt-fix-broken', family: 'rhel', run: runner({}) })).toMatchObject({ state: 'unavailable', reason: 'repair_unavailable_for_family' })
    await expect(previewRepair({ repairId: 'dnf-repair' as never, family: 'debian', run: runner({}) })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('fingerprints removal lists independent of order and duplicates', () => {
    expect(removalFingerprint(['b', 'a', 'a'])).toBe(removalFingerprint(['a', 'b']))
    expect(removalFingerprint(['a'])).not.toBe(removalFingerprint(['a', 'b']))
    expect(removalFingerprint([])).toMatch(/^[0-9a-f]{64}$/)
  })

  const revision = 'a'.repeat(64)
  it('builds a reviewed dpkg configuration job verified by the re-run audit', async () => {
    const plan = buildRepairJobPlan({ repairId: 'dpkg-configure', family: 'debian', observedRevision: revision })
    expect(plan).toMatchObject({ kind: 'system.repair.dpkg-configure', accountId: null, fingerprint: { repairId: 'dpkg-configure', observedRevision: revision, removalsAccepted: false } })
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]).toMatchObject({ id: 'dpkg-configure', argv: [...DPKG_CONFIGURE_PENDING_ARGV], env: { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l' }, mutates: true })
    expect(plan.steps.every(step => plan.policy(step.argv))).toBe(true)
    expect(plan.policy(['/usr/bin/apt-get', 'install', 'nginx'])).toBe(false)
    expect(plan.summary.length).toBeLessThanOrEqual(512)
    expect(/^[a-z][a-z0-9_.:-]{0,127}$/.test(plan.kind)).toBe(true)
    const fixed = await plan.verify!(async () => ({ ...fixtures.dpkgHealthy, timedOut: false }))
    expect(fixed).toMatchObject({ ok: true, detail: { diagnostic: 'dpkg-interrupted', state: 'ok' } })
    const still = await plan.verify!(async () => ({ ...fixtures.dpkgInterrupted, timedOut: false }))
    expect(still).toMatchObject({ ok: false, detail: { state: 'problem' } })
    const unknown = await plan.verify!(async () => { throw new Error('host lost') })
    expect(unknown).toMatchObject({ ok: false, detail: { state: 'unavailable' } })
  })

  it('refuses removals unless the exact previewed list was accepted', async () => {
    const safe = buildRepairJobPlan({ repairId: 'apt-fix-broken', family: 'debian', observedRevision: revision })
    expect(safe.steps[0]!.argv).toEqual([...APT_FIX_BROKEN_NO_REMOVE_ARGV])
    const accepted = buildRepairJobPlan({ repairId: 'apt-fix-broken', family: 'debian', observedRevision: revision, acceptedRemovals: { fingerprint: removalFingerprint(['php8.3-fpm']), packages: ['php8.3-fpm'] } })
    expect(accepted.steps[0]!.argv).toEqual([...APT_FIX_BROKEN_ARGV])
    expect(accepted.detail).toMatchObject({ removals: ['php8.3-fpm'], removalCount: 1 })
    expect(accepted.fingerprint).toMatchObject({ removalsAccepted: true, removalFingerprint: removalFingerprint(['php8.3-fpm']) })
    expect(() => buildRepairJobPlan({ repairId: 'apt-fix-broken', family: 'debian', observedRevision: revision, acceptedRemovals: { fingerprint: removalFingerprint(['other']), packages: ['php8.3-fpm'] } })).toThrow()
    expect(() => buildRepairJobPlan({ repairId: 'apt-fix-broken', family: 'debian', observedRevision: revision, acceptedRemovals: { fingerprint: removalFingerprint([]), packages: [] } })).toThrow()
    expect(() => buildRepairJobPlan({ repairId: 'dpkg-configure', family: 'debian', observedRevision: revision, acceptedRemovals: { fingerprint: removalFingerprint(['x']), packages: ['x'] } })).toThrow()
    expect(() => buildRepairJobPlan({ repairId: 'apt-fix-broken', family: 'rhel', observedRevision: revision })).toThrow()
    expect(() => buildRepairJobPlan({ repairId: 'apt-fix-broken', family: 'debian', observedRevision: 'stale' })).toThrow()
    const verified = await accepted.verify!(async () => ({ ...fixtures.aptHealthy, timedOut: false }))
    expect(verified.ok).toBe(true)
    expect((await accepted.verify!(async () => ({ ...fixtures.aptBroken, timedOut: false }))).ok).toBe(false)
  })
})

describe('snapshot-bound RPM database rebuild', () => {
  const corrupt = out('', 1, 'error: rpmdb: database disk image is malformed'), revision = 'a'.repeat(64)
  const table = { [key(RPMDB_VERIFY_ARGV)]: corrupt, [key(DNF_CHECK_ARGV)]: out(''), [key(DNF_CACHE_CHECK_ARGV)]: out(''), [key(RPM_INSTALLED_IDENTITY_ARGV)]: out('bash-5.1.8-9.el9.x86_64\nnginx-1:1.20.1-16.el9.x86_64\n') }
  const recovery = (restored = true, identical = true) => {
    const snapshot = { observedRevision: revision, snapshotRevision: 'b'.repeat(64), assertLeaseAndPackagesUnchanged: vi.fn(async () => { if (!identical) throw new Error('changed') }), restoreAndVerify: vi.fn(async () => restored), release: vi.fn(async () => {}) }
    const begin = vi.fn(async (input: { expectedRevision: string; currentRevision(): Promise<string> }) => { expect(await input.currentRevision()).toBe(input.expectedRevision); return snapshot })
    const authorize = vi.fn(async () => {})
    return { snapshot, begin, authorize, plan: () => buildRepairJobPlan({ repairId: 'rpmdb-rebuild', family: 'rhel', observedRevision: revision, rpmRecovery: { begin }, currentRevision: async () => revision, authorize }) }
  }
  it('offers the rebuild only with a recovery provider and a readable installed package list', async () => {
    const find = async (input: Parameters<typeof runRepairDiagnostics>[0]) => (await runRepairDiagnostics(input)).diagnostics.find(item => item.id === 'rpm-database-integrity')!
    expect((await find({ family: 'rhel', run: runner(table) })).repair).toMatchObject({ id: 'rpmdb-rebuild', available: false, reason: 'rpm_recovery_unavailable' })
    expect((await find({ family: 'rhel', run: runner(table), rpmRecoveryAvailable: true })).repair).toEqual({ id: 'rpmdb-rebuild', kind: 'job', available: true })
    expect((await find({ family: 'rhel', run: runner({ ...table, [key(RPM_INSTALLED_IDENTITY_ARGV)]: out('', 1, 'error: cannot open Packages index') }), rpmRecoveryAvailable: true })).repair).toMatchObject({ available: false, reason: 'rpm_headers_unreadable' })
    expect((await find({ family: 'rhel', run: runner({ ...table, [key(RPMDB_VERIFY_ARGV)]: out('') }), rpmRecoveryAvailable: true })).repair).toMatchObject({ available: false, reason: 'no_problem' })
    expect(await previewRepair({ repairId: 'rpmdb-rebuild', family: 'rhel', run: runner(table), rpmRecoveryAvailable: true })).toMatchObject({ state: 'ready', source: 'rpm-database', counts: { install: 0, remove: 0, configure: 0 } })
    expect(await previewRepair({ repairId: 'rpmdb-rebuild', family: 'debian', run: runner({}) })).toMatchObject({ state: 'unavailable', reason: 'repair_unavailable_for_family' })
    expect(() => buildRepairJobPlan({ repairId: 'rpmdb-rebuild', family: 'rhel', observedRevision: revision })).toThrow()
    expect(() => buildRepairJobPlan({ repairId: 'rpmdb-rebuild', family: 'debian', observedRevision: revision, rpmRecovery: { begin: vi.fn() }, currentRevision: async () => revision, authorize: async () => {} })).toThrow()
  })
  it('snapshots first, admits only the reviewed rebuild and releases only after identical packages are proven', async () => {
    const t = recovery(), plan = t.plan()
    expect(plan.steps.map(step => step.argv)).toEqual([[...RPMDB_REBUILD_ARGV]])
    expect(plan.policy([...RPMDB_REBUILD_ARGV])).toBe(true); expect(plan.policy(['/usr/bin/rpm', '--rebuilddb'])).toBe(false)
    await plan.beforeStep!(plan.steps[0]!)
    expect(t.begin).toHaveBeenCalledTimes(1); expect(t.authorize).toHaveBeenCalledTimes(2)
    const result = { ...out(''), timedOut: false }
    expect(await plan.verify!(async () => result)).toMatchObject({ ok: true, detail: { installedPackagesChanged: false } })
    expect(await plan.finalize!(async () => result, [{ id: 'rpmdb-rebuild', result }])).toMatchObject({ ok: true, detail: { rpmRecovery: 'not_required' } })
    expect(t.snapshot.restoreAndVerify).not.toHaveBeenCalled(); expect(t.snapshot.release).toHaveBeenCalledTimes(1)
  })
  it('restores the database preimage when the identity changed or the step failed', async () => {
    for (const [restored, identical] of [[true, false], [false, false], [true, true]] as const) {
      const t = recovery(restored, identical), plan = t.plan(), result = { ...out(''), timedOut: false }
      t.snapshot.assertLeaseAndPackagesUnchanged.mockResolvedValueOnce(undefined)
      await plan.beforeStep!(plan.steps[0]!)
      const verified = await plan.verify!(async () => result)
      expect(verified.ok).toBe(identical)
      const settled = await plan.finalize!(async () => result, [{ id: 'rpmdb-rebuild', result: identical ? null : result }])
      expect(settled).toMatchObject({ ok: restored, detail: { rpmRecovery: restored ? 'restored' : 'recovery_required' } })
      expect(t.snapshot.release).toHaveBeenCalledTimes(restored ? 1 : 0)
    }
  })
})
