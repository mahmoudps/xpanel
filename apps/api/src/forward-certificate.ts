import { join } from 'node:path'
import { SERVER_OPERATIONS_STATE, validateDomainForwards } from '@xpanel/core'
import { services } from '@xpanel/render'
import { backgroundStateWrite, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'

const RENEW_WINDOW_DAYS = 30
export interface IssuedForwardCertificate { id: string; names: string[]; notAfter: string; fingerprintSha256?: string }

export const readIssuedCertificate = (reply: unknown): IssuedForwardCertificate | null => {
  const issued = (reply as { certificate?: Partial<IssuedForwardCertificate> } | null)?.certificate
  return typeof issued?.id === 'string' && typeof issued.notAfter === 'string' && Array.isArray(issued.names) ? issued as IssuedForwardCertificate : null
}

/** The record has no account: only the forward names it, and a second write keeps the same id. */
export async function recordForwardCertificate(store: Pick<StateStore, 'createCertificate'>, issued: IssuedForwardCertificate): Promise<void> {
  const paths = services.certFiles(issued.id)
  await store.createCertificate({ id: issued.id, accountId: null, names: issued.names, source: 'acme', challenge: 'http-01', notAfter: issued.notAfter, autoRenew: true, certPath: paths.fullchain, keyPath: paths.privkey, ...(issued.fingerprintSha256 ? { fingerprintSha256: issued.fingerprintSha256 } : {}) })
}

/** Scheduled with AutoSSL, which reads hosted domains only. A refused renewal is tried again on the next run. */
export async function renewForwardCertificates(store: Pick<StateStore, 'rootDir' | 'readSnapshot' | 'createCertificate'>, call: (path: string, options: { method: string; body: unknown }) => Promise<Response>, now: Date): Promise<void> {
  const forwards = validateDomainForwards(await readJsonIfExists(join(store.rootDir, SERVER_OPERATIONS_STATE.domainForwards)) ?? [])
  if (!forwards.length) return
  const snapshot = await store.readSnapshot()
  for (const certificate of services.certsForAutoRenew(snapshot.certificates, now, RENEW_WINDOW_DAYS)) {
    const domain = certificate.accountId === null ? forwards.find(forward => certificate.names.includes(forward.domain))?.domain : undefined
    if (!domain) continue
    const response = await call('/host/domain-forwards/certificate', { method: 'POST', body: { domain } })
    const issued = response.ok ? readIssuedCertificate(await response.json().catch(() => null)) : null
    if (issued) await backgroundStateWrite(() => recordForwardCertificate(store, issued))
  }
}
