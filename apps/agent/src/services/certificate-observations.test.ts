import { describe, expect, it, vi } from 'vitest'
import { CERTIFICATE_ORDER_DIRECTORY, MANAGEMENT_TLS_STATUS_FILE, MAX_CERTIFICATE_ORDER_BYTES, MAX_CERTIFICATE_ORDER_READS,
  projectManagementTlsStatus, projectManagementTlsTimer, projectOwnedAcmeOrder, readAccountAcmeOrders,
  readBoundedCertificateProviderFile, readManagementTlsObservation } from './certificate-observations.ts'

const id = (value: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(value).padStart(12, '0')
const account = { id: id(1) }, certificate = { id: id(2), accountId: account.id, names: ['example.test', 'app.example.test'], source: 'acme' as const, challenge: 'http-01' as const }
const domains = certificate.names.map(name => ({ name, accountId: account.id }))
const now = new Date('2026-10-26T12:00:00.000Z')
const order = () => ({ certId: certificate.id, accountId: account.id, identifiers: [...certificate.names], challenge: 'http-01', phase: 'failed',
  attempts: 3, nextRetryAt: '2026-10-26T12:20:00.000Z', updatedAt: now.toISOString(), notAfter: null, fingerprintSha256: null,
  issuedPem: { fullchain: 'PRIVATE-CHAIN-CHECKPOINT', privkey: 'PRIVATE-KEY-CHECKPOINT' }, lastError: 'PRIVATE-PROVIDER-DIAGNOSTIC', orderUrl: 'https://private-order.invalid/token', directoryUrl: 'https://private-provider.invalid' })
const management = () => ({ schemaVersion: 1, at: now.toISOString(), phase: 'renew', status: 'tls-ready', fingerprint: 'a'.repeat(64), expiresAt: '2027-01-01T00:00:00.000Z', renewal: 'timer-active-not-renewal-qualified', secret: 'PRIVATE-INGRESS-SECRET' })
const timer = 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nFragmentPath=/etc/systemd/system/xpanel-management-tls.timer\nDropInPaths=\n'

describe('bounded real-provider certificate observations; portable injected reads only', () => {
  it('projects only the authorized durable order fields and preserves actual retry time without served-TLS claims', () => {
    const projected = projectOwnedAcmeOrder(order(), certificate, account.id, domains)
    expect(projected).toMatchObject({ names: certificate.names, phase: 'failed', attempts: 3, nextRetryAt: '2026-10-26T12:20:00.000Z', failureRecorded: true, servedTlsVerified: false })
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE-|issuedPem|orderUrl|directoryUrl|lastError/)
    for (const patch of [{ accountId: id(3) }, { certId: id(3) }, { identifiers: ['foreign.test'] }, { attempts: -1 }, { updatedAt: '2026-02-30T00:00:00.000Z' }, { nextRetryAt: 'invented' }]) {
      expect(() => projectOwnedAcmeOrder({ ...order(), ...patch }, certificate, account.id, domains)).toThrow()
    }
  })
  it('reads only owned saved identities and distinguishes missing, invalid and unavailable records', async () => {
    const certificates = [2, 3, 4, 5].map(value => ({ ...certificate, id: id(value) }))
    const reader = vi.fn(async (path: string, limit: number) => {
      expect(limit).toBe(MAX_CERTIFICATE_ORDER_BYTES)
      if (path.endsWith(id(2) + '.json')) return JSON.stringify(order())
      if (path.endsWith(id(3) + '.json')) return null
      if (path.endsWith(id(4) + '.json')) return '{PRIVATE-MALFORMED'
      throw new Error('PRIVATE-READ-ERROR')
    })
    const result = await readAccountAcmeOrders({ account, certificates, domains, readFile: reader, now })
    expect(result.rows.map(row => row.state)).toEqual(['observed', 'missing', 'invalid', 'unavailable'])
    expect(result).toMatchObject({ scope: 'authorized_saved_certificate_ids', inventoryComplete: false, truncated: false,
      scheduler: { state: 'unavailable', nextRunAt: null, reason: 'site_scheduler_not_connected' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE-')
    expect(reader.mock.calls[0]![0]).toBe(CERTIFICATE_ORDER_DIRECTORY + '/' + certificate.id + '.json')
    await expect(readAccountAcmeOrders({ account, certificates: [{ ...certificate, accountId: id(9) }], domains, readFile: reader })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(reader).toHaveBeenCalledTimes(4)
  })
  it('bounds inventory and input bytes and labels the missing complete-inventory provider explicitly', async () => {
    const certificates = Array.from({ length: MAX_CERTIFICATE_ORDER_READS + 1 }, (_, index) => ({ ...certificate, id: id(index + 2) }))
    const reader = vi.fn(async () => 'x'.repeat(MAX_CERTIFICATE_ORDER_BYTES + 1))
    const result = await readAccountAcmeOrders({ account, certificates, domains, readFile: reader, now })
    expect(reader).toHaveBeenCalledTimes(MAX_CERTIFICATE_ORDER_READS)
    expect(result).toMatchObject({ totalSavedAcmeCertificates: 51, inspectedSavedCertificates: 50, truncated: true, inventoryComplete: false })
    expect(result.rows.every(row => row.state === 'invalid')).toBe(true)
    const empty = await readAccountAcmeOrders({ account, certificates: [], domains, readFile: reader, now })
    expect(empty.rows).toEqual([]); expect(empty.inventoryComplete).toBe(false)
  })
  it('projects historical management status without secrets, live-handshake or renewal-qualification claims', async () => {
    const projected = projectManagementTlsStatus(management())
    expect(projected).toMatchObject({ phase: 'renew', status: 'tls-ready', historical: true, servedTlsVerified: false, renewalQualified: false })
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-')
    const reader = vi.fn(async (path: string, limit: number) => { expect(path).toBe(MANAGEMENT_TLS_STATUS_FILE); expect(limit).toBe(64 * 1024); return JSON.stringify(management()) })
    const result = await readManagementTlsObservation({ readFile: reader, now })
    expect(result).toMatchObject({ state: 'observed', timer: { state: 'unavailable' }, servedTlsVerified: false, renewalQualified: false })
    expect(() => projectManagementTlsStatus({ ...management(), expiresAt: '2027-02-30T00:00:00.000Z' })).toThrow()
  })
  it('observes only the owned management timer and never substitutes its active state for successful renewal', async () => {
    expect(projectManagementTlsTimer(timer)).toEqual({ active: true, enabled: true, renewalQualified: false })
    expect(() => projectManagementTlsTimer(timer.replace('DropInPaths=', 'DropInPaths=/private/operator.conf'))).toThrow()
    expect(() => projectManagementTlsTimer(timer.replace('/etc/systemd/system/', '/run/systemd/generator/'))).toThrow()
    const run = vi.fn(async (_argv: string[]) => ({ ok: true, code: 0, stdout: timer, stderr: '' }))
    const result = await readManagementTlsObservation({ readFile: async () => null, runCommand: run, now })
    expect(result).toMatchObject({ state: 'missing', status: null, timer: { state: 'observed', observation: { active: true, enabled: true, renewalQualified: false } }, servedTlsVerified: false })
    expect(run).toHaveBeenCalledWith(['/usr/bin/systemctl', 'show', 'xpanel-management-tls.timer', '--no-pager', '--property=LoadState', '--property=ActiveState', '--property=UnitFileState', '--property=FragmentPath', '--property=DropInPaths'])
  })
  it('rejects arbitrary native paths and preserves unavailable versus malformed management reads', async () => {
    await expect(readBoundedCertificateProviderFile('/root/.ssh/id_ed25519', 1024)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    await expect(readBoundedCertificateProviderFile(CERTIFICATE_ORDER_DIRECTORY + '/../private.json', 1024)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const malformed = await readManagementTlsObservation({ readFile: async () => 'PRIVATE-MALFORMED', now })
    const unavailable = await readManagementTlsObservation({ readFile: async () => { throw new Error('PRIVATE-READ-ERROR') }, now })
    expect(malformed.state).toBe('invalid'); expect(unavailable.state).toBe('unavailable')
    expect(JSON.stringify([malformed, unavailable])).not.toContain('PRIVATE-')
  })
})
