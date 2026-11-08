import { describe, expect, it } from 'vitest'
import { defaultFrp, defaultHostDaemons, defaultHostScheduler, validateFrp, validateHostDaemon, validateHostScript, validateHostTask, validateHostTrigger } from '@xpanel/core'
import { hostTaskSchedule, renderFrp, renderHostDaemons, renderHostTasks } from './host-tools.ts'

const task = (over: Record<string, unknown> = {}) => validateHostTask({ id: 'aaaaaaaaaaa1', name: 'Nightly', type: 'command', cycle: 'daily', hour: 3, minute: 5, command: '/usr/bin/true', enabled: true, ...over })
const input = { program: '#!/usr/bin/node\n', family: 'debian', domains: new Map([['example.com', '/home/a/public_html']]) }
const spec = (files: { path: string; content: string }[], id: string) => JSON.parse(files.find(file => file.path === `/etc/xpanel/tasks/${id}.json`)!.content) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('host task units', { tags: ['unit'] }, () => {
  it('turns each cycle into timer lines in UTC', () => {
    const line = (over: Record<string, unknown>) => hostTaskSchedule(task(over))
    expect(line({ cycle: 'manual' })).toEqual([])
    expect(line({ cycle: 'seconds', every: 30 })).toEqual(['OnActiveSec=30s', 'OnUnitActiveSec=30s'])
    expect(line({ cycle: 'minutes', every: 5 })).toEqual(['OnCalendar=*-*-* *:00/5:00 UTC'])
    expect(line({ cycle: 'hourly', minute: 7 })).toEqual(['OnCalendar=*-*-* *:07:00 UTC'])
    expect(line({ cycle: 'hours', every: 6, minute: 0 })).toEqual(['OnCalendar=*-*-* 00/6:00:00 UTC'])
    expect(line({ cycle: 'daily', hour: 3, minute: 5 })).toEqual(['OnCalendar=*-*-* 03:05:00 UTC'])
    expect(line({ cycle: 'days', every: 2, hour: 3, minute: 5 })).toEqual(['OnCalendar=*-*-01/2 03:05:00 UTC'])
    expect(line({ cycle: 'weekly', weekday: 1, hour: 3, minute: 5 })).toEqual(['OnCalendar=Mon *-*-* 03:05:00 UTC'])
    expect(line({ cycle: 'monthly', day: 9, hour: 3, minute: 5 })).toEqual(['OnCalendar=*-*-09 03:05:00 UTC'])
  })
  it('renders nothing while the scheduler is empty', () => {
    expect(renderHostTasks(defaultHostScheduler(), input)).toEqual({ files: [], preActions: [], postActions: [] })
  })
  it('renders a oneshot, a timer and a root-only spec with an argv', () => {
    const { files, preActions, postActions } = renderHostTasks({ ...defaultHostScheduler(), tasks: [task({ command: '/usr/bin/php\n-r\necho $x;' })] }, input)
    expect(files.map(file => file.path)).toEqual(['/usr/local/sbin/xpanel-host-task', '/etc/xpanel/tasks/aaaaaaaaaaa1.json', '/etc/systemd/system/xpanel-task-aaaaaaaaaaa1.service', '/etc/systemd/system/xpanel-task-aaaaaaaaaaa1.timer'])
    expect(spec(files, 'aaaaaaaaaaa1').steps).toEqual([{ argv: ['/usr/bin/php', '-r', 'echo $x;'] }])
    expect(files[1]!.mode).toBe(0o600)
    expect(files.find(file => file.path.endsWith('.service'))!.content).toContain('ExecStart=/usr/local/sbin/xpanel-host-task aaaaaaaaaaa1\n')
    expect(preActions).toEqual([{ kind: 'ensure-dir', path: '/etc/xpanel/tasks', mode: 0o700, owner: 'root', group: 'root' }])
    expect(postActions).toEqual([{ kind: 'systemd-daemon-reload' }, { kind: 'systemd', verb: 'enable', unit: 'xpanel-task-aaaaaaaaaaa1.timer' }, { kind: 'systemd', verb: 'start', unit: 'xpanel-task-aaaaaaaaaaa1.timer' }])
  })
  it('stops the timer of a disabled task and gives a manual task no timer', () => {
    expect(renderHostTasks({ ...defaultHostScheduler(), tasks: [task({ enabled: false })] }, input).postActions.slice(1)).toEqual([{ kind: 'systemd', verb: 'stop', unit: 'xpanel-task-aaaaaaaaaaa1.timer' }, { kind: 'systemd', verb: 'disable', unit: 'xpanel-task-aaaaaaaaaaa1.timer' }])
    expect(renderHostTasks({ ...defaultHostScheduler(), tasks: [task({ cycle: 'manual' })] }, input).files.some(file => file.path.endsWith('.timer'))).toBe(false)
  })
  it('stamps backups, carries retention and exclusions, and refuses a site that left', () => {
    const backup = task({ type: 'site-backup', cycle: 'daily', target: 'example.com', keep: 3, exclude: 'cache\n*.log' })
    const saved = spec(renderHostTasks({ ...defaultHostScheduler(), tasks: [backup] }, input).files, backup.id)
    expect(saved).toMatchObject({ stamped: true, retention: { dir: '/var/lib/xpanel/task-backups/aaaaaaaaaaa1', keep: 3 }, refuse: null })
    expect(saved.steps[0].argv).toEqual(['/usr/bin/tar', '--create', '--zstd', '--file=/var/lib/xpanel/task-backups/aaaaaaaaaaa1/{stamp}.tar.zst', '--exclude=cache', '--exclude=*.log', '--directory=/home/a/public_html', '--', '.'])
    expect(spec(renderHostTasks({ ...defaultHostScheduler(), tasks: [backup] }, { ...input, domains: new Map() }).files, backup.id)).toMatchObject({ refuse: 'site_not_found', steps: [] })
  })
  it('picks the time sync of the family', () => {
    const sync = task({ type: 'time-sync' })
    expect(spec(renderHostTasks({ ...defaultHostScheduler(), tasks: [sync] }, { ...input, family: 'rhel' }).files, sync.id).steps[0].argv[0]).toBe('/usr/bin/chronyc')
    expect(spec(renderHostTasks({ ...defaultHostScheduler(), tasks: [sync] }, input).files, sync.id).steps[0].argv).toContain('systemd-timesyncd.service')
  })
  it('installs scripts root-only and hands triggers to the watched task', () => {
    const script = validateHostScript({ id: 'bbbbbbbbbbb1', name: 'Count', language: 'python', returns: 'integer', args: '--all', content: 'print(1)' })
    const watched = task({ id: 'aaaaaaaaaaa1', type: 'script', scriptId: script.id, chained: true }), target = task({ id: 'aaaaaaaaaaa2' })
    const trigger = validateHostTrigger({ id: 'ccccccccccc1', name: 'Stopped', taskId: watched.id, match: 'include', value: 'stopped', targetId: target.id })
    const { files } = renderHostTasks({ ...defaultHostScheduler(), tasks: [watched, target], scripts: [script], triggers: [trigger] }, input)
    expect(files.find(file => file.path.endsWith('bbbbbbbbbbb1.script'))).toMatchObject({ content: 'print(1)\n', mode: 0o700 })
    const saved = spec(files, watched.id)
    expect(saved.steps[0].argv).toEqual(['/usr/bin/python3', '/etc/xpanel/tasks/bbbbbbbbbbb1.script', '--all'])
    expect(saved.returns).toBe('integer')
    expect(saved.triggers).toEqual([{ id: 'ccccccccccc1', name: 'Stopped', match: 'include', value: 'stopped', target: 'xpanel-task-aaaaaaaaaaa2.service' }])
  })
})

