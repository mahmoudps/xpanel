import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAction, RenderedFile } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import type { StateStore } from '@xpanel/state'
import type { AgentExecutor } from './executor.ts'
import { buildGenerationManifest, HostReconciler, retainEmptyManagedDnsCatalog, runGenerationDnsHook, sha256Text, type CompiledGeneration, type ReconcileJournalRecord } from './reconciler.ts'

const dbPorts = vi.hoisted(() => ({ rollback: vi.fn(), audit: vi.fn() }))
vi.mock('@xpanel/db', async importOriginal => ({ ...await importOriginal<typeof import('@xpanel/db')>(),
  markGenerationRolledBack: dbPorts.rollback, appendAudit: dbPorts.audit,
}))

beforeEach(() => {
  vi.clearAllMocks()
  dbPorts.rollback.mockResolvedValue({ rolledBack: { id: 2, status: 'rolled_back' }, active: { id: 1, status: 'active' } })
  dbPorts.audit.mockResolvedValue({ id: 'audit', at: '2026-10-29T00:00:00Z' })
})

const zonePath = '/var/lib/powerdns/zones/example.test.zone'
const catalogPath = '/etc/powerdns/named.conf.xpanel-zones'
const file = (path: string, content = 'exact candidate bytes\n'): RenderedFile => ({ path, content, mode: 0o644, owner: 'root', group: 'root' })
const compiled = (files: RenderedFile[] = []): CompiledGeneration => ({
  stateChecksum: 'state', files, tests: [], preActions: [], postActions: [], terminatingAccounts: [],
  localMail: false, localMailOptions: {},
})

