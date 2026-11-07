import { describe, expect, it } from 'vitest'
import { defaultFrp, defaultHostScheduler, hostCommandArgv, publicFrp, publicHostHook, validateDdnsRecord, validateFrp, validateHostDaemon, validateHostScheduler, validateHostScript, validateHostTask, validateHostTrigger, validateHostWatchdog, validateHostsEntry, validateRamDisk } from './index.ts'

const reason = (run: () => unknown): unknown => { try { run() } catch (error) { return (error as { code?: string; detail: { reason?: string } }).detail.reason } return null }
const code = (run: () => unknown): unknown => { try { run() } catch (error) { return (error as { code?: string }).code } return null }
const task = (over: Record<string, unknown> = {}) => ({ id: 'aaaaaaaaaaaa', name: 'Nightly', type: 'command', cycle: 'daily', hour: '3', minute: '15', command: '/usr/bin/true', enabled: true, ...over })

describe('host task rows', { tags: ['unit'] }, () => {
  it('normalizes form strings and keeps unused fields neutral', () => {
    const saved = validateHostTask(task({ every: '99', keep: '9', target: 'ignored' }))
    expect(saved).toMatchObject({ hour: 3, minute: 15, every: 0, keep: 0, target: '', exclude: '', chained: false })
    expect(validateHostTask(saved)).toEqual(saved)
  })
  it('rejects a site backup on a cycle of seconds with VALIDATION', () => {
    const backup = task({ type: 'site-backup', cycle: 'seconds', every: 30, target: 'example.com', keep: 3 })
    expect(code(() => validateHostTask(backup))).toBe('VALIDATION')
    expect(reason(() => validateHostTask(backup))).toBe('task_cycle_invalid')
    expect(validateHostTask({ ...backup, cycle: 'hourly', minute: 5 }).keep).toBe(3)
  })
  it('bounds every cycle', () => {
    for (const bad of [{ cycle: 'seconds', every: 5 }, { cycle: 'minutes', every: 60 }, { cycle: 'hours', every: 24, minute: 0 }, { cycle: 'days', every: 1, hour: 1, minute: 1 }, { cycle: 'weekly', weekday: 7, hour: 1, minute: 1 }, { cycle: 'monthly', day: 32, hour: 1, minute: 1 }, { cycle: 'daily', hour: 24 }]) {
      expect(reason(() => validateHostTask(task(bad))), JSON.stringify(bad)).toBe('task_cycle_invalid')
    }
  })
  it('takes a command as an absolute binary and argument lines, never a shell line', () => {
    expect(hostCommandArgv('/usr/bin/php\n-v\n')).toEqual(['/usr/bin/php', '-v'])
    for (const bad of ['php -v', '', '/usr/bin/php -v; rm', '/usr/../bin/sh']) expect(reason(() => hostCommandArgv(bad)), bad).toBe('task_command_invalid')
  })
  it('keeps backups away from kernel filesystems and URLs free of credentials', () => {
    expect(reason(() => validateHostTask(task({ type: 'directory-backup', target: '/proc/1', keep: 1 })))).toBe('task_target_invalid')
    expect(reason(() => validateHostTask(task({ type: 'url', target: 'https://user:pw@example.com/' })))).toBe('task_target_invalid')
    expect(validateHostTask(task({ type: 'url', target: 'https://example.com/ping' })).target).toBe('https://example.com/ping')
  })
  it('lets a chained task run only a command or a script', () => {
    expect(reason(() => validateHostTask(task({ chained: true, type: 'memory-release' })))).toBe('task_type_invalid')
  })
})

