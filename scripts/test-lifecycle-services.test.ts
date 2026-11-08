import { describe, expect, it } from 'vitest'
import { controlPlaneUnitSettled, parseCgroupProcesses, parseControlPlaneUnitInventory, parseSystemctlJobs, parseSystemctlProperties, parseFileWorkerUnit, parseFileWorkerIncident, projectOwnedControlPlaneObservation, quiescentControlPlaneFailures, rejectUnknownUnits, stopAndDrainOwnedControlPlaneUnits } from './lifecycle-services.mjs'

const properties = (unit = 'xpanel-api.service') => ({
  Id: unit, LoadState: 'loaded', ActiveState: 'active', SubState: 'running',
  MainPID: '120', ControlPID: '0', ControlGroup: `/system.slice/${unit}`, KillMode: 'control-group',
  FragmentPath: `/etc/systemd/system/${unit}`, InvocationID: 'a'.repeat(32), Job: '0',
  Triggers: '', TriggeredBy: '', DropInPaths: '', NeedDaemonReload: 'no',
})
const text = (value: Record<string, string>) => Object.entries(value).map(([key, value]) => `${key}=${value}\n`).join('')

describe('lifecycle service syntax diagnostics (not Linux service qualification)', () => {
  it('preserves actual invocation, pending job and cgroup values instead of inferring inactivity', () => {
    const actual = parseSystemctlProperties(text({ ...properties(), MainPID: '0', Job: '42 /org/freedesktop/systemd1/job/42' }))
    expect(actual).toMatchObject({ MainPID: '0', Job: '42 /org/freedesktop/systemd1/job/42', ControlGroup: '/system.slice/xpanel-api.service' })
    expect(Object.isFrozen(actual)).toBe(true)
  })
  it('permits timer properties without inventing absent service process fields', () => {
    const value: Record<string, string> = properties('xpanel-management-tls.timer')
    for (const key of ['MainPID', 'ControlPID', 'ControlGroup', 'KillMode']) delete value[key]
    const actual = parseSystemctlProperties(text({ ...value, SubState: 'waiting', Triggers: 'xpanel-management-tls.service' }))
    expect(actual).not.toHaveProperty('MainPID')
    expect(actual.Triggers).toBe('xpanel-management-tls.service')
  })
  it.each([
    ['duplicate property', `${text(properties())}Id=xpanel-api.service\n`],
    ['missing property', text(Object.fromEntries(Object.entries(properties()).filter(([key]) => key !== 'ControlGroup')))],
    ['NUL', `${text(properties())}\0`],
    ['unexpected property', `${text(properties())}Environment=SECRET\n`],
    ['oversized output', 'x'.repeat(65537)],
    ['PID outside kernel integer', text({ ...properties(), MainPID: '2147483648' })],
    ['traversal cgroup', text({ ...properties(), ControlGroup: '/system.slice/../xpanel-api.service' })],
    ['invalid invocation', text({ ...properties(), InvocationID: '0' })],
    ['unread reload state', text({ ...properties(), NeedDaemonReload: '' })],
  ])('rejects %s', (_, value) => expect(() => parseSystemctlProperties(value)).toThrow())
  it('retains unknown helpers in actual unit inventory for the production refusal gate', () => {
    expect(parseControlPlaneUnitInventory('xpanel-files-20003-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service loaded active running Account worker\n'))
      .toEqual([{ unit: 'xpanel-files-20003-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', load: 'loaded', active: 'active', sub: 'running' }])
  })
  it.each(['xpanel-api.service loaded active running API\nxpanel-api.service loaded active running API\n', 'ssh.service loaded active running SSH\n', '● xpanel-api.service loaded active running API\n', 'xpanel-api.service loaded\n'])('rejects ambiguous inventory %j', value => expect(() => parseControlPlaneUnitInventory(value)).toThrow())
  it('does not accept an invented capture as an actual service observation', () => {
    expect(() => projectOwnedControlPlaneObservation(Object.freeze({ observations: [] }))).toThrow('CONTROL_PLANE_CAPTURE_REQUIRED')
  })
  it('retains actual pending jobs and accepts only an explicit empty job inventory', () => {
    expect(parseSystemctlJobs('42 xpanel-api.service stop running\n')).toEqual([{ job: '42', unit: 'xpanel-api.service', type: 'stop', state: 'running' }])
    expect(parseSystemctlJobs('')).toEqual([])
    expect(parseSystemctlJobs('No jobs running.\n')).toEqual([])
  })
  it.each(['42 xpanel-api.service stop running\n42 xpanel-agent.service start waiting\n', 'No jobs running.\n42 xpanel-api.service stop running\n', '42 xpanel-api.service stop\n', '42 xpanel-api.service stop unknown\n'])('rejects ambiguous job output %j', value => expect(() => parseSystemctlJobs(value)).toThrow())
  it('parses process identities without treating an empty parent process list as child proof', () => {
    expect(parseCgroupProcesses('22\n11\n')).toEqual([11, 22])
    expect(parseCgroupProcesses('')).toEqual([])
  })
  it.each(['0\n', '12\n12\n', '2147483648\n', ' 12\n', '12', '12\r\n'])('rejects invalid cgroup process content %j', value => expect(() => parseCgroupProcesses(value)).toThrow())
})

