import { describe, expect, it, vi } from 'vitest'
import { assertServiceManagerTarget, buildServiceManagerPlan, parseServiceManagerBootTime, parseServiceManagerLists, parseServiceManagerTarget, readServiceManager, serviceManagerInstallSafe } from './service-manager.ts'
import type { HostJobRun } from './host-job-contract.ts'

const output = (stdout: string, ok = true) => ({ ok, code: ok ? 0 : 1, stdout, stderr: '' })
const show = (unit = 'memcached.service', boot = 'disabled', names = unit, active = 'active') => `Id=${unit}\nNames=${names}\nLoadState=loaded\nActiveState=${active}\nSubState=running\nUnitFileState=${boot}\n`
const cat = '[Unit]\nDescription=Cache\n[Service]\nExecStart=/usr/bin/memcached\n[Install]\nWantedBy=multi-user.target\n'
const list = 'memcached.service loaded active running Cache\nssh.service loaded active running SSH\nphp8.4-fpm.service loaded active running PHP\n'
const files = 'memcached.service disabled enabled\nssh.service enabled enabled\nphp8.4-fpm.service enabled enabled\n'
const run = vi.fn(async (argv: readonly string[]) => output(argv.includes('show') ? show(String(argv.at(-1))) : argv.includes('cat') ? cat : argv.includes('list-unit-files') ? files : list))

