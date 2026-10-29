import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import { parseUpgradeProcessBinding } from './upgrade-coordinator-contract.ts'
import type { UpgradeProcessBinding } from './upgrade-coordinator-contract.ts'
import type { QualifiedUpgradeProcessProvider, UpgradeProcessReadiness } from './upgrade-coordinator.ts'

/**
 * Authenticated launcher/IPC provider for the upgrade coordinator. A dedicated root launcher unit starts the pinned
 * native bootstrap; this provider proves the launcher over a signed local IPC handshake and proves the hosted-request
 * UID producer before it hands a binding over. Every primitive is injected so native systemd/SO_PEERCRED qualification
 * stays on a real Linux host; absent any primitive, readiness is truthfully unavailable and no process is launched.
 */
export type UpgradeLauncherReason =
  | 'upgrade-native-provider-unqualified' | 'upgrade-launcher-unit-inactive' | 'upgrade-launcher-ipc-unverified'
  | 'upgrade-hosted-uid-unqualified' | 'upgrade-pinned-runtime-unverified'

export interface UpgradeLauncherPorts {
  /** The dedicated root launcher unit is installed and active (e.g. a systemd socket/service). */
  launcherUnitActive(): Promise<boolean>
  /** Pinned clean runtime for the native machine (Node 26.12.1, no NODE_OPTIONS/NODE_PATH) is present. */
  pinnedRuntimeReady(): Promise<boolean>
  /** Signs a server-issued nonce over the authenticated local IPC and returns the launcher worker identity. */
  ipcHandshake(nonce: string): Promise<{ workerId: string; signature: string } | null>
  /** Verifies the handshake signature against the launcher's pinned key and the kernel peer identity (SO_PEERCRED). */
  verifyHandshake(nonce: string, response: { workerId: string; signature: string }): Promise<boolean>
  /** The hosted-request UID producer is qualified (a real per-request account identity, not a callback shape). */
  hostedUidQualified(): Promise<boolean>
  /** Hands the fenced binding to the launcher unit to start the pinned bootstrap; returns its acknowledgement. */
  launch(binding: Readonly<UpgradeProcessBinding>): Promise<{ accepted: boolean; binding: unknown }>
}

const held = (reasons: readonly UpgradeLauncherReason[]): never => fail('PRECONDITION_FAILED', 'the native upgrade launcher is unqualified', { stateChanged: false, reasons: [...reasons] })
const WORKER = /^upgrade-coordinator-[0-9a-f-]{36}$/
const SIGNATURE = /^[A-Za-z0-9+/]{43,683}={0,2}$/

/** Aggregates the launcher prerequisites into the readiness reasons the coordinator already understands. */
export async function upgradeLauncherReadiness(ports: UpgradeLauncherPorts | null): Promise<UpgradeProcessReadiness> {
  if (!ports) return { available: false, reasons: ['upgrade-native-provider-unqualified', 'upgrade-hosted-uid-unqualified'] }
  const reasons: UpgradeLauncherReason[] = []
  const check = async (probe: () => Promise<boolean>, reason: UpgradeLauncherReason): Promise<void> => { try { if (!await probe()) reasons.push(reason) } catch { reasons.push(reason) } }
  await check(() => ports.launcherUnitActive(), 'upgrade-launcher-unit-inactive')
  await check(() => ports.pinnedRuntimeReady(), 'upgrade-pinned-runtime-unverified')
  await check(() => ports.hostedUidQualified(), 'upgrade-hosted-uid-unqualified')
  if (!reasons.length) {
    // The launcher must answer a fresh signed challenge before it is considered ready.
    const nonce = randomUUID()
    try { const response = await ports.ipcHandshake(nonce); if (!response || !WORKER.test(response.workerId) || typeof response.signature !== 'string' || !SIGNATURE.test(response.signature) || !await ports.verifyHandshake(nonce, response)) reasons.push('upgrade-launcher-ipc-unverified') }
    catch { reasons.push('upgrade-launcher-ipc-unverified') }
  }
  return reasons.length ? { available: false, reasons } : { available: true, reasons: [] }
}

/** QualifiedUpgradeProcessProvider built on the launcher ports. Launch re-proves readiness and a signed handshake. */
export function createUpgradeLauncherProvider(ports: UpgradeLauncherPorts | null): QualifiedUpgradeProcessProvider {
  return {
    readiness: () => upgradeLauncherReadiness(ports),
    launch: async binding => {
      if (!ports) return held(['upgrade-native-provider-unqualified'])
      const checked = parseUpgradeProcessBinding(binding)
      const readiness = await upgradeLauncherReadiness(ports)
      if (!readiness.available) return held(readiness.reasons as UpgradeLauncherReason[])
      // Re-authenticate the launcher immediately before handing it the binding.
      const nonce = randomUUID()
      const response = await ports.ipcHandshake(nonce)
      if (!response || !WORKER.test(response.workerId) || typeof response.signature !== 'string' || !SIGNATURE.test(response.signature) || !await ports.verifyHandshake(nonce, response)) return held(['upgrade-launcher-ipc-unverified'])
      let acknowledgement: { accepted: boolean; binding: unknown }
      try { acknowledgement = await ports.launch(Object.freeze({ ...checked })) }
      catch { return fail('SERVICE_UNAVAILABLE', 'the upgrade launcher acknowledgement is unverified; operator inspection required', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
      if (acknowledgement?.accepted !== true || JSON.stringify(parseUpgradeProcessBinding(acknowledgement.binding)) !== JSON.stringify(checked)) return fail('SERVICE_UNAVAILABLE', 'the upgrade launcher did not acknowledge the exact binding; do not dispatch again', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      return { accepted: true, binding: checked }
    },
  }
}

/** Native host ports are not wired in this build: systemd launcher, local IPC, SO_PEERCRED and the hosted UID producer
 * all require a real Linux host, so production composition passes null until they are qualified. */
export const nativeUpgradeLauncherPorts = (): UpgradeLauncherPorts | null => null