describe('native mutation admission', () => {
  it('does not accept a supplied receipt or callback as authority to stop services', async () => {
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) await expect(stopAndDrainOwnedControlPlaneUnits({}, {})).rejects.toThrow('LINUX_ROOT_REQUIRED')
  })
})

describe('finite file worker diagnostics, not a quiescence grant', () => {
  const name = `xpanel-files-20003-${'a'.repeat(32)}.service`
  it('binds a valid name to its canonical account slice and matching incident UID', () => {
    const worker = parseFileWorkerUnit(name)
    expect(worker).toEqual({ unit: name, uid: 20003, cgroup: `/xpanel.slice/xpanel-20003.slice/${name}` })
    expect(parseFileWorkerIncident({ version: 1, unit: name, uid: 20003, reason: 'operation started', status: 'in-flight', recordedAt: '2026-10-24T00:00:00.000Z' })).toEqual({ ...worker, status: 'in-flight' })
    expect(() => projectOwnedControlPlaneObservation(worker)).toThrow('CONTROL_PLANE_CAPTURE_REQUIRED')
  })
  it.each(['xpanel-files-999-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', 'xpanel-files-65534-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', 'xpanel-files-02003-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', 'xpanel-files-20003-AAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaa.service', 'xpanel-files-20003-aa.service', 'xpanel-files-20003-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.socket'])('rejects malformed or out-of-range unit %s', value => expect(() => parseFileWorkerUnit(value)).toThrow('FILE_WORKER_UNIT_INVALID'))
  it.each([
    { uid: 20004 }, { status: 'finished' }, { reason: '' }, { recordedAt: 'invalid' }, { extra: true }, { version: '1' },
  ])('rejects an inconsistent incident %j', patch => {
    expect(() => parseFileWorkerIncident({ version: 1, unit: name, uid: 20003, reason: 'operation started', status: 'in-flight', recordedAt: '2026-10-24T00:00:00.000Z', ...patch })).toThrow('FILE_WORKER_INCIDENT_INVALID')
  })
})

describe('control-plane unit settled before a stop', () => {
  const unit = (patch: Record<string, string>) => ({ ...properties(), ...patch })
  it.each([
    ['running', {}],
    ['inactive', { ActiveState: 'inactive', SubState: 'dead', MainPID: '0' }],
    ['failed', { ActiveState: 'failed', SubState: 'failed', MainPID: '0' }],
    ['waiting to restart after a crash', { ActiveState: 'activating', SubState: 'auto-restart', MainPID: '0' }],
  ])('accepts a %s unit', (_, patch) => { expect(controlPlaneUnitSettled(unit(patch))).toBe(true) })
  it.each([
    ['starting', { ActiveState: 'activating', SubState: 'start' }],
    ['restarting with a process', { ActiveState: 'activating', SubState: 'auto-restart', MainPID: '120' }],
    ['restarting with a control process', { ActiveState: 'activating', SubState: 'auto-restart', MainPID: '0', ControlPID: '121' }],
    ['with its restart queued', { ActiveState: 'activating', SubState: 'auto-restart-queued', MainPID: '0' }],
    ['stopping', { ActiveState: 'deactivating', SubState: 'stop-sigterm' }],
    ['reloading', { ActiveState: 'reloading', SubState: 'reload' }],
  ])('refuses a %s unit', (_, patch) => { expect(controlPlaneUnitSettled(unit(patch))).toBe(false) })
})

