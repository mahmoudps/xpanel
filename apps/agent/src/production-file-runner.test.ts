import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it, vi } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { NativeAccountFileRunnerOptions, HelperProcessSpawnInput } from './account-file-runner.ts'
import type { AccountFileContext } from './file-manager.ts'

const harness = vi.hoisted(() => ({
  installed: true,
  digest: 'a'.repeat(64) as string | null,
  verifiedDigests: [] as (string | undefined)[],
  initialized: 0,
  initializationFailure: undefined as Error | undefined,
  verificationFailure: undefined as Error | undefined,
  verifiedPaths: [] as string[],
  constructed: [] as NativeAccountFileRunnerOptions[],
  payloads: [] as { context: Record<string, unknown>; request: { op: string } }[],
  helperCgroup: undefined as string | undefined,
  helperError: undefined as { errno: number; errnoName: string } | undefined,
}))

vi.mock('./installed-helper-digest.ts', () => ({ readInstalledHelperDigest: async () => harness.digest }))

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: () => harness.installed,
}))

// Only process/binary boundaries are substituted. The production factory and
// runner protocol validation execute unchanged; these are not kernel proofs.
vi.mock('./account-file-runner.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./account-file-runner.ts')>()
  return {
    ...actual,
    verifyHelperBinary: async (binaryPath: string, expectedSha256?: string) => {
      harness.verifiedPaths.push(binaryPath)
      harness.verifiedDigests.push(expectedSha256)
      if (harness.verificationFailure) throw harness.verificationFailure
      return 'a'.repeat(64)
    },
    NativeAccountFileRunner: class extends actual.NativeAccountFileRunner {
      override async initialize(): Promise<void> {
        harness.initialized++
        if (harness.initializationFailure) throw harness.initializationFailure
        await super.initialize()
      }
      constructor(options: NativeAccountFileRunnerOptions) {
        harness.constructed.push(options)
        super({
          ...options,
          spawner: async ({ stdinPayload }: HelperProcessSpawnInput) => {
            const payload = JSON.parse(stdinPayload) as (typeof harness.payloads)[number]
            harness.payloads.push(payload)
            const worker = { pid: 2001, uid: payload.context.uid, gid: payload.context.gid, cgroup: harness.helperCgroup ?? String(payload.context.cgroupPath).slice('/sys/fs/cgroup'.length) + '/' + String(payload.context.workerUnit) }
            return {
              exitCode: harness.helperError ? 1 : 0, signal: null, pid: 2001, stderr: '',
              stdout: JSON.stringify({
                protocolVersion: 2, ok: !harness.helperError, op: payload.request.op, worker,
                ...(harness.helperError ? { error: { code: 'PRECONDITION_FAILED', message: 'cgroup placement refused', ...harness.helperError } } : { result: [] }),
              }),
            }
          },
        })
      }
    },
  }
})

import { createProductionAccountFileRunner } from './production-file-runner.ts'
import { JailedFileManager } from './file-manager.ts'

const binaryPath = '/opt/xpanel/bin/xpanel-account-files'
const account = { username: 'alice', uid: 29101, gid: 29101, home: '/home/alice' }
const context: AccountFileContext = {
  account, homeRoot: '/home/alice', diskQuotaMb: 512,
  maxEditBytes: 1024 * 1024, maxFileMode: 0o640, maxDirMode: 0o750, maxListEntries: 10_000,
}
const code = (expected: string) => (error: unknown): boolean => isXpanelError(error) && error.code === expected

beforeEach(() => {
  harness.installed = true
  harness.digest = 'a'.repeat(64)
  harness.verifiedDigests.length = 0
  harness.initialized = 0
  harness.initializationFailure = undefined
  harness.verificationFailure = undefined
  harness.verifiedPaths.length = 0
  harness.constructed.length = 0
  harness.payloads.length = 0
  harness.helperCgroup = undefined
  harness.helperError = undefined
})

