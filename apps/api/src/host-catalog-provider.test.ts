import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_PROBES } from '../../../packages/catalog/src/host-qualification.ts'
import { specs } from '../../../packages/catalog/src/data/index.ts'
import type { CapabilityEvidence } from '@xpanel/catalog'
import { loadTrustedEvidenceBundle } from '../../../scripts/evidence/runtime.mjs'
import { createQualifiedCatalogProvider, type HostCatalogSource, type TrustedAcceptanceOptions } from './host-catalog.ts'

vi.mock('../../../scripts/evidence/runtime.mjs', () => ({ loadTrustedEvidenceBundle: vi.fn() }))
const loader = vi.mocked(loadTrustedEvidenceBundle)
const target = { sourceFingerprint: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), supportedProfiles: ['unit-profile'] }
const acceptance = specs.find(spec => spec.id === 'server-information')!.acceptance
const options: TrustedAcceptanceOptions = { path: '/protected/acceptance.json', expectedSha256: 'c'.repeat(64), expectedTarget: target,
  expectedRequirements: [{ toolId: 'server-information', acceptance, checks: { unit: ['unit:metrics'], http: ['http:metrics'], browser: ['browser:metrics'], linux: ['linux:metrics'], external: ['external:metrics'] } }] }
// Synthetic already-verified loader boundary: this is not an operational qualification bundle.
const evidence: CapabilityEvidence[] = (['implemented', 'integrated', 'verified'] as const).flatMap(stage =>
  (stage === 'implemented' ? ['unit'] as const : stage === 'integrated' ? ['http', 'browser'] as const : ['linux', 'browser', 'external'] as const).map(environment => ({
    toolId: 'server-information', acceptance, stage, environment, result: 'passed' as const, ...target, profile: 'unit-profile', executor: 'real' as const,
    runArtifact: 'synthetic.receipt.json', runArtifactSha256: 'd'.repeat(64), observedAt: '2026-10-30T00:00:00Z',
  })))
const healthy = { executor: 'linux', probes: Object.fromEntries(HOST_PROBES.map(id => [id, 'passed'])) }
const source = (body: unknown = healthy): HostCatalogSource => ({ token: 'test-agent', identity: {}, fetch: vi.fn(async () => Response.json(body)) })
const status = (tools: Awaited<ReturnType<ReturnType<typeof createQualifiedCatalogProvider>['load']>>) => tools.find(tool => tool.id === 'server-information')!.status
beforeEach(() => {
  loader.mockReset()
  loader.mockReturnValue({
    target, evidence, requirements: options.expectedRequirements,
    source: {
      algorithm: 'xpanel-executable-inputs-v1', commit: '1'.repeat(40), tree: '2'.repeat(40), dirty: false,
      sourceFingerprint: target.sourceFingerprint, node: '26.12.1', lockfileSha256: '3'.repeat(64),
      files: [{ path: 'pnpm-lock.yaml', bytes: 4, sha256: '3'.repeat(64) }],
    },
  })
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('trusted acceptance catalog provider', () => {
  it('never manufactures acceptance from healthy host probes or missing configuration', async () => {
    const provider = createQualifiedCatalogProvider()
    expect(status(await provider.load(source()))).toBe('researched')
    expect(loader).not.toHaveBeenCalled()
  })
  it('loads the separately pinned target and requirements once and freezes the accepted snapshot', async () => {
    const provider = createQualifiedCatalogProvider(options)
    const result = await provider.load(source())
    expect(loader).toHaveBeenCalledExactlyOnceWith(options)
    expect(status(result)).toBe('verified')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result[0]!.delivery)).toBe(true)
    expect(result.filter(tool => tool.status === 'verified').map(tool => tool.id)).toEqual(['server-information'])
  })
  it.each(['fake', 'unknown'])('does not accept a %s executor', async executor => {
    expect(status(await createQualifiedCatalogProvider(options).load(source({ ...healthy, executor })))).toBe('researched')
  })
  it('closes null/off/network/HTTP/malformed and missing-probe reports without losing acceptance', async () => {
    const provider = createQualifiedCatalogProvider(options)
    expect(status(await provider.load(null))).toBe('researched')
    vi.stubEnv('XPANEL_HOST_QUALIFICATION', 'off')
    expect(status(await provider.load(source()))).toBe('researched')
    vi.stubEnv('XPANEL_HOST_QUALIFICATION', 'on')
    for (const fetch of [async () => { throw new Error('offline') }, async () => new Response('', { status: 503 }), async () => new Response('bad'), async () => Response.json({ executor: 'linux', probes: {} })]) {
      expect(status(await provider.load({ token: 'test-agent', fetch }))).toBe('researched')
    }
    expect(status(await provider.load(source()))).toBe('verified')
    expect(loader).toHaveBeenCalledTimes(1)
  })
  it('isolates identical credentials across agent identities and acceptance provider instances', async () => {
    const provider = createQualifiedCatalogProvider(options), good = source(), bad = source({ executor: 'fake', probes: healthy.probes })
    expect(status(await provider.load(good))).toBe('verified')
    expect(status(await provider.load(bad))).toBe('researched')
    const second = createQualifiedCatalogProvider({ ...options, expectedSha256: 'e'.repeat(64) })
    expect(second.acceptanceIdentity).not.toBe(provider.acceptanceIdentity)
    expect(status(await second.load(bad))).toBe('researched')
  })
  it('invalidates changed fetch and credential connections and rebuilds from original acceptance after reset', async () => {
    const provider = createQualifiedCatalogProvider(options), agent = source()
    expect(status(await provider.load(agent))).toBe('verified')
    agent.fetch = async () => Response.json({ executor: 'fake', probes: healthy.probes })
    expect(status(await provider.load(agent))).toBe('researched')
    agent.fetch = async () => Response.json(healthy)
    agent.token = 'new-agent-token'
    provider.reset()
    expect(status(await provider.load(agent))).toBe('verified')
  })
  it('invalidates readiness after qualification mode changes', async () => {
    const provider = createQualifiedCatalogProvider(options), agent = source()
    expect(status(await provider.load(agent))).toBe('verified')
    vi.stubEnv('XPANEL_HOST_QUALIFICATION', 'off')
    expect(status(await provider.load(agent))).toBe('researched')
    vi.stubEnv('XPANEL_HOST_QUALIFICATION', 'on')
    await provider.load(agent)
    expect(agent.fetch).toHaveBeenCalledTimes(2)
  })
  it('refuses invalid configured evidence before returning a provider', () => {
    loader.mockImplementation(() => { throw new Error('untrusted evidence') })
    expect(() => createQualifiedCatalogProvider(options)).toThrow('untrusted evidence')
  })
})