describe('daemons and frp', { tags: ['unit'] }, () => {
  it('renders a daemon with its restart policy and shared limits', () => {
    const daemon = validateHostDaemon({ id: 'aaaaaaaaaaa1', name: 'worker', command: '/usr/bin/php\nrun me', user: 'alice', directory: '/home/alice/app', restart: 'always', enabled: true })
    const { files, postActions } = renderHostDaemons({ ...defaultHostDaemons(), daemons: [daemon] }, new Map([['alice', 2001]]))
    expect(files[0]!.path).toBe('/etc/systemd/system/xpanel-daemon-worker.service')
    expect(files[0]!.content).toContain('Restart=always\nRestartSec=3')
    expect(files[0]!.content).toContain('StartLimitBurst=5')
    expect(files[0]!.content).toContain('User=alice\nSlice=xpanel-2001.slice')
    expect(files[0]!.content).toContain('ExecStart="/usr/bin/php" "run me"')
    expect(postActions.at(-1)).toEqual({ kind: 'systemd', verb: 'start', unit: 'xpanel-daemon-worker.service' })
  })
  it('drops the unit of a daemon whose account left, without failing the generation', () => {
    const daemon = validateHostDaemon({ id: 'aaaaaaaaaaa1', name: 'worker', command: '/usr/bin/true', user: 'alice', directory: '', restart: 'always', enabled: true })
    expect(renderHostDaemons({ ...defaultHostDaemons(), daemons: [daemon] }, new Map()).files).toEqual([])
  })
  it('keeps a saved name out of the unit, where a percent sign would expand', () => {
    const { files } = renderHostTasks({ ...defaultHostScheduler(), tasks: [task({ name: '100% done' })] }, input)
    expect(files.filter(file => file.path.includes('/systemd/')).map(file => file.content).join()).not.toContain('100%')
  })
  it('renders no frp at all while both sides are off', () => {
    expect(renderFrp(defaultFrp())).toEqual({ files: [], preActions: [], postActions: [] })
  })
  it('keeps the frp token in a root-only file loaded as a credential', () => {
    const base = defaultFrp(), state = validateFrp({ ...base, server: { ...base.server, enabled: true, token: 'x'.repeat(32) }, client: { ...base.client, enabled: true, serverAddr: 'frp.example.net', token: 'y'.repeat(32), proxies: [{ id: 'aaaaaaaaaaa1', name: 'web', localPort: 8080, remotePort: 7101 }] } })
    const { files, postActions } = renderFrp(state), server = files.find(file => file.path.endsWith('frps.toml'))!, client = files.find(file => file.path.endsWith('frpc.toml'))!
    expect(server).toMatchObject({ mode: 0o600 })
    expect(server.content).toContain('allowPorts = [{ start = 7100, end = 7199 }]')
    expect(client.content).toContain('remotePort = 7101')
    const unit = files.find(file => file.path.endsWith('xpanel-frps.service'))!.content
    expect(unit).toContain('DynamicUser=yes')
    expect(unit).toContain('ExecStart=/usr/local/bin/frps -c %d/frp.toml')
    expect(unit).toContain('LoadCredential=frp.toml:/etc/xpanel/frp/frps.toml')
    expect(unit).not.toContain(state.server.token)
    expect(postActions[0]).toEqual({ kind: 'systemd-daemon-reload' })
  })
})
