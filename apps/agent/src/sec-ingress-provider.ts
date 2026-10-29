import { createHash } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { networkInterfaces } from 'node:os'
import { fail } from '@xpanel/core'
import { admitTrustedProxyRenderPolicy, parseTrustedProxyPolicy, readTrustedProxyActive, renderTrustedProxyRealIp, trustedProxyPolicyRevision } from '../../../packages/core/src/trusted-proxies.ts'
import type { ProtectedProxyIngress, TrustedProxyActive, TrustedProxyPolicy, TrustedProxyRenderAuthority } from '../../../packages/core/src/trusted-proxies.ts'
import { edge as edgeRender } from '@xpanel/render'
import type { TrustedProxyNativeProvider } from './trusted-proxies.ts'
import { readSecEdgeConfiguration } from './sec-waf.ts'

/** Written only by the host operator (console or installer), never by the API or this agent: root-owned, not group/world writable. */
export const SEC_INGRESS_EVIDENCE = '/etc/xpanel/ingress/dedicated-ingress.json'
/** The provider's own record of the activated policy; nginx.conf is derived from it. */
export const SEC_INGRESS_ACTIVE = '/etc/xpanel/ingress/active-trusted-proxies.json'
export interface SecProtectedFile { text: string; uid: number; mode: number }
export interface SecIngressPorts {
  readProtected: (path: string) => Promise<SecProtectedFile | null>
  writeProtected: (path: string, text: string) => Promise<void>
  removeProtected: (path: string) => Promise<void>
  readNginxMain: () => Promise<string | null>
  writeNginxMain: (content: string) => Promise<void>
  /** Exactly what the reconciler renders for nginx.conf, with the given authority. */
  renderNginxMain: (authority: TrustedProxyRenderAuthority | undefined) => Promise<string>
  testNginx: () => Promise<boolean>
  reloadNginx: () => Promise<void>
  probeManagement: () => Promise<boolean>
  localAddresses: () => string[]
  /** The API's socket-derived client address for this management request; null when the transport did not supply one. */
  managementClient: () => string | null
}
interface ActiveRecord { version: 1; active: TrustedProxyActive; managementClient: string; activatedAt: string }
const EMPTY: TrustedProxyPolicy = { cidrs: [], header: 'X-Forwarded-For' }
const unchanged = { stateChanged: false }
const blocked = (message: string): never => fail('PRECONDITION_FAILED', message, unchanged)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const parse = (text: string): unknown => { try { return JSON.parse(text) } catch { return null } }
const trusted = (file: SecProtectedFile | null): file is SecProtectedFile => !!file && file.uid === 0 && (file.mode & 0o022) === 0

export async function readSecIngressEvidence(ports: Pick<SecIngressPorts, 'readProtected'>): Promise<string[]> {
  const file = await ports.readProtected(SEC_INGRESS_EVIDENCE)
  if (!trusted(file)) return blocked('a protected dedicated ingress declaration is required')
  const value = parse(file.text)
  if (!object(value) || Object.keys(value).sort().join() !== 'dedicatedCidrs,kind' || value.kind !== 'protected-dedicated-ingress-v1' || !Array.isArray(value.dedicatedCidrs)) return blocked('the dedicated ingress declaration is invalid')
  return parseTrustedProxyPolicy({ cidrs: value.dedicatedCidrs, header: 'X-Forwarded-For' }).cidrs
}
async function readActiveRecord(ports: Pick<SecIngressPorts, 'readProtected'>): Promise<{ record: ActiveRecord | null; text: string | null }> {
  const file = await ports.readProtected(SEC_INGRESS_ACTIVE)
  if (file === null) return { record: null, text: null }
  if (!trusted(file)) return blocked('the active proxy record is not protected')
  const value = parse(file.text)
  if (!object(value) || Object.keys(value).sort().join() !== 'activatedAt,active,managementClient,version' || value.version !== 1 || typeof value.managementClient !== 'string' || typeof value.activatedAt !== 'string') return blocked('the active proxy record is invalid')
  return { record: { version: 1, active: readTrustedProxyActive(value.active), managementClient: value.managementClient, activatedAt: value.activatedAt }, text: file.text }
}
const activeOf = (record: ActiveRecord | null): TrustedProxyActive => record?.active ?? { state: 'read', policy: EMPTY, revision: trustedProxyPolicyRevision(EMPTY) }
const containsBlock = (main: string, policy: TrustedProxyPolicy): boolean => main.includes(renderTrustedProxyRealIp(policy).trimEnd())