describe('service inventory', () => {
  it('joins documented lists and marks only reviewed controls', () => {
    const rows = parseServiceManagerLists(list, files)
    expect(rows.find(row => row.unit === 'memcached.service')).toMatchObject({ bootEditable: true, restart: false })
    expect(rows.find(row => row.unit === 'ssh.service')).toMatchObject({ restart: true, bootEditable: false })
    expect(parseServiceManagerLists('systemd-fsck@dev-disk-by\\x2duuid.service loaded active exited Check\n', 'other@.service static -\n')).toHaveLength(2)
  })
  it.each([['broken\n', files], [list, 'bad.service fabricated enabled'], [list + list, files], ['', ''], [list, files + files], ['a.service loaded active running\u0000', files]])('refuses malformed or partial output', (units, unitFiles) => expect(() => parseServiceManagerLists(units, unitFiles)).toThrow())
  it('reads boot time strictly and never fabricates an available inventory', async () => {
    expect(parseServiceManagerBootTime('cpu 1 2\nbtime 1793000000\n')).toBe(1793000000)
    for (const value of [null, '', 'btime NaN\n', 'btime 1\nbtime 2\n']) expect(parseServiceManagerBootTime(value)).toBeNull()
    const view = await readServiceManager({ run, readFile: async () => 'btime 1793000000\n', manage: true })
    expect(view).toMatchObject({ state: 'read', manage: true, bootTime: 1793000000 }); expect(view.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(await readServiceManager({ run: async () => output('broken'), readFile: async () => null })).toMatchObject({ state: 'unavailable', units: [], revision: null, manage: false })
  })
  it('checks canonical unit identity and complete properties', () => {
    expect(parseServiceManagerTarget(show(), 'memcached.service').boot).toBe('disabled')
    for (const value of [show().replace('Id=memcached', 'Id=other'), show() + 'Id=memcached.service\n', show().replace('Names=memcached.service', 'Names=bad/path')]) expect(() => parseServiceManagerTarget(value, 'memcached.service')).toThrow()
  })
})
describe('isolated boot changes and jobs', () => {
  it.each(['Also=ssh.service', '  Also = ssh.service', 'Alias=', 'Also=other.service\nAlso=', 'Also=foo \\\n# note\n ssh.service', 'WantedBy=multi-user.target \\', 'WantedBy=graphical.target'])('rejects related install effects %s', value => expect(serviceManagerInstallSafe('[Install]\n' + value + '\n')).toBe(false))
  it('accepts a simple reviewed boot target and refuses protected/aliased/related targets', async () => {
    expect(serviceManagerInstallSafe(cat)).toBe(true)
    await expect(assertServiceManagerTarget(run, 'enable', 'memcached.service')).resolves.toMatchObject({ unit: 'memcached.service' })
    for (const [unit, text] of [['ssh.service', show('ssh.service')], ['memcached.service', show('memcached.service', 'disabled', 'memcached.service xpanel-api.service')]]) {
      await expect(assertServiceManagerTarget(async argv => output(argv.includes('show') ? text! : cat), 'disable', unit!)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    await expect(assertServiceManagerTarget(async argv => output(argv.includes('show') ? show() : cat + 'Also=ssh.service\n'), 'enable', 'memcached.service')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('requires config test first, then fresh authorization before restart, and verifies active readback', async () => {
    const fresh = vi.fn(async () => {}), plan = buildServiceManagerPlan({ action: 'restart', unit: 'ssh.service', expectedRevision: 'a'.repeat(64), bootTime: 1, run, assertFresh: fresh })
    expect(plan.steps.map(step => step.argv)).toEqual([['/usr/sbin/sshd', '-t'], ['/usr/bin/systemctl', 'restart', '--', 'ssh.service']])
    expect(plan.steps.map(step => step.mutates)).toEqual([false, true])
    await plan.beforeStep(plan.steps[1]!); expect(fresh).toHaveBeenCalledOnce()
    expect(plan.policy(['/usr/bin/systemctl', 'restart', '--', 'sshd.service'])).toBe(false)
    const verify = (active: string) => plan.verify!(async () => ({ ...output(show('ssh.service', 'enabled', 'ssh.service', active)), timedOut: false }))
    expect((await verify('active')).ok).toBe(true); expect((await verify('failed')).ok).toBe(false)
  })
  it('rechecks boot state and authority after a queued wait', async () => {
    const fresh = vi.fn(async () => { throw new Error('revoked') }), plan = buildServiceManagerPlan({ action: 'enable', unit: 'memcached.service', expectedRevision: 'a'.repeat(64), bootTime: 1, run, assertFresh: fresh })
    await expect(plan.beforeStep(plan.steps[0]!)).rejects.toThrow('revoked')
    const changed = buildServiceManagerPlan({ action: 'enable', unit: 'memcached.service', expectedRevision: 'a'.repeat(64), bootTime: 1, run: async argv => output(argv.includes('show') ? show('memcached.service', 'enabled') : cat), assertFresh: async () => {} })
    await expect(changed.beforeStep(changed.steps[0]!)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await plan.verify!(async () => ({ ...output(show('memcached.service', 'enabled')), timedOut: false }))).ok).toBe(true)
  })
  it('rechecks authority before a queued configuration probe and after that probe before restart', async () => {
    const events: string[] = []
    let revoked = true
    const fresh = async () => { events.push('auth'); if (revoked) throw new Error('revoked') }
    const observed = async (argv: readonly string[]) => { events.push('show'); return output(show(String(argv.at(-1)))) }
    const plan = buildServiceManagerPlan({ action: 'restart', unit: 'ssh.service', expectedRevision: 'a'.repeat(64), bootTime: 1, run: observed, assertFresh: fresh })
    const execute = async (index: number) => { const step = plan.steps[index]!; await plan.beforeStep(step); events.push(step.id) }
    await expect(execute(0)).rejects.toThrow('revoked')
    expect(events).toEqual(['auth'])
    revoked = false; events.length = 0
    await execute(0)
    revoked = true
    await expect(execute(1)).rejects.toThrow('revoked')
    expect(events).toEqual(['auth', 'config-test', 'show', 'auth'])
    expect(events).not.toContain('restart')
  })
  it('checks authority again after install-link observation before a boot mutation', async () => {
    let revoked = false
    const events: string[] = []
    const plan = buildServiceManagerPlan({ action: 'enable', unit: 'memcached.service', expectedRevision: 'a'.repeat(64), bootTime: 1,
      run: async argv => { const inspecting = argv.includes('cat'); events.push(inspecting ? 'cat' : 'show'); if (inspecting) revoked = true; return output(inspecting ? cat : show()) },
      assertFresh: async () => { events.push('auth'); if (revoked) throw new Error('revoked') },
    })
    await expect(plan.beforeStep(plan.steps[0]!)).rejects.toThrow('revoked')
    expect(events).toEqual(['show', 'cat', 'auth'])
  })
  it('requires exact selected-unit boot readback and never treats command success as proof', async () => {
    const plan = buildServiceManagerPlan({ action: 'enable', unit: 'memcached.service', expectedRevision: 'a'.repeat(64), bootTime: 1, run, assertFresh: async () => {} })
    const verify = (stdout: string, ok = true) => plan.verify!(async argv => { expect(argv).toEqual(['/usr/bin/systemctl', 'show', '--no-pager', '--property=Id,Names,LoadState,ActiveState,SubState,UnitFileState', '--', 'memcached.service']); return { ...output(stdout, ok), timedOut: false } })
    expect(await verify(show('memcached.service', 'disabled'))).toMatchObject({ ok: false, detail: { verificationRequired: true } })
    expect(await verify(show('rsyslog.service', 'enabled'))).toMatchObject({ ok: false, detail: { verificationRequired: true } })
    expect(await verify(show('memcached.service', 'enabled'), false)).toMatchObject({ ok: false, detail: { verificationRequired: true } })
    expect(await verify(show('memcached.service', 'enabled'))).toMatchObject({ ok: true, detail: { unit: 'memcached.service', boot: 'enabled', verificationRequired: false } })
  })
  it('never represents reboot enqueue as a verified reboot', async () => {
    const plan = buildServiceManagerPlan({ action: 'reboot', expectedRevision: 'a'.repeat(64), bootTime: 123, run, assertFresh: async () => {} })
    expect(plan.steps[0]!.argv).toEqual(['/usr/bin/systemctl', 'reboot'])
    expect(await plan.verify!(vi.fn() as HostJobRun)).toEqual({ ok: false, detail: { outcome: 'attempted', verificationRequired: true, bootTimeBefore: 123 } })
  })
})
