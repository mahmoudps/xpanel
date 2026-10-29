import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderedFile } from '@xpanel/core'
import { createConfigurationRepairProvider, readRetainedConfigurationRepairs } from './ops-configuration-repair.ts'
import type { ConfigurationFileMeta, ConfigurationRepairPorts } from './ops-configuration-repair.ts'
import { sha256Text } from './reconciler-journal.ts'
import type { ConfigurationHealthTarget } from './configuration-health.ts'

const PATH = '/etc/nginx/conf.d/xpanel.conf'
const GOOD = 'server { listen 80; }\n', DRIFT = 'server { listen 8080; }\n'
const meta: ConfigurationFileMeta = { mode: 0o644, owner: 'root', group: 'root' }
let base = ''
const harness = (overrides: Partial<ConfigurationRepairPorts> = {}, initial: string | null = DRIFT) => {
  const files = new Map<string, { content: string; meta: ConfigurationFileMeta }>()
  if (initial !== null) files.set(PATH, { content: initial, meta })
  const events: string[] = []
  const ports: ConfigurationRepairPorts = {
    lease: async work => { events.push('lease'); try { return await work() } finally { events.push('release') } },
    manifestEntry: async (generationId, path) => generationId === 7 && path === PATH ? { path, sha256: sha256Text(GOOD), mode: 0o644, owner: 'root', group: 'root', sizeBytes: GOOD.length, logicalOwner: 'server', service: 'nginx', dependentUnits: ['nginx.service'] } : null,
    renderFiles: async () => [{ path: PATH, content: GOOD, mode: 0o644, owner: 'root', group: 'root' }, { path: '/etc/other', content: 'x', mode: 0o644 }],
    readFile: async path => files.get(path)?.content ?? null,
    readMeta: async path => files.get(path)?.meta ?? null,
    writeFile: vi.fn(async (file: RenderedFile) => { events.push('write:' + sha256Text(file.content).slice(0, 6)); files.set(file.path, { content: file.content, meta: { mode: file.mode, owner: file.owner ?? 'root', group: file.group ?? 'root' } }) }),
    removeFile: vi.fn(async path => { events.push('remove'); files.delete(path) }),
    runTests: vi.fn(async () => true),
    reloadUnit: vi.fn(async unit => { events.push('reload:' + unit); return true }),
    recoveryDir: join(base, 'recovery'),
    ...overrides,
  }
  return { ports, files, events, provider: createConfigurationRepairProvider(ports) }
}
const target = (observed: string | null = DRIFT): ConfigurationHealthTarget => ({ token: 'a'.repeat(64), path: PATH, reason: observed === null ? 'missing' : 'content_mismatch', expectedChecksum: sha256Text(GOOD), observedChecksum: observed === null ? null : sha256Text(observed) })
const run = (h: ReturnType<typeof harness>, input: Partial<{ target: ConfigurationHealthTarget; authorize: () => Promise<void> }> = {}) =>
  h.provider.withLease(assertHeld => h.provider.repairTarget({ generation: { id: 7, checksum: 'c'.repeat(64) }, desired: { revision: 3, checksum: 'd'.repeat(64) }, target: input.target ?? target(), authorize: input.authorize ?? (async () => {}), assertHeld }))

beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'xpanel-ops-config-')) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('targeted configuration repair provider', () => {
  it('rewrites one owned file to its generation bytes, reloads its units and leaves no record', async () => {
    const h = harness()
    expect(await run(h)).toEqual({ recoveryVerified: true })
    expect(h.files.get(PATH)!.content).toBe(GOOD)
    expect(h.events).toEqual(['lease', 'write:' + sha256Text(GOOD).slice(0, 6), 'reload:nginx.service', 'release'])
    expect(await readRetainedConfigurationRepairs(h.ports)).toEqual([])
  })
  it('recreates a missing file and removes it again if the tests fail', async () => {
    const ok = harness({}, null)
    expect(await run(ok, { target: target(null) })).toEqual({ recoveryVerified: true })
    const failed = harness({ runTests: async () => false }, null)
    await expect(run(failed, { target: target(null) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, rolledBack: true } })
    expect(failed.files.has(PATH)).toBe(false)
    expect(await readRetainedConfigurationRepairs(failed.ports)).toEqual([])
  })
  it('restores the exact preimage when a check, reload or authority fails after the write', async () => {
    for (const overrides of [{ runTests: async () => false }, { reloadUnit: async () => false }] as Partial<ConfigurationRepairPorts>[]) {
      const h = harness(overrides)
      await expect(run(h)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { rolledBack: overrides.reloadUnit ? false : true } })
      expect(h.files.get(PATH)!.content).toBe(DRIFT)
    }
    let calls = 0
    const revoked = harness()
    await expect(run(revoked, { authorize: async () => { if (++calls > 2) throw new Error('root revoked') } })).rejects.toMatchObject({ detail: { rolledBack: true } })
    expect(revoked.files.get(PATH)!.content).toBe(DRIFT)
  })
  it('keeps a durable record when the rollback cannot be verified and refuses later repairs until it settles', async () => {
    const h = harness({ runTests: async () => false })
    h.ports.writeFile = vi.fn(async (file: RenderedFile) => { if (file.content === DRIFT) throw new Error('disk full'); h.files.set(file.path, { content: file.content, meta }) })
    await expect(run(h)).rejects.toMatchObject({ detail: { rolledBack: false, verificationRequired: true } })
    const [record] = await readRetainedConfigurationRepairs(h.ports)
    expect(record).toMatchObject({ path: PATH, existed: true, preimage: DRIFT, state: 'rollback_failed' })
    h.files.set(PATH, { content: 'operator edit\n', meta })
    h.ports.runTests = async () => true
    h.ports.writeFile = vi.fn(async () => { throw new Error('must not write') })
    const later = { ...h, provider: createConfigurationRepairProvider(h.ports) }
    await expect(run(later, { target: target('operator edit\n') })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    // Once the file holds its generation bytes again the record is settled and removed.
    h.files.set(PATH, { content: GOOD, meta })
    await expect(run(later, { target: target(DRIFT) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readdir(join(h.ports.recoveryDir, 'configuration'))).toEqual([])
    expect(h.ports.writeFile).not.toHaveBeenCalled()
  })
  it('refuses unowned targets, pending renders and a file that changed since observation without writing', async () => {
    const pending = harness({ renderFiles: async () => [{ path: PATH, content: 'other', mode: 0o644, owner: 'root', group: 'root' }] })
    await expect(run(pending)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    const moved = harness()
    await expect(run(moved, { target: { ...target(), path: '/etc/passwd' } })).rejects.toMatchObject({ code: 'CONFLICT' })
    const changed = harness({}, 'third version\n')
    await expect(run(changed)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    for (const h of [pending, moved, changed]) expect(h.ports.writeFile).not.toHaveBeenCalled()
    await mkdir(join(base, 'recovery'), { recursive: true }); await writeFile(join(base, 'recovery', 'unrelated'), '')
  })
  it('stops when the lease assertion fails after release', async () => {
    const h = harness()
    let held: (() => Promise<void>) | null = null
    await h.provider.withLease(async assertHeld => { held = assertHeld })
    await expect(held!()).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('configuration health route with the physical provider', () => {
  it('repairs the observed drift end to end and proves the follow-up observation is clean', async () => {
    const { handleConfigurationHealthRoute, readConfigurationHealth } = await import('./configuration-health.ts')
    const h = harness(), test = { name: 'nginx', argv: ['/usr/sbin/nginx', '-t', '-q'] }, checksum = 'c'.repeat(64), state = 'b'.repeat(64)
    const manifest = { schemaVersion: 1 as const, generationId: 7, filesChecksum: checksum, stateChecksum: state, createdAt: '2026-10-27T00:00:00.000Z', actor: 'root', files: [{ path: PATH, sha256: sha256Text(GOOD), mode: 0o644, owner: 'root', group: 'root', sizeBytes: GOOD.length, logicalOwner: 'server', service: 'nginx', dependentUnits: ['nginx.service'] }], managedUnits: ['nginx.service'], testResults: [{ ...test, ok: true, code: 0, testedConfigChecksum: checksum, at: '2026-10-27T00:00:00.000Z' }] }
    const audit: string[] = []
    const ctx = {
      assertRoot: async () => ({ actor: 'root' }), readGeneration: async () => ({ id: 7, checksum, manifest }), readDesired: async () => ({ revision: 2, checksum: state }),
      readDrift: async () => { const content = h.files.get(PATH)?.content ?? null; const items = content === GOOD ? [] : [{ path: PATH, reason: content === null ? 'missing' as const : 'content_mismatch' as const, expectedSha256: sha256Text(GOOD), observedSha256: content === null ? null : sha256Text(content), expectedMeta: meta }]; return { hasDrift: items.length > 0, manifestMissing: false, generationId: 7, items } },
      reviewedTests: [test], runTest: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }), repair: h.provider, audit: async (entry: { action: string }) => { audit.push(entry.action) },
    }
    const view = await readConfigurationHealth(ctx)
    expect(view).toMatchObject({ canRepair: true, repairReason: 'ready' })
    const body = { target: view.targets[0]!.token, expectedRevision: view.revision, expectedGenerationId: 7, expectedGenerationChecksum: checksum, confirmation: 'REPAIR CONFIGURATION' }
    const request = new Request('http://agent/host/configuration-health/repair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const response = await handleConfigurationHealthRoute(request, new URL(request.url), 'POST', ctx)
    expect(await response!.json()).toMatchObject({ outcome: 'verified', recoveryVerified: true, verificationRequired: false, view: { drift: 'clean', targets: [] } })
    expect(audit).toEqual(['configuration.health.repair.requested', 'configuration.health.repair.verified'])
    expect(h.files.get(PATH)!.content).toBe(GOOD)
  })
})

describe('native configuration metadata helpers', () => {
  it('maps passwd and group ids to their first names and ignores malformed rows', async () => {
    const { idNames } = await import('./ops-configuration-repair.ts')
    expect([...idNames('root:x:0:0:root:/root:/bin/bash\ntoor:x:0:0::/:/bin/sh\nwww-data:x:33:33::/var/www:/usr/sbin/nologin\n#comment\nbad line\nx:x:-1:\n')]).toEqual([[0, 'root'], [33, 'www-data']])
  })
})
