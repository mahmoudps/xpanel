import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account, HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import { edge, system } from '@xpanel/render'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { pearLibraryDir } from '../../../packages/os/src/pear-command.ts'
import { effectiveSecPolicy, SEC_STATE_PATHS } from './sec-policy.ts'
import type { SvcKind, SvcPhpFpmDefaults } from './svc-policy.ts'
import type { WebdiskTlsPolicy } from './mail-cert-policy.ts'
import { readWebStatusToken } from './svc-web-status.ts'

/** Saved services and security centre state as the pure compiler takes it. */
export interface SvcHostInput {
  /** null: never saved, so the distribution's modes are left alone */
  tracerouteAllowed: boolean | null
  smtpRestricted: boolean
  /** shell accounts under Shell Fork Bomb Protection; null when it is off */
  forkBombUsers: string[] | null
  /** Apache status path token; absent on hosts without the native reconciler */
  webStatusToken: string | null
  phpFpm: SvcPhpFpmDefaults | null
  wafCustomRules: readonly string[]
  /** server PEAR library per PHP version that has one */
  pearLibraries: Readonly<Record<string, string>>
  webdiskTls: WebdiskTlsPolicy | null
}

export const readSvcPolicy = async <K extends SvcKind>(root: string, kind: K): Promise<ReturnType<typeof effectiveSecPolicy<K>> | null> => {
  let raw: unknown
  try { raw = await readJsonIfExists<unknown>(join(root, SEC_STATE_PATHS[kind])) } catch { return fail('PRECONDITION_FAILED', `saved ${kind} configuration is unreadable; review it before reconciliation`) }
  return raw === null ? null : effectiveSecPolicy(kind, raw)
}
/** Agent-owned files live in their own root-only directory: these writes must not touch the parent that database observations watch. */
export const writeSvcState = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await atomicWriteJson(path, value, 0o600)
}
const pearLibraries = async (): Promise<Record<string, string>> => {
  const entries = await Promise.all(SUPPORTED_PHP_VERSIONS.map(async version => {
    const path = pearLibraryDir(version)
    return await stat(path).then(facts => facts.isDirectory(), () => false) ? [[version, path] as const] : []
  }))
  return Object.fromEntries(entries.flat())
}
export const shellAccounts = (accounts: readonly Account[]): string[] => accounts.filter(account => account.status !== 'terminating' && account.shell !== 'none').map(account => account.username).sort()

export async function readSvcHostInput(root: string, snapshot: { accounts: readonly Account[] }, webStatus: boolean): Promise<SvcHostInput> {
  const [traceroute, smtp, forkBomb, phpFpm, wafRules, webdiskTls] = await Promise.all([readSvcPolicy(root, 'traceroute'), readSvcPolicy(root, 'smtp-restrictions'), readSvcPolicy(root, 'fork-bomb'), readSvcPolicy(root, 'php-fpm-defaults'), readSvcPolicy(root, 'waf-rules'), readSvcPolicy(root, 'webdisk-tls')])
  return { tracerouteAllowed: traceroute?.allowed ?? null, smtpRestricted: smtp?.enabled === true, forkBombUsers: forkBomb?.enabled ? shellAccounts(snapshot.accounts) : null,
    webStatusToken: webStatus ? await readWebStatusToken() : null, phpFpm, wafCustomRules: wafRules?.deployed.filter(rule => rule.enabled).map(rule => rule.text) ?? [],
    pearLibraries: webStatus ? await pearLibraries() : {}, webdiskTls }
}

/** Files and post actions of the saved tools; a tool left off renders nothing, so its earlier file leaves with the generation. */
export function renderSvcHost(os: OsProfile, input: SvcHostInput, apache: boolean): { files: RenderedFile[]; actions: HostAction[] } {
  const files: RenderedFile[] = [], actions: HostAction[] = []
  if (input.tracerouteAllowed !== null) {
    const traceroute = system.renderTracerouteAccess(input.tracerouteAllowed)
    files.push(traceroute.file); actions.push(...traceroute.actions)
  }
  if (input.forkBombUsers) files.push(system.renderForkBombLimits(input.forkBombUsers))
  if (input.webStatusToken) { files.push(edge.renderNginxStatus(os)); if (apache) files.push(edge.renderApacheStatus(os, input.webStatusToken)) }
  const customRules = edge.renderModsecurityCustomRules(input.wafCustomRules)
  if (customRules) files.push(customRules)
  return { files, actions }
}
