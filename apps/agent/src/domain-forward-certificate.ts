import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fail, SERVER_OPERATIONS_STATE, validateDomainForwards } from '@xpanel/core'
import type { Certificate } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { edge, services } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { LinuxHostExecutor } from './executor.ts'
import { readServedCertificatePem } from './host-identity.ts'
import { readOsRelease } from './os-release.ts'
import { AcmeCertificateServiceAdapter, computeLeafFingerprintSha256 } from './services/acme.ts'
import { createHttp01AcmeClient } from './services/acme-client.ts'

export const FORWARD_CERTIFICATE_PATH = '/host/domain-forwards/certificate'
const ACCOUNT_KEY = '/var/lib/xpanel/acme-account/account-key.pem'
const unchanged = { stateChanged: false }

export interface ForwardCertificateContext {
  executor: LinuxHostExecutor | null
  rootDir: string
  assertRoot: () => Promise<void>
  certificates: () => Promise<readonly Pick<Certificate, 'id' | 'accountId' | 'names'>[]>
}

/** The certificate of a forward. No account or hosted site owns the name, so root alone asks for it. */
export async function handleForwardCertificateRoute(request: Request, url: URL, method: string, ctx: ForwardCertificateContext): Promise<Response | null> {
  if (url.pathname !== FORWARD_CERTIFICATE_PATH) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  await ctx.assertRoot()
  if (!ctx.executor) return fail('PRECONDITION_FAILED', 'certificates are unavailable on this host', unchanged)
  const executor = ctx.executor, body = await request.json().catch(() => null) as { domain?: unknown } | null
  const forwards = validateDomainForwards(await readJsonIfExists(join(ctx.rootDir, SERVER_OPERATIONS_STATE.domainForwards)) ?? [])
  const forward = forwards.find(item => item.domain === body?.domain)
  if (!forward) return fail('NOT_FOUND', 'no forward exists for that domain', unchanged)
  const release = await readOsRelease(executor)
  if (!release) return fail('PRECONDITION_FAILED', 'the host operating system could not be read', unchanged)
  const directoryUrl = 'https://acme-v02.api.letsencrypt.org/directory', existingKey = await executor.readFile(ACCOUNT_KEY)
  const caClient = createHttp01AcmeClient({ directoryUrl, ...(existingKey ? { accountKeyPem: existingKey } : {}) })
  if (!existingKey) {
    await executor.runAction({ kind: 'ensure-dir', path: '/var/lib/xpanel/acme-account', mode: 0o700, owner: 'root', group: 'root' })
    await executor.writeFile({ path: ACCOUNT_KEY, content: caClient.accountKeyPem, mode: 0o600, owner: 'root', group: 'root' })
  }
  const adapter = new AcmeCertificateServiceAdapter({ executor, os: profileFor(release), directoryUrl, caClient, http01ChallengeDir: edge.XP_PATHS.acmeDir,
    sniVerifier: async ({ servername, expectedFingerprintSha256 }) => {
      const pem = await readServedCertificatePem(forward.ip, 443, 2000, servername)
      if (!pem) return { servername, ok: false, fingerprintSha256: null, notAfter: null, error: 'served_certificate_unavailable' }
      const observed = computeLeafFingerprintSha256(pem)
      return { servername, ok: observed.fingerprintSha256 === expectedFingerprintSha256 && services.coversHost(observed.dnsSans, servername) && observed.notAfter.getTime() > Date.now(), fingerprintSha256: observed.fingerprintSha256, notAfter: observed.notAfter.toISOString() }
    } })
  const existing = (await ctx.certificates()).find(item => item.accountId === null && item.names.includes(forward.domain))
  const result = await adapter.issueOrRenewCertificate({ certId: existing?.id ?? randomUUID(), accountId: null, callerRole: 'root', names: [forward.domain], challenge: 'http-01',
    domains: [{ id: randomUUID(), accountId: null as never, name: forward.domain }], prepareOnly: !existing })
  return new Response(JSON.stringify({ certificate: { id: result.certId, names: result.identifiers, notAfter: result.notAfter, fingerprintSha256: result.fingerprintSha256 } }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
