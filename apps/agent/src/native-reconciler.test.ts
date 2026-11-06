import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReconcilerDeps } from './reconciler.ts'
import { createNativeHostReconciler } from './native-reconciler.ts'

describe('one native reconciler composition for the agent and the lifecycle runtime', () => {
  it('is the only production construction of HostReconciler', () => {
    const root = import.meta.dirname
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    const constructing = sources.filter(file => readFileSync(join(root, file), 'utf8').includes('new HostReconciler('))
    expect(constructing.map(file => file.replaceAll('\\', '/'))).toEqual(['native-reconciler.ts'])
  })

  it('wires the DNS validator and the management TLS hosts the agent renders with', async () => {
    const env = 'XPANEL_WHM_PUBLIC_ORIGIN=https://whm.example.test:2087\nXPANEL_PANEL_PUBLIC_ORIGIN=https://panel.example.test:2083\nXPANEL_MAIL_PUBLIC_ORIGIN=https://mail.example.test:2096\n'
    const executor = { readFile: async (path: string) => path === '/etc/xpanel/api.env' ? env : null } as unknown as ReconcilerDeps['executor']
    const { reconciler, dnsPublication } = await createNativeHostReconciler({ store: { rootDir: '/var/lib/xpanel/state' } as ReconcilerDeps['store'], db: {} as ReconcilerDeps['db'], executor, os: { family: 'debian' } as ReconcilerDeps['os'] })
    const deps = (reconciler as unknown as { deps: ReconcilerDeps }).deps
    expect(deps.dnsPublication).toBe(dnsPublication)
    expect(typeof dnsPublication.validate).toBe('function')
    expect(typeof dnsPublication.verify).toBe('function')
    expect(deps.managementHosts).toEqual(['whm.example.test', 'panel.example.test', 'mail.example.test'])
  })
})