describe('control-plane quiescence decision', () => {
  const stopped = (unit: string, ActiveState = 'inactive', MainPID = '0') => ({ ...properties(unit), ActiveState, SubState: ActiveState === 'failed' ? 'failed' : 'dead', MainPID, ControlGroup: '' })
  const empty = { path: '/system.slice/xpanel-agent.service', exists: false, nodes: [], processes: [] as number[], populated: false }
  const observation = (agent: ReturnType<typeof stopped>, cgroup = empty) => ({ units: [stopped('xpanel-api.service'), agent, stopped('xpanel-management-tls.service'), { ...stopped('xpanel-management-tls.timer'), Id: 'xpanel-management-tls.timer' }], cgroups: [cgroup] })
  it('accepts inactive units with empty cgroups', () => {
    expect(quiescentControlPlaneFailures(observation(stopped('xpanel-agent.service')))).toEqual([])
  })
  it('accepts a failed unit whose processes are gone and names it for reporting', () => {
    expect(quiescentControlPlaneFailures(observation(stopped('xpanel-agent.service', 'failed')))).toEqual(['xpanel-agent.service'])
  })
  it('refuses a failed unit that still has a process', () => {
    expect(() => quiescentControlPlaneFailures(observation(stopped('xpanel-agent.service', 'failed'), { ...empty, exists: true, processes: [4242], populated: true }))).toThrow('CONTROL_PLANE_NOT_QUIESCENT')
    expect(() => quiescentControlPlaneFailures(observation(stopped('xpanel-agent.service', 'failed', '4242')))).toThrow('CONTROL_PLANE_NOT_QUIESCENT')
  })
  it.each(['activating', 'deactivating', 'active', 'reloading'])('refuses a %s unit', state => {
    expect(() => quiescentControlPlaneFailures(observation(stopped('xpanel-agent.service', state)))).toThrow('CONTROL_PLANE_NOT_QUIESCENT')
  })
})

describe('unit inventory gate', () => {
  const inventory = (...lines: string[]) => parseControlPlaneUnitInventory(lines.map(line => `${line} Description\n`).join(''))
  const controlPlane = ['xpanel-api.service loaded active running', 'xpanel-agent.service loaded active running', 'xpanel-management-tls.service loaded inactive dead', 'xpanel-management-tls.timer loaded active waiting']
  it('accepts the account and host units a release reconcile creates, as after the 0.1.24 to 0.1.37 upgrade', () => {
    expect(() => rejectUnknownUnits(inventory(...controlPlane,
      'xpanel-caldav-qa1.service loaded inactive dead', 'xpanel-caldav-qa1.socket loaded active listening', 'xpanel-caldav-qa2.service loaded active running', 'xpanel-caldav-qa2.socket loaded active listening',
      'xpanel.slice loaded active active', 'xpanel-20000.slice loaded active active', 'xpanel-php-fpm-qa1-8.3.service loaded active running', 'xpanel-cron-qa1-2.timer loaded active waiting',
      'xpanel-webdiskd-qa1-0123456789ab.socket loaded active listening', 'xpanel-redis-qa1.service loaded active running', 'xpanel-ctr-qa2-web.service loaded failed failed',
      'xpanel-task-a1b2c3d4e5f6.timer loaded active waiting', 'xpanel-daemon-worker.service loaded active running', 'xpanel-ftp-anonymous-auth.service loaded inactive dead',
      'xpanel-phpmyadmin-fpm.service loaded active running', 'xpanel-frps.service loaded inactive dead'))).not.toThrow()
  })
  it.each(['xpanel-metrics.service', 'xpanel-caldav-Qa1.service', 'xpanel-caldav-qa1.timer', 'xpanel-999.slice'])('refuses a loaded %s outside every registered grammar', unit => {
    expect(() => rejectUnknownUnits(inventory(...controlPlane, `${unit} loaded active running`))).toThrow('UNKNOWN_CONTROL_PLANE_UNIT_REQUIRES_INSPECTION')
    expect(() => rejectUnknownUnits(inventory(...controlPlane, `${unit} not-found inactive dead`))).not.toThrow()
  })
  it('accepts a coordinator only as the current one', () => {
    expect(() => rejectUnknownUnits(inventory(...controlPlane, 'xpanel-lifecycle.service loaded active running'), 'xpanel-lifecycle.service')).not.toThrow()
    expect(() => rejectUnknownUnits(inventory(...controlPlane, 'xpanel-lifecycle.service loaded active running'))).toThrow('UNKNOWN_CONTROL_PLANE_UNIT_REQUIRES_INSPECTION')
    expect(() => rejectUnknownUnits(inventory(...controlPlane, 'xpanel-upgrade.service loaded inactive dead'), 'xpanel-lifecycle.service')).toThrow('UNKNOWN_CONTROL_PLANE_UNIT_REQUIRES_INSPECTION')
  })
  it('reads a host with hundreds of accounts, up to 4096 units', () => {
    const accounts = Array.from({ length: 1000 }, (_, index) => `xpanel-caldav-u${index}.socket loaded active listening`)
    expect(inventory(...controlPlane, ...accounts)).toHaveLength(1004)
    expect(() => inventory(...Array.from({ length: 4097 }, (_, index) => `xpanel-${1000 + index}.slice loaded active active`))).toThrow('SERVICE_INVENTORY_INVALID')
  })
})
