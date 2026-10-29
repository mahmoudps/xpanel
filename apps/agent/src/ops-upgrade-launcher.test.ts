import { describe, expect, it, vi } from 'vitest'
import { createUpgradeLauncherProvider, nativeUpgradeLauncherPorts, upgradeLauncherReadiness } from './ops-upgrade-launcher.ts'
import type { UpgradeLauncherPorts } from './ops-upgrade-launcher.ts'
import type { UpgradeProcessBinding } from './upgrade-coordinator-contract.ts'

const binding: UpgradeProcessBinding = { jobId: '0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11', requestFingerprint: 'a'.repeat(64), referenceCode: 'XP-JOB-2026-000123', workerId: 'upgrade-coordinator-0f9c3c1e-2b9a-4f43-9d55-8f1b7d0b3a11', fencingToken: 7 }
const signature = 'A'.repeat(86) + '=='
const ports = (overrides: Partial<UpgradeLauncherPorts> = {}): UpgradeLauncherPorts => ({
  launcherUnitActive: async () => true,
  pinnedRuntimeReady: async () => true,
  ipcHandshake: async () => ({ workerId: binding.workerId, signature }),
  verifyHandshake: async () => true,
  hostedUidQualified: async () => true,
  launch: async given => ({ accepted: true, binding: given }),
  ...overrides,
})

describe('upgrade launcher readiness', () => {
  it('is available only when every prerequisite and a signed handshake pass', async () => {
    expect(await upgradeLauncherReadiness(ports())).toEqual({ available: true, reasons: [] })
    expect(await upgradeLauncherReadiness(null)).toEqual({ available: false, reasons: ['upgrade-native-provider-unqualified', 'upgrade-hosted-uid-unqualified'] })
  })
  it('reports the precise reason for each missing prerequisite', async () => {
    expect((await upgradeLauncherReadiness(ports({ launcherUnitActive: async () => false }))).reasons).toContain('upgrade-launcher-unit-inactive')
    expect((await upgradeLauncherReadiness(ports({ pinnedRuntimeReady: async () => false }))).reasons).toContain('upgrade-pinned-runtime-unverified')
    expect((await upgradeLauncherReadiness(ports({ hostedUidQualified: async () => false }))).reasons).toContain('upgrade-hosted-uid-unqualified')
    expect((await upgradeLauncherReadiness(ports({ verifyHandshake: async () => false }))).reasons).toEqual(['upgrade-launcher-ipc-unverified'])
    expect((await upgradeLauncherReadiness(ports({ ipcHandshake: async () => ({ workerId: 'bad', signature }) }))).reasons).toEqual(['upgrade-launcher-ipc-unverified'])
    expect((await upgradeLauncherReadiness(ports({ launcherUnitActive: async () => { throw new Error('x') } }))).reasons).toContain('upgrade-launcher-unit-inactive')
  })
  it('passes a fresh nonce to every handshake', async () => {
    const seen = new Set<string>()
    const handshake = vi.fn(async (nonce: string) => { seen.add(nonce); return { workerId: binding.workerId, signature } })
    await upgradeLauncherReadiness(ports({ ipcHandshake: handshake }))
    await upgradeLauncherReadiness(ports({ ipcHandshake: handshake }))
    expect(seen.size).toBe(2)
  })
})

describe('upgrade launcher provider', () => {
  it('launches only after re-proving readiness and a handshake, and returns the exact binding', async () => {
    const launch = vi.fn(async (given: Readonly<UpgradeProcessBinding>) => ({ accepted: true, binding: given }))
    const provider = createUpgradeLauncherProvider(ports({ launch }))
    expect(await provider.launch(binding)).toEqual({ accepted: true, binding })
    expect(launch).toHaveBeenCalledTimes(1)
  })
  it('refuses to launch when a prerequisite is missing', async () => {
    const launch = vi.fn()
    await expect(createUpgradeLauncherProvider(ports({ hostedUidQualified: async () => false, launch })).launch(binding)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reasons: ['upgrade-hosted-uid-unqualified'] } })
    await expect(createUpgradeLauncherProvider(null).launch(binding)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reasons: ['upgrade-native-provider-unqualified'] } })
    expect(launch).not.toHaveBeenCalled()
  })
  it('treats a wrong or missing acknowledgement as an unknown outcome', async () => {
    await expect(createUpgradeLauncherProvider(ports({ launch: async () => ({ accepted: false, binding }) })).launch(binding)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    await expect(createUpgradeLauncherProvider(ports({ launch: async () => ({ accepted: true, binding: { ...binding, fencingToken: 9 } }) })).launch(binding)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    await expect(createUpgradeLauncherProvider(ports({ launch: async () => { throw new Error('ipc down') } })).launch(binding)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
  })
  it('rejects an invalid binding before any launcher contact', async () => {
    const launch = vi.fn()
    await expect(createUpgradeLauncherProvider(ports({ launch })).launch({ ...binding, workerId: 'nope' })).rejects.toBeDefined()
    expect(launch).not.toHaveBeenCalled()
  })
  it('is null on this host, so the coordinator stays truthfully unqualified', () => {
    expect(nativeUpgradeLauncherPorts()).toBeNull()
  })
})
