import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFrp, defaultHostScheduler, HOST_TOOLS_STATE, validateHostTask } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { applyLogCleanup, parseJournalUsage, scanLogCleanup } from './host-log-cleanup.ts'
import { buildSwapPlan, handleHostToolsRoute, type HostToolsRouteContext } from './host-tools-routes.ts'
import { applyHostTools, withHostsBlock } from './host-tools.ts'
import { isHostToolsCommand } from '../../../packages/os/src/host-tools-command.ts'

const ID = 'aaaaaaaaaaa1'
const swaps = (kb: number): string => `Filename Type Size Used Priority\n/var/swapfile file ${kb} 0 -2\n`

describe('host tool routes', { tags: ['unit'] }, () => {
  let root: string, commands: string[][]
  const host = (over: Partial<NonNullable<HostToolsRouteContext['host']>> = {}): NonNullable<HostToolsRouteContext['host']> => ({ writeFile: async () => undefined, runCommand: async argv => { commands.push(argv); return { ok: true, stdout: '', stderr: '' } }, ...over })
  const call = (method: string, path: string, body?: unknown, over: Partial<HostToolsRouteContext> = {}): Promise<Response | null> => {
    const url = new URL('http://agent.local' + path)
    return handleHostToolsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, { assertRoot: async () => ({ actor: 'root' }), host: host(), rootDir: root, accounts: async () => [{ username: 'alice' }], submitJob: null, logDir: join(root, 'logs'), ...over })
  }
  const saveScheduler = (): void => writeFileSync(join(root, HOST_TOOLS_STATE.scheduler), JSON.stringify({ ...defaultHostScheduler(), tasks: [validateHostTask({ id: ID, name: 'T', type: 'memory-release', cycle: 'manual', enabled: true })] }))
  const refused = async (response: Promise<Response | null>): Promise<unknown> => { try { await response } catch (error) { return (error as { detail: { reason?: string } }).detail.reason } return null }
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'xp-tools-')); mkdirSync(join(root, 'extended/server'), { recursive: true }); mkdirSync(join(root, 'logs')); commands = [] })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('passes other paths on', async () => {
    expect(await call('GET', '/host/other')).toBeNull()
  })
  it('refuses without the native executor', async () => {
    expect(await refused(call('GET', '/host/host-tools/runs', undefined, { host: null }))).toBe('host_executor_unavailable')
  })
  it('starts only saved units, once per call', async () => {
    saveScheduler()
    expect((await call('POST', `/host/host-tools/run/${ID}`, {}))!.status).toBe(202)
    expect(commands).toEqual([['/usr/bin/systemctl', 'start', '--no-block', `xpanel-task-${ID}.service`]])
    expect(commands.every(isHostToolsCommand)).toBe(true)
    expect(await refused(call('POST', '/host/host-tools/run/bbbbbbbbbbbb', {}))).toBe('host_tool_unknown')
    expect((await call('GET', `/host/host-tools/run/${ID}`))!.status).toBe(405)
    expect(commands).toHaveLength(1)
  })
  it('reads and clears a log', async () => {
    writeFileSync(join(root, 'logs', `${ID}.log`), 'output\n')
    writeFileSync(join(root, 'logs', `${ID}.runs`), '{"at":"2026-11-07T00:00:00.000Z","result":"ok"}\n')
    expect(await (await call('GET', `/host/host-tools/log/${ID}`))!.json()).toEqual({ log: 'output\n', runs: [{ at: '2026-11-07T00:00:00.000Z', result: 'ok' }] })
    expect(await (await call('GET', '/host/host-tools/runs'))!.json()).toEqual({ runs: { [ID]: { at: '2026-11-07T00:00:00.000Z', result: 'ok' } } })
    expect((await call('POST', `/host/host-tools/log-clear/${ID}`, {}))!.status).toBe(200)
    expect(existsSync(join(root, 'logs', `${ID}.log`))).toBe(false)
    expect((await call('POST', `/host/host-tools/log-clear/${ID}`, {}))!.status).toBe(200)
  })
  it('sets a time zone only when the host confirms it', async () => {
    const answers = host({ runCommand: async argv => ({ ok: true, stdout: argv[1] === 'show' ? 'Europe/Paris\n' : '', stderr: '' }) })
    expect(await (await call('POST', '/host/host-tools/timezone', { zone: 'Europe/Paris' }, { host: answers }))!.json()).toEqual({ applied: true })
    expect(await refused(call('POST', '/host/host-tools/timezone', { zone: 'bad zone' }))).toBe('timezone_invalid')
  })
  it('refuses to change a hosting account or system user password here', async () => {
    const passwd = (entry: string) => host({ runCommand: async () => ({ ok: true, stdout: entry, stderr: '' }) })
    expect(await refused(call('POST', '/host/host-tools/password', { user: 'www-data', password: 'long enough' }, { host: passwd('www-data:x:33:33::/var/www:/usr/sbin/nologin\n') }))).toBe('system_user_refused')
    expect(await refused(call('POST', '/host/host-tools/password', { user: 'alice', password: 'long enough' }, { host: passwd('alice:x:2001:2001::/home/alice:/bin/bash\n') }))).toBe('system_user_refused')
    expect(await refused(call('POST', '/host/host-tools/password', { user: 'ops', password: 'one\nline' }))).toBe('system_user_invalid')
  })
  it('mounts and reports a RAM disk through /proc/mounts', async () => {
    const readProc = async () => 'tmpfs /mnt/ram-cache tmpfs rw 0 0\n'
    expect(await (await call('POST', '/host/host-tools/ram-disk', { name: 'cache', sizeMb: 64, mounted: true }, { readProc }))!.json()).toEqual({ path: '/mnt/ram-cache', applied: true })
    expect(commands).toEqual([['/usr/bin/mkdir', '--parents', '/mnt/ram-cache'], ['/usr/bin/mount', '-t', 'tmpfs', '-o', 'size=64m,mode=0755,nosuid,nodev', 'tmpfs', '/mnt/ram-cache']])
    expect(commands.every(isHostToolsCommand)).toBe(true)
  })
  it('installs frp only when the download matches its pinned digest', async () => {
    const bytes = new TextEncoder().encode('not the release')
    expect(await refused(call('POST', '/host/host-tools/frp-install', {}, { arch: 'x64', fetcher: (async () => new Response(bytes)) as typeof fetch }))).toBe('frp_digest_mismatch')
    expect(commands).toEqual([])
    expect(createHash('sha256').update(bytes).digest('hex')).not.toBe('')
    expect(await refused(call('POST', '/host/host-tools/frp-install', {}, { arch: 'riscv64' }))).toBe('frp_arch_unsupported')
    expect(await refused(call('POST', '/host/host-tools/frp-install', {}, { arch: 'x64', fetcher: (async () => new Response('', { status: 404 })) as typeof fetch }))).toBe('frp_download_failed')
  })
})

