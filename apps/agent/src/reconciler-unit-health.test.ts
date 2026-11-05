import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { profileFor } from '@xpanel/os'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { AgentExecutor, ConfigTestResult } from './executor.ts'
import { HostReconciler } from './reconciler.ts'

/**
 * A generation can manage .service, .timer and .socket units. The post-reload health probe must
 * observe timer/socket units instead of rejecting them as "not a service unit"; otherwise every
 * cron or socket change activates the timer and then fails its own verification, which rolls the
 * generation back and poisons later reconciles.
 */
const reconcilerWith = (output: string) => {
  const commands: string[][] = []
  const executor = {
    async runCommand(argv: string[]): Promise<ConfigTestResult> { commands.push([...argv]); return { ok: true, code: 0, stdout: output, stderr: '' } },
  } as unknown as AgentExecutor
  const reconciler = new HostReconciler({
    executor,
    store: { rootDir: '/unused-unit-health-fixture' } as StateStore,
    db: {} as Db,
    os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'),
  }) as unknown as { verifyUnitHealth(unit: string, generationId: number): Promise<{ ok: boolean; error?: string }> }
  return { commands, probe: (unit: string) => reconciler.verifyUnitHealth(unit, 1) }
}

describe('reconciler unit health probe unit types', { tags: ['unit'] }, () => {
  it('probes an active timer instead of rejecting its unit type', async () => {
    const { commands, probe } = reconcilerWith('Id=xpanel-cron-alice-abc.timer\nActiveState=active\n')
    assert.deepEqual(await probe('xpanel-cron-alice-abc.timer'), { ok: true })
    assert.equal(commands.length, 1)
    assert.equal(commands[0]![1], 'show')
    assert.equal(commands[0]!.at(-1), 'xpanel-cron-alice-abc.timer')
  })

  it('probes an active socket unit', async () => {
    const { probe } = reconcilerWith('Id=xpanel-appproxy-alice-shop.socket\nActiveState=active\n')
    assert.deepEqual(await probe('xpanel-appproxy-alice-shop.socket'), { ok: true })
  })

  it('reports an inactive managed unit by its observed state', async () => {
    const { probe } = reconcilerWith('Id=xpanel-cron-alice-abc.timer\nActiveState=failed\n')
    assert.deepEqual(await probe('xpanel-cron-alice-abc.timer'), { ok: false, error: 'service unit xpanel-cron-alice-abc.timer is failed' })
  })

  it('keeps refusing unit types a generation never manages', async () => {
    const { commands, probe } = reconcilerWith('ActiveState=active\n')
    const result = await probe('../../etc/passwd')
    assert.equal(result.ok, false)
    assert.match(String(result.error), /cannot be probed/)
    assert.equal(commands.length, 0)
  })
})
