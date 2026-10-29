import { basename } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createUpgrade, listAudit } from '@xpanel/db'
import { runUpgrade } from '@xpanel/lifecycle'
import type { UpgradePorts, UpgradeResult } from '@xpanel/lifecycle'
import { FakeClock, FakeFs, MemoryAudit } from '../../../packages/lifecycle/src/testing/fakes.ts'
import { verifyReleaseArtifactSignature } from './lifecycle/upgrade-runner.ts'
import { createUpgradeFixture } from './upgrade-observation-fixture.ts'
import type { UpgradeFixture } from './upgrade-observation-fixture.ts'
import { loadTrustedReleaseKeys } from './upgrade-observation.ts'
import { handleUpgradeRoute } from './upgrade-routes.ts'
import { DurableUpgradeCoordinator } from './upgrade-coordinator.ts'
import type { UpgradeCaller, UpgradeCoordinator, UpgradeHandoff, UpgradeRouteContext } from './upgrade-routes.ts'

const ROOT: UpgradeCaller = { principalId: '00000000-0000-4000-8000-000000000001', actor: 'root', role: 'root' }
let f: UpgradeFixture
beforeEach(async () => { f = await createUpgradeFixture(); await f.stage('1.1.0') })
afterEach(async () => { await f.close() })

const context = (extra: Partial<UpgradeRouteContext> = {}): UpgradeRouteContext => ({
  db: f.db.db, caller: ROOT, authenticate: async () => ROOT,
  assertRootCaller: async (caller, target) => { if (caller.role !== 'root') fail('FORBIDDEN', `root role is required for ${target}`) },
  observation: { fs: f.fs, layout: f.layout, keysPath: f.keysPath, osReleasePath: f.osReleasePath, now: () => new Date('2026-10-27T10:00:00.000Z') },
  ...extra,
})
const call = (path: string, method = 'GET', body?: unknown, ctx = context()) => handleUpgradeRoute(
  new Request('http://agent.local' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://agent.local' + path), method, ctx)
const observed = async (ctx = context()) => (await (await call('/host/upgrade', 'GET', undefined, ctx))!.json()) as { revision: string; availability: { start: { reasons: string[] } } }

/** Stand-in for the native coordinator: re-verifies, then runs the real machine whose own lock gate decides. */
const machineCoordinator = (results: UpgradeResult[], handoffs: UpgradeHandoff[]): UpgradeCoordinator => ({
  async start(input) {
    handoffs.push(input)
    verifyReleaseArtifactSignature(input.manifest, (await loadTrustedReleaseKeys({ fs: f.fs, path: f.keysPath })).keys)
    const fs = new FakeFs({ '/opt/xpanel/current': { type: 'symlink', target: '/opt/xpanel/releases/1.0.0' }, '/var/lib/xpanel/upgrade.lock': { type: 'file', content: '{"state":"running","recordId":null,"actor":"root","to":"1.1.0","at":"x"}', mode: 0o600 } })
    const ports = { safety: { withExclusive: async <T>(callback: () => Promise<T>) => callback() }, fs, clock: new FakeClock(), audit: new MemoryAudit() } as unknown as UpgradePorts
    const result = await runUpgrade(ports, { actor: input.actor, os: { family: 'debian' }, release: { ...input.release, archivePath: '/opt/xpanel/downloads/' + basename(input.release.archivePath) }, canary: null })
    results.push(result)
    return { upgradeId: result.recordId }
  },
})

describe('agent upgrade routes', () => {
  it('exposes the explicit native provider hold even when a bootstrap coordinator is composed', async () => {
    const c = new DurableUpgradeCoordinator({ db: f.db.db, observation: f.deps() }), ctx = context({ coordinator: c })
    const view = await observed(ctx)
    expect(view.availability.start.reasons).toEqual(expect.arrayContaining(['upgrade-coordinator-unavailable', 'upgrade-native-provider-unqualified', 'upgrade-hosted-uid-unqualified']))
    await expect(call('/host/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: view.revision, confirm: 'upgrade 1.1.0' }, ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('serves the observation and status only to root, without selectors', async () => {
    const response = (await call('/host/upgrade'))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ current: { version: '1.0.0' }, availability: { candidates: ['1.1.0'] } })
    await expect(call('/host/upgrade', 'GET', undefined, context({ caller: { ...ROOT, role: 'user' } }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/host/upgrade?freeBytes=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/host/upgrade', 'POST'))!.status).toBe(405)
    expect(await call('/host/other')).toBeNull()
    await createUpgrade(f.db.db, { fromVersion: '1.0.0', toVersion: '1.1.0', actor: 'root', fromSchemaVersion: 1 })
    const status = await (await call('/host/upgrade/status'))!.json() as { latest: { toVersion: string; status: string }; history: unknown[] }
    expect(status.latest).toMatchObject({ toVersion: '1.1.0', status: 'pending' })
    expect(status.history).toHaveLength(1)
  })

  it('runs preflight over observed host values only and rejects caller-supplied evidence', async () => {
    const { revision } = await observed()
    for (const field of ['freeBytes', 'os', 'currentVersion', 'schemaVersions', 'releaseBytes', 'activeTransfers', 'dryRun']) {
      await expect(call('/host/upgrade/preflight', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, [field]: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    const result = await (await call('/host/upgrade/preflight', 'POST', { targetVersion: '1.1.0', expectedRevision: revision }))!.json() as { report: { ok: boolean; checks: { id: string; ok: boolean; detail: Record<string, unknown> }[] }; start: { enabled: boolean; reasons: string[] } }
    expect(result.report.ok).toBe(true)
    const detail = Object.fromEntries(result.report.checks.map(check => [check.id, check.detail]))
    expect(detail['disk-space']).toMatchObject({ free: 50 * 1024 ** 3, release: 100 * 1024 * 1024 })
    expect(detail['os-supported']).toMatchObject({ id: 'ubuntu', versionId: '24.04' })
    expect(detail['version-newer']).toEqual({ current: '1.0.0', target: '1.1.0' })
    expect(detail['schema-compatible']).toEqual({ current: f.db.migration.version, target: f.db.migration.version + 1 })
    expect(result.start).toEqual({ enabled: false, reasons: ['upgrade-coordinator-unavailable'] })
    f.free.bytes = 1024
    const low = await (await call('/host/upgrade/preflight', 'POST', { targetVersion: '1.1.0', expectedRevision: revision }))!.json() as { report: { ok: boolean; checks: { id: string; ok: boolean }[] } }
    expect(low.report.ok).toBe(false)
    expect(low.report.checks.find(check => check.id === 'disk-space')!.ok).toBe(false)
  })

  it('returns 409 for a stale revision and 412 for an unverified target', async () => {
    const { revision } = await observed()
    await expect(call('/host/upgrade/preflight', 'POST', { targetVersion: '1.1.0', expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'revision-changed', revision } })
    await expect(call('/host/upgrade/preflight', 'POST', { targetVersion: '9.9.9', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reasons: ['staged-release-not-verified'] } })
    await f.writeKeys({ schemaVersion: 1, keys: [] })
    const untrusted = await observed()
    await expect(call('/host/upgrade/preflight', 'POST', { targetVersion: '1.1.0', expectedRevision: untrusted.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reasons: ['no-trusted-release-keys'] } })
  })

  it('refuses start without a coordinator, a passing preflight or the exact confirmation', async () => {
    const { revision } = await observed()
    await expect(call('/host/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reasons: ['upgrade-coordinator-unavailable'] } })
    const coordinator = { start: vi.fn() }
    const ctx = context({ coordinator })
    const ready = await observed(ctx)
    await expect(call('/host/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: ready.revision, confirm: 'upgrade 1.2.0' }, ctx)).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'confirmation-mismatch' } })
    f.free.bytes = 1024
    await expect(call('/host/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: ready.revision, confirm: 'upgrade 1.1.0' }, ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reasons: ['preflight-failed'] } })
    f.free.bytes = 50 * 1024 ** 3
    await expect(call('/host/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: ready.revision, confirm: 'upgrade 1.1.0' }, context({ coordinator, authenticate: async () => ({ ...ROOT, role: 'user' }) }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(coordinator.start).not.toHaveBeenCalled()
  })

  it('hands the verified release to the coordinator, whose machine keeps its own lock gate', async () => {
    const results: UpgradeResult[] = [], handoffs: UpgradeHandoff[] = []
    const ctx = context({ coordinator: machineCoordinator(results, handoffs) })
    const { revision } = await observed(ctx)
    const response = (await call('/host/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' }, ctx))!
    expect(response.status).toBe(202)
    const body = await response.json() as { accepted: boolean; handoffId: string; upgradeId: string | null; targetVersion: string }
    expect(body).toMatchObject({ accepted: true, targetVersion: '1.1.0', upgradeId: null })
    expect(handoffs[0]).toMatchObject({ handoffId: body.handoffId, actor: { kind: 'root', id: ROOT.principalId, username: 'root' }, release: { version: '1.1.0', bytes: 100 * 1024 * 1024 }, manifest: { version: '1.1.0' } })
    expect(handoffs[0]!.release.sha256).toBe(handoffs[0]!.manifest.sha256)
    expect(results[0]).toMatchObject({ outcome: 'refused', code: 'CONFLICT', reason: 'another upgrade is in progress (lock file present)' })
    const actions = (await listAudit(f.db.db, {})).map(entry => entry.action)
    expect(actions).toEqual(expect.arrayContaining(['upgrade.handoff_requested', 'upgrade.handoff_accepted']))
  })

  it('reports an unconfirmed handoff as an unknown outcome', async () => {
    const ctx = context({ coordinator: { start: async () => { throw new Error('unit start failed') } } })
    const { revision } = await observed(ctx)
    await expect(call('/host/upgrade/start', 'POST', { targetVersion: '1.1.0', expectedRevision: revision, confirm: 'upgrade 1.1.0' }, ctx)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect((await listAudit(f.db.db, {})).map(entry => entry.action)).toContain('upgrade.handoff_failed')
  })
})