describe('swap plan', { tags: ['unit'] }, () => {
  it('sizes the file, keeps it across reboots and proves the size', async () => {
    const plan = buildSwapPlan(1024, true, async () => swaps(1024 * 1024))
    expect(plan.steps.map(step => step.id)).toEqual(['swap-off', 'remove', 'allocate', 'protect', 'format', 'swap-on', 'reload', 'enable'])
    expect(plan.steps.every(step => plan.policy(step.argv))).toBe(true)
    expect(await plan.verify!(async () => ({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false }))).toEqual({ ok: true, detail: { observedMb: 1024 } })
    expect((await buildSwapPlan(2048, false, async () => swaps(1024 * 1024)).verify!(async () => ({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false }))).ok).toBe(false)
  })
  it('removes the file and its unit for size zero', () => {
    expect(buildSwapPlan(0, true, async () => null).steps.map(step => step.id)).toEqual(['swap-off', 'remove', 'disable', 'remove-unit', 'reload'])
  })
})

describe('log cleanup', { tags: ['unit'] }, () => {
  let root: string
  const run = async (argv: string[]) => ({ ok: true, stdout: argv[1] === '--disk-usage' ? 'Archived and active journals take up 16.0M in the file system.\n' : '', stderr: '' })
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'xp-logs-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('reads the journal size', () => {
    expect(parseJournalUsage('Archived and active journals take up 1.5G in the file system.')).toBe(1610612736)
    expect(parseJournalUsage('nothing')).toBeNull()
  })
  it('truncates site logs in place and lists their size', async () => {
    const log = join(root, 'example.com.access.log')
    writeFileSync(log, 'x'.repeat(10_000))
    writeFileSync(join(root, 'held.txt'), 'x')
    const site = (await scanLogCleanup(run, root)).find(row => row.id === 'site')!
    expect(site.items.map(item => item.path)).toEqual([log])
    const done = await applyLogCleanup(run, ['site'], root)
    expect(done).toMatchObject({ removed: 1, failed: 0 })
    expect(done.freedBytes).toBeGreaterThan(0)
    expect(readFileSync(log, 'utf8')).toBe('')
    expect(readFileSync(join(root, 'held.txt'), 'utf8')).toBe('x')
  })
  it('refuses an empty or unknown choice', async () => {
    await expect(applyLogCleanup(run, [])).rejects.toMatchObject({ detail: { reason: 'log_category_invalid' } })
  })
  it('names the fixed site log directory by default', () => {
    expect(edge.XP_PATHS.nginxLogDir).toBe('/var/log/xpanel/nginx')
  })
})

describe('host tools compile step', { tags: ['unit'] }, () => {
  it('replaces one managed block and keeps other lines', () => {
    const once = withHostsBlock('127.0.0.1 localhost\n', [{ id: ID, ip: '192.0.2.5', names: 'ci.example.test' }])
    expect(once).toBe('127.0.0.1 localhost\n# BEGIN xPanel hosts\n192.0.2.5 ci.example.test\n# END xPanel hosts\n')
    expect(withHostsBlock(once, [{ id: ID, ip: '192.0.2.6', names: 'ci.example.test' }])).toBe('127.0.0.1 localhost\n# BEGIN xPanel hosts\n192.0.2.6 ci.example.test\n# END xPanel hosts\n')
    expect(withHostsBlock(once, [])).toBe('127.0.0.1 localhost\n')
  })
  it('adds its files to the generation and edits the rendered hosts file', () => {
    const files = [{ path: '/etc/hosts', content: '127.0.0.1 localhost\n', mode: 0o644, owner: 'root', group: 'root' }], pre: never[] = [], post: never[] = []
    const scheduler = { ...defaultHostScheduler(), tasks: [validateHostTask({ id: ID, name: 'T', type: 'memory-release', cycle: 'daily', hour: 1, minute: 1, enabled: true })] }
    applyHostTools(files, pre, post, { scheduler, daemons: { profile: { restartSec: 3, burst: 5, windowSec: 60 }, daemons: [] }, frp: defaultFrp(), linux: { timezone: null, swapMb: 0, hosts: [{ id: ID, ip: '192.0.2.5', names: 'ci.example.test' }], ramDisks: [] }, program: '#!/usr/bin/node\n' }, { family: 'debian' } as never, { accounts: [], domains: [] })
    expect(files.map(file => file.path)).toContain(`/etc/systemd/system/xpanel-task-${ID}.timer`)
    expect(files[0]!.content).toContain('192.0.2.5 ci.example.test')
    expect(post).toHaveLength(3)
  })
})
