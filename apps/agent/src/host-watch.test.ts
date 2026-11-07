import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail, HOST_TOOLS_STATE } from '@xpanel/core'
import { createHostWatch, pingFpmPool, type HostWatchDeps, type HostWatchState } from './host-watch.ts'

describe('service watchdog and PHP guardian', { tags: ['unit'] }, () => {
  let root: string, state: HostWatchState | null, clock: number
  const save = (key: 'watchdog' | 'guardian', value: unknown): void => writeFileSync(join(root, HOST_TOOLS_STATE[key]), JSON.stringify(value))
  const watch = (over: Partial<HostWatchDeps>) => createHostWatch({ rootDir: root, restartService: async () => undefined, restartPool: async () => true, pools: async () => [], alert: async () => undefined, readState: async () => state, writeState: async next => { state = JSON.parse(JSON.stringify(next)) }, now: () => new Date(clock), ...over })
  const kinds = (): string[] => state!.events.map(event => event.kind)
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'xp-watch-')); mkdirSync(join(root, 'extended/server'), { recursive: true }); state = null; clock = Date.UTC(2026, 10, 7) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('does nothing while nothing is enabled', async () => {
    const probe = vi.fn(async () => true)
    await watch({ probe }).tick()
    expect(probe).not.toHaveBeenCalled()
    expect(state).toBeNull()
  })

  it('restarts within one interval and alerts instead on the third failure of the hour', async () => {
    save('watchdog', { budgetPerHour: 2, services: { dovecot: { enabled: true, autoRestart: true, intervalSec: 60 } } })
    const restartService = vi.fn(async () => undefined), alert = vi.fn(async () => undefined), up = { value: false }
    const instance = watch({ restartService, alert, probe: async (kind, port) => { expect([kind, port]).toEqual(['imap', 143]); return up.value } })
    await instance.tick()
    expect(restartService).toHaveBeenCalledTimes(1)
    up.value = true; clock += 60_000; await instance.tick()
    up.value = false; clock += 60_000; await instance.tick()
    expect(restartService).toHaveBeenCalledTimes(2)
    up.value = true; clock += 120_000; await instance.tick()
    up.value = false; clock += 60_000; await instance.tick()
    expect(restartService).toHaveBeenCalledTimes(2)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(kinds()).toEqual(['failure', 'restart', 'recovered', 'failure', 'restart', 'recovered', 'failure', 'alert'])
  })

  it('waits for the probe interval between checks and doubles it after a restart', async () => {
    save('watchdog', { budgetPerHour: 5, services: { nginx: { enabled: true, autoRestart: true, intervalSec: 120 } } })
    const probe = vi.fn(async () => false), instance = watch({ probe })
    await instance.tick(); clock += 60_000; await instance.tick()
    expect(probe).toHaveBeenCalledTimes(1)
    clock += 60_000; await instance.tick()
    expect(probe).toHaveBeenCalledTimes(2)
    clock += 120_000; await instance.tick()
    expect(probe).toHaveBeenCalledTimes(2)
    clock += 120_000; await instance.tick()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('alerts instead of restarting when the configuration test fails', async () => {
    save('watchdog', { budgetPerHour: 2, services: { nginx: { enabled: true, autoRestart: true, intervalSec: 60 } } })
    const alert = vi.fn(async () => undefined)
    await watch({ alert, probe: async () => false, restartService: async () => fail('CONFIG_TEST_FAILED', 'nginx failed its test', { stateChanged: false }) }).tick()
    expect(kinds()).toEqual(['failure', 'config_test_failed'])
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('only records a failure when auto-restart is off', async () => {
    save('watchdog', { budgetPerHour: 2, services: { nginx: { enabled: true, autoRestart: false, intervalSec: 60 } } })
    const restartService = vi.fn(async () => undefined)
    await watch({ restartService, probe: async () => false }).tick()
    expect(restartService).not.toHaveBeenCalled()
    expect(kinds()).toEqual(['failure'])
  })

  it('restarts a pool that does not answer, within one check interval', async () => {
    save('guardian', { enabled: true, intervalSec: 60, timeoutSec: 1 })
    const restartPool = vi.fn(async () => true), ping = vi.fn(async (socket: string) => !socket.includes('bob')), instance = watch({ restartPool, ping, pools: async () => [{ account: 'alice', version: '8.3' }, { account: 'bob', version: '8.3' }] })
    await instance.tick()
    expect(restartPool.mock.calls).toEqual([['bob', '8.3']])
    expect(state!.events.map(event => [event.target, event.kind])).toEqual([['bob:8.3', 'failure'], ['bob:8.3', 'restart']])
    await instance.tick()
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('reads a FastCGI answer from a pool socket and times out on a silent one', async () => {
    const path = join(root, 'pool.sock')
    let answer = true
    const server = net.createServer(socket => socket.on('data', () => { if (answer) socket.write(Buffer.from([1, 6, 0, 1, 0, 1, 0, 0, 0x70])) }))
    await new Promise<void>(resolve => server.listen(path, resolve))
    try {
      expect(await pingFpmPool(path, 500)).toBe(true)
      answer = false
      expect(await pingFpmPool(path, 50)).toBe(false)
    } finally { await new Promise(resolve => server.close(resolve)) }
    expect(await pingFpmPool(join(root, 'absent.sock'), 50)).toBe(false)
  })
})
