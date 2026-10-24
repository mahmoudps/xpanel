import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { ACCOUNT_FILE_HELPER_PROTOCOL_VERSION, NativeAccountFileRunner } from './account-file-runner.ts'
import type { HelperProcessSpawner } from './account-file-runner.ts'
import type { AccountFileContext } from './file-manager.ts'

const account = { username: 'alice', uid: 29101, gid: 29101, home: '/home/alice' }
const context: AccountFileContext = { account, homeRoot: account.home, diskQuotaMb: 512, maxEditBytes: 1024 * 1024, maxFileMode: 0o640, maxDirMode: 0o750, maxListEntries: 10_000 }
const parent = '/xpanel.slice/xpanel-29101.slice'
const code = (expected: string) => (error: unknown): boolean => isXpanelError(error) && error.code === expected
const runnerFor = (cgroup: string, onLiveWorker?: (info: { pid: number }) => void, returnedUid = account.uid) => {
  const spawner: HelperProcessSpawner = async ({ onStdoutLine }) => {
    const envelope = { protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION, ok: true, op: 'list', worker: { pid: 4001, uid: returnedUid, gid: account.gid, cgroup }, result: [] }
    const stdout = JSON.stringify(envelope)
    await onStdoutLine?.(stdout, 9001)
    return { exitCode: 0, signal: null, pid: 9001, stdout, stderr: '' }
  }
  return new NativeAccountFileRunner({ binaryPath: '/opt/xpanel/bin/xpanel-account-files', requireCgroup: true, cgroupPathForAccount: () => '/sys/fs/cgroup' + parent, spawner, onLiveWorker })
}

describe('confined file runner cgroup membership defense', () => {
  it.each([
    parent + '-neighbor', parent + '.extra/child', '/other' + parent,
    parent + '//child', parent + '/../neighbor', parent + '/./child',
    parent + '/', parent + '/child\n', parent + ' (deleted)', '0::' + parent,
  ])('rejects noncanonical or unrelated telemetry %j', async (cgroup) => {
    const runner = runnerFor(cgroup)
    await assert.rejects(() => runner.run(context, { op: 'list', path: 'public_html', showHidden: false }), code('CONFIG_TEST_FAILED'))
    assert.equal(runner.observations.length, 0)
  })

  it.each([parent, parent + '/xpanel-files-child.service', parent + '/legitimate/descendant'])('accepts canonical exact or slash-descendant membership %j', async (cgroup) => {
    assert.deepEqual(await runnerFor(cgroup).run(context, { op: 'list', path: 'public_html', showHidden: false }), [])
  })

  it('reports the helper PID to live observers, not the systemd-run launcher PID', async () => {
    let observedPid = 0
    const runner = runnerFor(parent + '/xpanel-files-child.service', ({ pid }) => { observedPid = pid })
    await runner.run(context, { op: 'list', path: 'public_html', showHidden: false })
    assert.equal(observedPid, 4001)
  })

  it('never invokes live observers for mismatched worker identity', async () => {
    let observations = 0
    const runner = runnerFor(parent + '/xpanel-files-child.service', () => { observations++ }, 0)
    await assert.rejects(() => runner.run(context, { op: 'list', path: 'public_html', showHidden: false }), code('CONFIG_TEST_FAILED'))
    assert.equal(observations, 0)
  })
})