const rollbackFixture = (observationFails = false) => {
  const events: string[] = []
  const files = new Map([[catalogPath, file(catalogPath, 'candidate bytes\n')]])
  const unexpected = async (): Promise<never> => { throw new Error('unexpected executor port') }
  const executor: AgentExecutor & { files: Map<string, RenderedFile> } = {
    files, preflight: unexpected, runTest: unexpected, runCommand: unexpected, readSliceMetrics: unexpected,
    readFile: async path => files.get(path)?.content ?? null,
    writeFile: async entry => { events.push(`restore:${entry.path}`); files.set(entry.path, entry) },
    removePath: async path => { events.push(`remove:${path}`); files.delete(path) },
    runAction: async (action: HostAction) => {
      if (action.kind === 'exec' && action.argv[0] === '/usr/bin/pdns_control' && ['rediscover', 'reload'].includes(action.argv[1] ?? '')) {
        events.push(`dns:${action.argv[1]}`)
      } else if (action.kind === 'systemd' && action.unit === 'nginx.service' && action.verb === 'reload') {
        events.push('nginx:reload')
      } else throw new Error('unexpected rollback action')
    },
  }
  const provider = {
    validate: vi.fn(async () => { throw new Error('candidate stopped pdns; current-config cannot answer') }),
    verify: vi.fn(async (_files: readonly RenderedFile[], _removed: readonly string[]) => {
      events.push('dns:verify')
      expect(files.get(catalogPath)?.content).toBe('// previous empty catalog\n')
      if (observationFails) throw new Error('restored DNS could not be observed')
    }),
  }
  const reconciler = new HostReconciler({ executor, dnsPublication: provider,
    store: { rootDir: '/unused-port-fixture' } as StateStore, db: {} as Db,
    os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'), healthProbe: async () => ({ ok: true }) })
  const save = vi.spyOn(reconciler.journal, 'saveJournal').mockResolvedValue(undefined)
  vi.spyOn(reconciler.journal, 'cleanupStagingDir').mockResolvedValue(undefined)
  const manifest = buildGenerationManifest({ generationId: 2, stateChecksum: 'state', filesChecksum: 'files', actor: 'root',
    files: [file(catalogPath)], postActions: [], os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n') })
  const journal: ReconcileJournalRecord = {
    schemaVersion: 1, journalId: 'journal', generationId: 2, previousActiveGenerationId: 1,
    actor: 'root', stateChecksum: 'state', filesChecksum: 'files', phase: 'verify', startedAt: '', updatedAt: '',
    candidateManifest: manifest, previousManifest: null,
    diff: { added: [], updated: [], unchanged: [], removed: [], removedUnits: [], affectedServices: [] },
    previousFilesBackup: [{ path: catalogPath, content: '// previous empty catalog\n', sha256: sha256Text('// previous empty catalog\n'), existed: true, mode: 0o644, owner: 'root', group: 'root' }],
    completedPreActions: 0, preActionsNeedVerification: false, switchedFilePaths: [catalogPath], removedFilePaths: [],
    stoppedObsoleteUnits: [], completedPostActions: 0, reloadedUnits: ['nginx.service'], verifiedUnits: [], error: null,
  }
  const rollback = () => (reconciler as unknown as { rollbackLiveHostAndRecord(record: ReconcileJournalRecord, unit: string, error: string,
    scope: { accountId: null }): Promise<{ verificationRequired: boolean }> }).rollbackLiveHostAndRecord(journal, 'pdns', 'candidate reload failed', { accountId: null })
  return { events, files, provider, journal, save, rollback }
}

describe('generation-owned DNS publication boundary', { tags: ['unit'] }, () => {
  it('retains a valid empty managed catalog and reload commands when the final owned zone is removed', () => {
    const candidate = compiled()
    retainEmptyManagedDnsCatalog(candidate, [zonePath, catalogPath])
    expect(candidate.files).toEqual([file(catalogPath, '// Managed by xPanel: PowerDNS BIND zone catalog\n')])
    expect(candidate.postActions).toEqual([
      { kind: 'exec', argv: ['/usr/bin/pdns_control', 'rediscover'] },
      { kind: 'exec', argv: ['/usr/bin/pdns_control', 'reload'] },
    ])
    retainEmptyManagedDnsCatalog(candidate, [zonePath, catalogPath])
    expect(candidate.files).toHaveLength(1)
    expect(candidate.postActions).toHaveLength(2)
  })

  it('does not introduce a DNS requirement on a host whose generations never owned DNS', () => {
    const candidate = compiled([file('/etc/nginx/nginx.conf')])
    retainEmptyManagedDnsCatalog(candidate, ['/etc/nginx/nginx.conf'])
    expect(candidate.files.map(entry => entry.path)).toEqual(['/etc/nginx/nginx.conf'])
    expect(candidate.postActions).toEqual([])
  })

  it('preserves exact current catalog bytes and existing generation commands', () => {
    const catalog = file(catalogPath, 'zone "example.test" { type master; };\n')
    const candidate = compiled([catalog, file(zonePath)])
    candidate.postActions.push({ kind: 'systemd-daemon-reload' })
    retainEmptyManagedDnsCatalog(candidate, [zonePath])
    expect(candidate.files[0]).toBe(catalog)
    expect(candidate.postActions).toEqual([{ kind: 'systemd-daemon-reload' }])
  })

  it('recognizes configured zone storage without treating unrelated .zone files as managed DNS', () => {
    const unrelated = compiled()
    retainEmptyManagedDnsCatalog(unrelated, ['/home/tenant/archive.zone'])
    expect(unrelated.files).toEqual([])
    const configured = compiled()
    retainEmptyManagedDnsCatalog(configured, ['/srv/pdns-zones/example.test.zone'], '/srv/pdns-zones')
    expect(configured.files[0]?.path).toBe(catalogPath)
  })

  it('classifies the managed catalog as PowerDNS-owned for manifest and rollback dependencies', () => {
    const manifest = buildGenerationManifest({ generationId: 1, stateChecksum: 'state', filesChecksum: 'files',
      actor: 'root', files: [file(catalogPath)], postActions: [], os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n') })
    expect(manifest.files[0]).toMatchObject({ service: 'powerdns', dependentUnits: ['pdns.service'] })
    expect(manifest.managedUnits).not.toContain('pdns.service')
  })

  it('refuses native zone validation without a connected provider before any publication', async () => {
    await expect(runGenerationDnsHook({ phase: 'validate', native: true, provider: undefined, files: [file(zonePath)], removedPaths: [] }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, reason: 'dns_reconciliation_provider_not_connected' } })
  })

  it('includes deletion-only DNS changes in native provider admission', async () => {
    await expect(runGenerationDnsHook({ phase: 'validate', native: true, provider: undefined, files: [], removedPaths: [zonePath] }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('requires observation for an empty managed catalog even with no zone files', async () => {
    await expect(runGenerationDnsHook({ phase: 'verify', native: true, provider: undefined, files: [file(catalogPath)], removedPaths: [] }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
  })

  it('leaves unrelated native generations independent of DNS availability', async () => {
    const provider = { validate: vi.fn(async (_files: readonly RenderedFile[], _removedPaths: readonly string[]) => undefined),
      verify: vi.fn(async (_files: readonly RenderedFile[], _removedPaths: readonly string[]) => undefined) }
    await runGenerationDnsHook({ phase: 'validate', native: true, provider, files: [file('/etc/nginx/nginx.conf')], removedPaths: ['/home/tenant/archive.zone'] })
    expect(provider.validate).not.toHaveBeenCalled()
  })

  it('permits modeled fixtures to omit the native provider without creating qualification evidence', async () => {
    await expect(runGenerationDnsHook({ phase: 'validate', native: false, provider: undefined, files: [file(zonePath)], removedPaths: [] })).resolves.toBeUndefined()
  })

  it('passes exact generation bytes and removed identities to validation and observation without republishing', async () => {
    const files = [file(catalogPath), file(zonePath, 'exact staged SOA and RRset bytes\n')]
    const removedPaths = ['/var/lib/powerdns/zones/removed.test.zone']
    const provider = { validate: vi.fn(async (_files: readonly RenderedFile[], _removedPaths: readonly string[]) => undefined),
      verify: vi.fn(async (_files: readonly RenderedFile[], _removedPaths: readonly string[]) => undefined) }
    await runGenerationDnsHook({ phase: 'validate', native: true, provider, files, removedPaths })
    await runGenerationDnsHook({ phase: 'verify', native: true, provider, files, removedPaths })
    expect(provider.validate.mock.calls[0]?.[0]).toBe(files)
    expect(provider.verify.mock.calls[0]?.[0]).toBe(files)
    expect(provider.verify.mock.calls[0]?.[1]).toBe(removedPaths)
    expect(files[1]?.content).toBe('exact staged SOA and RRset bytes\n')
  })

  it('propagates backend or authoritative observation failure rather than treating local bytes as success', async () => {
    const provider = { validate: vi.fn(async () => { throw new Error('wrong effective backend') }), verify: vi.fn(async () => { throw new Error('served serial differs') }) }
    await expect(runGenerationDnsHook({ phase: 'validate', native: true, provider, files: [file(zonePath)], removedPaths: [] })).rejects.toThrow('wrong effective backend')
    await expect(runGenerationDnsHook({ phase: 'verify', native: true, provider, files: [file(zonePath)], removedPaths: [] })).rejects.toThrow('served serial differs')
  })

  it('restores captured DNS bytes before requiring the failed daemon and rediscovers DNS despite unrelated reload bookkeeping', async () => {
    const fixture = rollbackFixture()
    await expect(fixture.rollback()).resolves.toMatchObject({ verificationRequired: false })
    expect(fixture.provider.validate).not.toHaveBeenCalled()
    expect(fixture.events.indexOf(`restore:${catalogPath}`)).toBeLessThan(fixture.events.indexOf('dns:rediscover'))
    expect(fixture.events.indexOf('dns:rediscover')).toBeLessThan(fixture.events.indexOf('dns:reload'))
    expect(fixture.events.indexOf('dns:reload')).toBeLessThan(fixture.events.indexOf('dns:verify'))
    expect(dbPorts.rollback).toHaveBeenCalledTimes(1)
  })

  it('retains restored bytes and operator attention when authoritative recovery observation fails', async () => {
    const fixture = rollbackFixture(true)
    await expect(fixture.rollback()).rejects.toThrow('restored DNS could not be observed')
    expect(fixture.files.get(catalogPath)?.content).toBe('// previous empty catalog\n')
    expect(fixture.journal.phase).toBe('needs_attention')
    expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'needs_attention' }))
    expect(dbPorts.rollback).not.toHaveBeenCalled()
  })

  it('refuses a corrupt captured DNS backup without overwriting live bytes or claiming recovery', async () => {
    const fixture = rollbackFixture()
    fixture.journal.previousFilesBackup[0]!.sha256 = '0'.repeat(64)
    await expect(fixture.rollback()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(fixture.files.get(catalogPath)?.content).toBe('candidate bytes\n')
    expect(fixture.journal.phase).toBe('needs_attention')
    expect(fixture.provider.verify).not.toHaveBeenCalled()
    expect(dbPorts.rollback).not.toHaveBeenCalled()
  })
})