describe('daemon production account file runner composition', () => {
  it('requires the canonical per-UID cgroup in the actual factory-created runner protocol', async () => {
    const runner = await createProductionAccountFileRunner(binaryPath)
    assert.ok(runner)
    assert.deepEqual(await runner.run(context, { op: 'list', path: 'public_html', showHidden: false }), [])
    assert.deepEqual(harness.verifiedPaths, [binaryPath])
    assert.deepEqual(harness.verifiedDigests, ['a'.repeat(64)])
    assert.equal(harness.constructed[0]?.expectedSha256, 'a'.repeat(64))
    assert.equal(harness.payloads[0]?.context.requireCgroup, true)
    assert.equal(harness.payloads[0]?.context.cgroupPath, '/sys/fs/cgroup/xpanel.slice/xpanel-29101.slice')
    assert.equal(harness.payloads[0]?.context.uid, account.uid)
    assert.match(String(harness.payloads[0]?.context.workerUnit), /^xpanel-files-29101-[0-9a-f]{32}\.service$/)
    assert.equal(harness.payloads[0]?.context.gid, account.gid)
    assert.equal(harness.constructed[0]?.spawner, undefined)
    assert.equal(harness.constructed[0]?.incidentDir, '/var/lib/xpanel-agent/file-worker-incidents')
    assert.equal(harness.initialized, 1)
  })

  it.each([1000, 29102, 65_533])('derives the required slice from persisted UID %s, independent of the username', async (uid) => {
    harness.helperCgroup = undefined
    const runner = await createProductionAccountFileRunner(binaryPath)
    assert.ok(runner)
    await runner.run({ ...context, account: { ...account, uid, username: 'othername' } }, { op: 'list', path: 'public_html', showHidden: false })
    assert.equal(harness.payloads[0]?.context.cgroupPath, '/sys/fs/cgroup/xpanel.slice/xpanel-' + uid + '.slice')
    assert.equal(harness.payloads[0]?.context.requireCgroup, true)
    const resolver = harness.constructed[0]?.cgroupPathForAccount
    assert.ok(resolver)
    assert.throws(() => resolver({ ...account, uid: 0 }), code('VALIDATION'))
    assert.throws(() => resolver({ ...account, uid: 65_534 }), code('VALIDATION'))
  })

  it('refuses daemon runner readiness when unresolved worker recovery blocks initialization', async () => {
    const failure = new Error('worker incidents require inspected recovery')
    harness.initializationFailure = failure
    await assert.rejects(() => createProductionAccountFileRunner(binaryPath), (error) => error === failure)
    assert.equal(harness.initialized, 1)
    assert.equal(harness.payloads.length, 0)
  })

  it('keeps a helper without the installer digest unavailable and never verifies or runs it', async () => {
    harness.digest = null
    assert.equal(await createProductionAccountFileRunner(binaryPath), undefined)
    assert.equal(harness.verifiedPaths.length, 0)
    assert.equal(harness.payloads.length, 0)
  })

  it('keeps an absent helper unavailable instead of constructing an unconfined runner', async () => {
    harness.installed = false
    assert.equal(await createProductionAccountFileRunner(binaryPath), undefined)
    assert.equal(harness.verifiedPaths.length, 0)
    assert.equal(harness.constructed.length, 1)
    assert.equal(harness.constructed[0]?.requireCgroup, true)
    assert.equal(harness.initialized, 1)
    assert.equal(harness.payloads.length, 0)
  })

  it('still gates unresolved privileged worker recovery when the helper binary is absent', async () => {
    harness.installed = false
    const failure = new Error('worker incidents require inspected recovery')
    harness.initializationFailure = failure
    await assert.rejects(() => createProductionAccountFileRunner(binaryPath), (error) => error === failure)
    assert.equal(harness.initialized, 1)
    assert.equal(harness.verifiedPaths.length, 0)
    assert.equal(harness.payloads.length, 0)
  })

  it('passes the reviewed root-only incident path into runner readiness', async () => {
    const incidentDir = '/var/lib/xpanel-agent/file-worker-incidents'
    await createProductionAccountFileRunner(binaryPath, { incidentDir })
    assert.equal(harness.constructed[0]?.incidentDir, incidentDir)
    assert.equal(harness.initialized, 1)
  })

  it('connects the daemon recovery callback to the supervised runner', async () => {
    let notified = 0
    const onRecoveryRequired = () => { notified++ }
    await createProductionAccountFileRunner(binaryPath, { onRecoveryRequired })
    assert.equal(harness.constructed[0]?.onRecoveryRequired, onRecoveryRequired)
    await harness.constructed[0]?.onRecoveryRequired?.()
    assert.equal(notified, 1)
  })

  it('does not construct or invoke a runner after helper identity verification fails', async () => {
    const failure = new Error('untrusted helper binary')
    harness.verificationFailure = failure
    await assert.rejects(() => createProductionAccountFileRunner(binaryPath), (error) => error === failure)
    assert.deepEqual(harness.verifiedPaths, [binaryPath])
    assert.equal(harness.constructed.length, 0)
    assert.equal(harness.payloads.length, 0)
  })

  it.each([0, 999, 65_534, -1, 29101.5, Number.NaN])('refuses invalid account UID %s before process execution', async (uid) => {
    const runner = await createProductionAccountFileRunner(binaryPath)
    assert.ok(runner)
    await assert.rejects(() => runner.run({ ...context, account: { ...account, uid } }, { op: 'list', path: 'public_html', showHidden: false }), code('VALIDATION'))
    assert.equal(harness.payloads.length, 0)
  })

  it('rejects successful telemetry from another cgroup through the factory-created runner', async () => {
    harness.helperCgroup = '/user.slice'
    const runner = await createProductionAccountFileRunner(binaryPath)
    assert.ok(runner)
    await assert.rejects(() => runner.run(context, { op: 'list', path: 'public_html', showHidden: false }), code('CONFIG_TEST_FAILED'))
    assert.equal(harness.payloads.length, 1)
    assert.equal(runner.observations.length, 0)
  })

  it.each([
    { errno: 2, errnoName: 'ENOENT' },
    { errno: 13, errnoName: 'EACCES' },
    { errno: 1, errnoName: 'EPERM' },
  ])('propagates helper cgroup refusal $errnoName without a tenant filesystem fallback', async (error) => {
    const fixture = await mkdtemp(join(tmpdir(), 'xpanel-production-files-'))
    try {
      const sentinel = join(fixture, 'sentinel.txt')
      await writeFile(sentinel, 'unchanged-tenant-data')
      harness.helperError = error
      const runner = await createProductionAccountFileRunner(binaryPath)
      assert.ok(runner)
      const manager = new JailedFileManager(fixture, 512, { account, runner })
      await assert.rejects(() => manager.writeText('sentinel.txt', 'must-not-write'), code('PRECONDITION_FAILED'))
      assert.equal(harness.payloads.length, 1)
      assert.equal(harness.payloads[0]?.context.requireCgroup, true)
      assert.equal(await readFile(sentinel, 'utf8'), 'unchanged-tenant-data')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
