import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from './executor.ts'
import { mergeOriginIntoRuntime, parseEnvAssignments, readManagementHosts, syncRuntimePublicOrigin } from './agent-origin.ts'

describe('management hosts', () => {
  it('reads the hosts of the public management origins and ignores anything that is not a URL', async () => {
    const executor = new FakeHostExecutor()
    const file = { path: '/etc/xpanel/api.env', mode: 0o640, owner: 'root', group: 'xpanel' }
    expect(await readManagementHosts(executor)).toEqual([])
    executor.files.set(file.path, { ...file, content: 'XPANEL_WHM_PUBLIC_ORIGIN=https://WHM.Panel.example.test:2087\nXPANEL_PANEL_PUBLIC_ORIGIN=https://panel.example.test:2083\nXPANEL_MAIL_PUBLIC_ORIGIN=not a url\n' })
    expect(await readManagementHosts(executor)).toEqual(['whm.panel.example.test', 'panel.example.test'])
  })

  it('never turns a refused read into an empty host list', async () => {
    await expect(readManagementHosts({ readFile: () => Promise.reject(new Error('LIFECYCLE_NATIVE_SCOPE_REQUIRED')) })).rejects.toThrow('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  })
})

describe('runtime public origin', () => {
  it('copies origin keys from api.env and leaves the rest of runtime.env', async () => {
    const runtime = 'XPANEL_AGENT_GID=900\nXPANEL_DB_PATH=/var/lib/xpanel/control.db\n'
    const api = '# origins\nXPANEL_WHM_PUBLIC_ORIGIN=https://panel.example.test\nXPANEL_PANEL_PUBLIC_ORIGIN=https://panel.example.test\nXPANEL_ALLOWED_ORIGINS=https://panel.example.test\n'
    const merged = mergeOriginIntoRuntime(runtime, api)
    expect(merged).toContain('XPANEL_AGENT_GID=900')
    expect(merged).toContain('XPANEL_WHM_PUBLIC_ORIGIN=https://panel.example.test')
    expect(merged).toContain('XPANEL_PANEL_PUBLIC_ORIGIN=https://panel.example.test')
    expect(merged).not.toContain('XPANEL_ALLOWED_ORIGINS')
    expect(mergeOriginIntoRuntime(merged ?? '', api)).toBeNull()
    expect(parseEnvAssignments('XPANEL_WHM_PUBLIC_ORIGIN=bad\u0001value').size).toBe(0)

    const executor = new FakeHostExecutor()
    const file = { mode: 0o640, owner: 'root', group: 'xpanel' }
    executor.files.set('/etc/xpanel/runtime.env', { path: '/etc/xpanel/runtime.env', content: runtime, ...file })
    executor.files.set('/etc/xpanel/api.env', { path: '/etc/xpanel/api.env', content: api, ...file })
    expect(await syncRuntimePublicOrigin(executor)).toBe(true)
    expect(executor.files.get('/etc/xpanel/runtime.env')?.content).toBe(merged)
    expect(executor.files.get('/etc/xpanel/api.env')?.content).toBe(api)
    expect([...executor.files.keys()].some(path => path.startsWith('/etc/xpanel/runtime.env.bak.'))).toBe(true)
  })
})