/** Reconciler input: the render authority for the activated policy, re-admitted against fresh evidence; undefined when nothing is activated. */
export async function secIngressRenderAuthority(ports: Pick<SecIngressPorts, 'readProtected' | 'localAddresses'>): Promise<TrustedProxyRenderAuthority | undefined> {
  const { record } = await readActiveRecord(ports)
  if (!record || !record.active.policy.cidrs.length) return undefined
  // The management client recorded at activation keeps the admission rule; the dedicated networks and local interfaces are read fresh.
  return admitTrustedProxyRenderPolicy(record.active.policy, { kind: 'protected-dedicated-ingress-v1', localAddresses: ports.localAddresses(), managementClient: record.managementClient, dedicatedCidrs: await readSecIngressEvidence(ports) })
}

export function createSecIngressProvider(ports: SecIngressPorts, now: () => Date = () => new Date()): TrustedProxyNativeProvider {
  let installed: { main: string; record: string } | null = null
  const ingress = async (): Promise<ProtectedProxyIngress> => {
    const client = ports.managementClient()
    if (!client) return blocked('the management client address is unavailable')
    return { kind: 'protected-dedicated-ingress-v1', localAddresses: ports.localAddresses(), managementClient: client, dedicatedCidrs: await readSecIngressEvidence(ports) }
  }
  return {
    async observe() {
      const { record } = await readActiveRecord(ports), active = activeOf(record), main = await ports.readNginxMain()
      // The live nginx.conf must carry the rendered real-IP block for the recorded policy; a saved record alone proves nothing.
      if (main === null || !containsBlock(main, active.policy)) return blocked('the running nginx configuration does not match the active proxy record')
      return active
    },
    protectedIngress: ingress,
    async captureRecovery() {
      const { text } = await readActiveRecord(ports), main = await ports.readNginxMain()
      if (main === null) return blocked('nginx.conf could not be captured for recovery')
      return {
        revision: sha(text ?? ''),
        verify: async () => typeof main === 'string' && main.length > 0,
        restore: async () => {
          const current = await ports.readNginxMain()
          // Refuse to overwrite external drift: only our own installed bytes or the captured original may be replaced.
          if (current !== main && current !== installed?.main) return blocked('nginx.conf changed outside this activation; recovery requires review')
          if (text === null) await ports.removeProtected(SEC_INGRESS_ACTIVE); else await ports.writeProtected(SEC_INGRESS_ACTIVE, text)
          await ports.writeNginxMain(main)
        },
      }
    },
    async install(policy, expectedNativeRevision, beforeCommit) {
      const checked = parseTrustedProxyPolicy(policy), { text } = await readActiveRecord(ports)
      if (sha(text ?? '') !== expectedNativeRevision) return fail('CONFLICT', 'the active proxy record changed; reload before applying', unchanged)
      const proof = await ingress()
      const rendered = await ports.renderNginxMain(checked.cidrs.length ? admitTrustedProxyRenderPolicy(checked, proof) : undefined)
      if (!containsBlock(rendered, checked)) return blocked('the rendered nginx configuration does not carry the policy')
      const record: ActiveRecord = { version: 1, active: { state: 'read', policy: checked, revision: trustedProxyPolicyRevision(checked) }, managementClient: proof.managementClient, activatedAt: now().toISOString() }
      const recordText = JSON.stringify(record) + '\n'
      await beforeCommit()
      installed = { main: rendered, record: recordText }
      await ports.writeProtected(SEC_INGRESS_ACTIVE, recordText)
      await ports.writeNginxMain(rendered)
    },
    testConfiguration: () => ports.testNginx(),
    reload: () => ports.reloadNginx(),
    probeManagement: () => ports.probeManagement().catch(() => false),
  }
}