describe('host scheduler file', { tags: ['unit'] }, () => {
  const ids = ['aaaaaaaaaaa1', 'aaaaaaaaaaa2', 'aaaaaaaaaaa3'] as const
  const trigger = (id: string, taskId: string, targetId: string) => validateHostTrigger({ id, name: 'T', taskId, match: 'include', value: 'stopped', targetId })
  it('refuses a trigger loop, also through a longer path', () => {
    const tasks = ids.map(id => validateHostTask(task({ id })))
    expect(validateHostScheduler({ ...defaultHostScheduler(), tasks, triggers: [trigger('bbbbbbbbbbb1', ids[0], ids[1]), trigger('bbbbbbbbbbb2', ids[1], ids[2])] }).triggers).toHaveLength(2)
    expect(reason(() => validateHostScheduler({ ...defaultHostScheduler(), tasks, triggers: [trigger('bbbbbbbbbbb1', ids[0], ids[1]), trigger('bbbbbbbbbbb2', ids[1], ids[0])] }))).toBe('trigger_loop')
    expect(reason(() => validateHostScheduler({ ...defaultHostScheduler(), tasks, triggers: [trigger('bbbbbbbbbbb1', ids[0], ids[0])] }))).toBe('trigger_loop')
  })
  it('refuses a dangling script and a deleted trigger target', () => {
    expect(reason(() => validateHostScheduler({ ...defaultHostScheduler(), tasks: [validateHostTask(task({ type: 'script', scriptId: ids[1] }))] }))).toBe('task_script_unknown')
    expect(reason(() => validateHostScheduler({ ...defaultHostScheduler(), tasks: [validateHostTask(task({ id: ids[0] }))], triggers: [trigger('bbbbbbbbbbb1', ids[0], ids[1])] }))).toBe('trigger_task_unknown')
  })
  it('keeps the key digest of a hook out of its public row', () => {
    expect(publicHostHook({ id: ids[0], name: 'Deploy', scriptId: ids[1], keyHash: 'a'.repeat(64), createdAt: '2026-11-07T00:00:00.000Z' })).not.toHaveProperty('keyHash')
  })
  it('validates script languages, return types and content', () => {
    const script = { id: ids[0], name: 'Count', language: 'bash', returns: 'integer', args: '--all\n', content: 'echo 1\r\n' }
    expect(validateHostScript(script)).toMatchObject({ args: '--all', content: 'echo 1\n' })
    expect(reason(() => validateHostScript({ ...script, returns: 'bool' }))).toBe('script_return_invalid')
    expect(reason(() => validateHostScript({ ...script, content: '  ' }))).toBe('script_content_invalid')
  })
})

describe('other host tool rows', { tags: ['unit'] }, () => {
  it('admits daemons as root or an account with a shell-free command', () => {
    const daemon = { id: 'aaaaaaaaaaaa', name: 'queue-worker', command: '/usr/bin/php\nartisan\nqueue:work', user: 'root', directory: '/srv/app', restart: 'always', enabled: true }
    expect(validateHostDaemon(daemon).name).toBe('queue-worker')
    expect(reason(() => validateHostDaemon({ ...daemon, name: 'Bad Name' }))).toBe('daemon_name_invalid')
    expect(reason(() => validateHostDaemon({ ...daemon, user: 'x;y' }))).toBe('daemon_user_invalid')
  })
  it('names only known services in the watchdog', () => {
    expect(validateHostWatchdog({ budgetPerHour: 2, services: { dovecot: { enabled: true, autoRestart: true, intervalSec: 60 } } }).services.dovecot?.intervalSec).toBe(60)
    expect(reason(() => validateHostWatchdog({ budgetPerHour: 2, services: { sshd: { enabled: true, autoRestart: true, intervalSec: 60 } } }))).toBe('watchdog_invalid')
    expect(reason(() => validateHostWatchdog({ budgetPerHour: 2, services: { nginx: { enabled: true, autoRestart: true, intervalSec: 10 } } }))).toBe('watchdog_interval_invalid')
  })
  it('validates hosts entries and RAM disks', () => {
    expect(validateHostsEntry({ id: 'aaaaaaaaaaaa', ip: '192.0.2.5', names: ' Build.Example.TEST  ci ' })).toMatchObject({ ip: '192.0.2.5', names: 'build.example.test ci' })
    expect(reason(() => validateHostsEntry({ id: 'aaaaaaaaaaaa', ip: '192.0.2.5', names: 'bad_name' }))).toBe('hosts_entry_invalid')
    expect(reason(() => validateRamDisk({ id: 'aaaaaaaaaaaa', name: '../x', sizeMb: 10 }))).toBe('ram_disk_invalid')
  })
  it('needs tokens for frp and never shows them', () => {
    const base = defaultFrp()
    expect(reason(() => validateFrp({ ...base, server: { ...base.server, enabled: true, token: 'short' } }))).toBe('frp_token_invalid')
    expect(reason(() => validateFrp({ ...base, server: { ...base.server, portMin: 7000, portMax: 7100 } }))).toBe('frp_port_invalid')
    const view = publicFrp(validateFrp({ ...base, server: { ...base.server, enabled: true, token: 'a'.repeat(32) } }))
    expect(view.server).toMatchObject({ token: '', tokenSet: true })
  })
  it('asks a provider for credentials and a zone on this server for none', () => {
    expect(validateDdnsRecord({ id: 'aaaaaaaaaaaa', hostname: 'home.example.com', provider: 'local', secret: 'x' }).secret).toBe('')
    expect(reason(() => validateDdnsRecord({ id: 'aaaaaaaaaaaa', hostname: 'home.example.com', provider: 'cloudflare', secret: '' }))).toBe('ddns_secret_invalid')
  })
})
