import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { handlePanelAccessHostRoute, isPanelAccessCommand, managementFirewallPorts, MANAGEMENT_ACCESS_NEXT_PATH, MANAGEMENT_ACCESS_PATH, parseManagementAccess, revertExpiredPanelTrial, RESTART_API, START_REBIND } from './panel-access.ts'
import { PANEL_BINDING_DEFAULT } from './panel-gate-policy.ts'

const CONFIG = '/etc/xpanel/management-tls.json'
const fakeHost = (files: Record<string, string> = { [CONFIG]: JSON.stringify({ hostname: 'panel.example.com' }) }, ok = true) => {
  const commands: string[][] = []
  return { files, commands,
    readFile: async (path: string) => files[path] ?? null,
    writeFile: async (file: { path: string; content: string }) => { files[file.path] = file.content },
    removePath: async (path: string) => { delete files[path] },
    runCommand: async (argv: string[]) => { commands.push(argv); return { ok, code: ok ? 0 : 1, stdout: '', stderr: '' } } }
}
type Host = ReturnType<typeof fakeHost>
const call = (host: Host | null, path: string, body?: unknown, probePort?: (port: number) => Promise<boolean>) => handlePanelAccessHostRoute(
  new Request(`http://agent${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), new URL(`http://agent${path}`), body === undefined ? 'GET' : 'POST',
  { assertRoot: async () => ({ actor: 'root' }), executor: host as never, now: () => new Date('2026-11-07T10:00:00.000Z'), ...(probePort ? { probePort } : {}) })
const moved = { ports: { ...PANEL_BINDING_DEFAULT.ports, xwhm: 18888 }, hosts: PANEL_BINDING_DEFAULT.hosts }
const code = async (run: Promise<unknown>): Promise<unknown> => { try { await run } catch (error) { return (error as { detail: Record<string, unknown> }).detail.reason } throw new Error('expected a refusal') }

describe('panel access host routes', () => {
  it('refuses without the native executor and without management TLS', async () => {
    expect(await code(call(null, '/host/panel-access'))).toBe('native_host_required')
    expect(await code(call(fakeHost({}), '/host/panel-access/check', { binding: moved }))).toBe('management_tls_not_prepared')
  })

  it('reports a port the kernel will not bind', async () => {
    expect(await code(call(fakeHost(), '/host/panel-access/check', { binding: moved }, async () => false))).toBe('PORT_IN_USE')
    const free = await (await call(fakeHost(), '/host/panel-access/check', { binding: moved }, async () => true))!.json() as { origins: Record<string, string> }
    expect(free.origins.xwhm).toBe('https://whm.panel.example.com:18888')
  })

  it('opens the new port first, then hands the switch to the management lifecycle with a deadline', async () => {
    const host = fakeHost()
    await call(host, '/host/panel-access/open', { binding: moved })
    expect(await managementFirewallPorts(host)).toEqual([2083, 2087, 2096, 18888])
    const applied = await (await call(host, '/host/panel-access/apply', { binding: moved }))!.json() as { deadline: string }
    expect(applied.deadline).toBe('2026-11-07T10:10:00.000Z')
    expect(host.commands).toEqual([[...START_REBIND]])
    const next = parseManagementAccess(host.files[MANAGEMENT_ACCESS_NEXT_PATH]!)
    expect(next.ports.xwhm).toBe(18888)
    expect(next.open).toEqual([2083, 2087, 2096])
    expect(next.trial?.previous.ports.xwhm).toBe(2087)
    expect(await code(call(host, '/host/panel-access/apply', { binding: moved }))).toBe('panel_binding_applying')
  })

  it('leaves nothing behind when the unit cannot start', async () => {
    const host = fakeHost(undefined, false)
    await expect(call(host, '/host/panel-access/apply', { binding: moved })).rejects.toThrow('could not start')
    expect(host.files[MANAGEMENT_ACCESS_NEXT_PATH]).toBeUndefined()
  })

  const inTrial = (deadline = '2026-11-07T10:10:00.000Z') => fakeHost({ [CONFIG]: '{}', [MANAGEMENT_ACCESS_PATH]: JSON.stringify({ schemaVersion: 1, ...moved, open: [2087], trial: { deadline, previous: PANEL_BINDING_DEFAULT } }) })

  it('keeps a confirmed address and closes the old port', async () => {
    const host = inTrial()
    await call(host, '/host/panel-access/confirm', {})
    const access = parseManagementAccess(host.files[MANAGEMENT_ACCESS_PATH]!)
    expect(access.trial).toBeNull()
    expect(await managementFirewallPorts(host)).toEqual([2083, 18888, 2096])
    expect(await code(call(host, '/host/panel-access/confirm', {}))).toBe('no_trial')
  })

  it('refuses a second change during a trial', async () => {
    expect(await code(call(inTrial(), '/host/panel-access/apply', { binding: moved }))).toBe('trial_active')
  })

  it('returns the previous address at the deadline, once, and not before', async () => {
    const host = inTrial()
    await revertExpiredPanelTrial(host, Date.parse('2026-11-07T10:09:59.000Z'))
    expect(host.commands).toEqual([])
    await revertExpiredPanelTrial(host, Date.parse('2026-11-07T10:10:00.000Z'))
    expect(host.commands).toEqual([[...START_REBIND]])
    const next = parseManagementAccess(host.files[MANAGEMENT_ACCESS_NEXT_PATH]!)
    expect(next).toMatchObject({ ports: PANEL_BINDING_DEFAULT.ports, open: [], trial: null })
    await revertExpiredPanelTrial(host, Date.parse('2026-11-07T10:11:00.000Z'))
    expect(host.commands).toHaveLength(1)
  })

  it('admits exactly its three fixed commands', () => {
    expect(isPanelAccessCommand([...START_REBIND])).toBe(true)
    expect(isPanelAccessCommand([...RESTART_API])).toBe(true)
    expect(isPanelAccessCommand(['/usr/bin/systemctl', 'start', '--no-block', 'nginx.service'])).toBe(false)
    expect(isPanelAccessCommand([...START_REBIND, 'extra'])).toBe(false)
  })

  it('never reports a private key, only the public certificate facts', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n'
    const host = fakeHost({ '/var/lib/xpanel-management-tls/status.json': JSON.stringify({ phase: 'renew', status: 'tls-ready', fingerprint: 'a'.repeat(64), secret: 'x' }), [`/etc/xpanel/management-certificates/${'a'.repeat(64)}/fullchain.pem`]: pem })
    const view = await (await call(host, '/host/panel-access'))!.json() as { lifecycle: Record<string, unknown>; certificate: unknown; available: boolean }
    expect(view.available).toBe(false)
    expect(view.lifecycle).not.toHaveProperty('secret')
    expect(view.certificate).toBeNull()
    expect(typeof X509Certificate).toBe('function')
  })
})
