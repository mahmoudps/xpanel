import { describe, expect, it } from 'vitest'
import type { AgentExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'

const probe = (stdout: string, code = 0) => {
  const calls: string[][] = []
  const executor = {
    async runCommand(argv: string[]) {
      calls.push(argv)
      return { ok: code === 0, code, stdout, stderr: code === 0 ? '' : 'inactive' }
    },
  }
  const reconciler = new HostReconciler({ executor, store: { rootDir: 'C:/tmp/xpanel-health-probe' } } as unknown as ConstructorParameters<typeof HostReconciler>[0])
  return {
    calls,
    health: (unit: string) => (reconciler as unknown as { verifyUnitHealth(unit: string, generationId: number): Promise<{ ok: boolean; error?: string }> }).verifyUnitHealth(unit, 4),
  }
}

describe('native unit health', () => {
  it('accepts only an observed active systemd unit', async () => {
    const active = probe('Id=nginx.service\nActiveState=active\n')
    await expect(active.health('nginx.service')).resolves.toEqual({ ok: true })
    expect(active.calls[0]).toEqual(['/usr/bin/systemctl', 'show', '--no-pager', '--property=Id,Names,LoadState,ActiveState,SubState,UnitFileState', '--', 'nginx.service'])
    const inactive = probe('ActiveState=inactive\n')
    await expect(inactive.health('nginx.service')).resolves.toEqual({ ok: false, error: 'service unit nginx.service is inactive' })
    const failed = probe('', 1)
    await expect(failed.health('nginx.service')).resolves.toEqual({ ok: false, error: 'inactive' })
    const hidden = probe('')
    await expect(hidden.health('nginx.service')).resolves.toEqual({ ok: false, error: 'service unit nginx.service is unobserved' })
    await expect(hidden.health('not a unit')).resolves.toEqual({ ok: false, error: 'service unit not a unit cannot be probed' })
    expect(hidden.calls).toHaveLength(1)
  })

  it('keeps an injected probe authoritative', async () => {
    const executor = { async runCommand() { throw new Error('native probe must not run') } } as unknown as AgentExecutor
    const reconciler = new HostReconciler({ executor, store: { rootDir: 'C:/tmp/xpanel-health-probe' }, healthProbe: async () => ({ ok: false, error: 'injected' }) } as unknown as ConstructorParameters<typeof HostReconciler>[0])
    await expect((reconciler as unknown as { verifyUnitHealth(unit: string, generationId: number): Promise<{ ok: boolean }> }).verifyUnitHealth('nginx.service', 1)).resolves.toEqual({ ok: false, error: 'injected' })
  })
})