const readProtectedNative = async (path: string): Promise<SecProtectedFile | null> => {
  try { const facts = await lstat(path); if (!facts.isFile() || facts.size > 64 * 1024) return null; return { text: await readFile(path, 'utf8'), uid: facts.uid, mode: facts.mode } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
const localAddressesNative = (): string[] => Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address.replace(/%.*$/, '')) ?? [])
/** Reconciler input on the host. Missing or changed evidence renders no proxy trust (TCP peer), and observation then reports the mismatch. */
export const secIngressRenderAuthorityNative = (): Promise<TrustedProxyRenderAuthority | undefined> => secIngressRenderAuthority({ readProtected: readProtectedNative, localAddresses: localAddressesNative }).catch(() => undefined)

/** Host ports. File writes are atomic renames of root-owned 0600 files; nginx.conf goes through the reviewed executor. */
export function nativeSecIngressPorts(input: {
  readNginxMain: () => Promise<string | null>; writeNginxMain: (content: string) => Promise<void>; renderNginxMain: SecIngressPorts['renderNginxMain']
  testNginx: () => Promise<boolean>; reloadNginx: () => Promise<void>; managementClient: () => string | null; managementPort?: number; managementHost?: string
}): SecIngressPorts {
  return {
    readProtected: readProtectedNative,
    writeProtected: async (path, text) => { const temp = `${path}.tmp-${process.pid}`; await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, path) },
    removeProtected: path => rm(path, { force: true }),
    readNginxMain: input.readNginxMain, writeNginxMain: input.writeNginxMain, renderNginxMain: input.renderNginxMain, testNginx: input.testNginx, reloadNginx: input.reloadNginx,
    localAddresses: localAddressesNative,
    managementClient: input.managementClient,
    // Loopback TLS request to the xWHM listener: proves the management entry point still answers after the reload; forwarded headers play no part.
    probeManagement: () => new Promise<boolean>(resolve => {
      const req = httpsRequest({ host: '127.0.0.1', port: input.managementPort ?? 2087, path: '/api/health', method: 'GET', rejectUnauthorized: false, timeout: 5000, ...(input.managementHost ? { servername: input.managementHost, headers: { host: input.managementHost } } : {}) },
        res => { res.resume(); resolve(res.statusCode === 200) })
      req.on('timeout', () => { req.destroy(); resolve(false) }); req.on('error', () => resolve(false)); req.end()
    }),
  }
}

/** The agent server's per-request provider: nginx.conf is rendered exactly as the reconciler renders it (saved WAF edge input included). */
export function secIngressProviderFor(input: {
  executor: { readFile(path: string): Promise<string | null>; writeFile(file: { path: string; content: string; mode: number; owner: string; group: string }): Promise<void>; runTest(test: { name: string; argv: string[] }): Promise<{ ok: boolean; code: number }>; runAction(action: { kind: 'systemd'; verb: 'reload'; unit: string }): Promise<void> }
  os: Parameters<typeof edgeRender.renderNginxMain>[1]
  store: { rootDir: string; readSnapshot(): Promise<{ server: { settings: Parameters<typeof edgeRender.renderNginxMain>[0] } | null; domains: readonly { name: string; accountId: string }[] }> }
  /** Set only by the API's authenticated agent transport from the socket or trusted-ingress client address. */
  managementClient: string | null
}): TrustedProxyNativeProvider {
  const path = `${input.os.paths.nginxRoot}/nginx.conf`
  return createSecIngressProvider(nativeSecIngressPorts({
    readNginxMain: () => input.executor.readFile(path),
    writeNginxMain: content => input.executor.writeFile({ path, content, mode: 0o644, owner: 'root', group: 'root' }),
    renderNginxMain: async authority => {
      const snapshot = await input.store.readSnapshot()
      if (!snapshot.server) return blocked('server settings are not saved')
      const sec = await readSecEdgeConfiguration(input.store.rootDir, { family: input.os.family, domains: snapshot.domains })
      return edgeRender.renderNginxMain({ ...snapshot.server.settings, edge: sec.edge } as Parameters<typeof edgeRender.renderNginxMain>[0], input.os, authority).content
    },
    testNginx: async () => { const result = await input.executor.runTest(edgeRender.nginxConfigTest(input.os)); return result.ok && result.code === 0 },
    reloadNginx: () => input.executor.runAction({ kind: 'systemd', verb: 'reload', unit: input.os.services.nginx }),
    managementClient: () => input.managementClient,
  }))
}
