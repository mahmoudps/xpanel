import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { RenderedFile } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { services } from '@xpanel/render'
import { FakeHostExecutor } from '../executor.ts'
import { AcmeCertificateServiceAdapter } from './acme.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
const certId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const input = { certId, accountId: 'account-a', callerRole: 'user' as const, names: ['example.com'], challenge: 'http-01' as const,
  domains: [{ id: 'domain-a', accountId: 'account-a', name: 'example.com' }], now: new Date('2026-11-03T00:00:00.000Z') }
const reason = 'While processing CAA for example.com: SERVFAIL looking up CAA for example.com'
const token = 't'.repeat(43)
const causes = ['certificate_authority_rejected', 'certificate_authority_unreachable'] as const
const failed = (executor: FakeHostExecutor, cause: typeof causes[number]) => new AcmeCertificateServiceAdapter({ executor, os,
  sniVerifier: async () => { throw new Error('a refused order must never reach served TLS verification') },
  caClient: async ({ onPublishChallenges }) => {
    await onPublishChallenges([{ identifier: 'example.com', token, keyAuthorization: token + '.' + 'a'.repeat(43) }])
    return fail('CONFIG_TEST_FAILED', cause === 'certificate_authority_rejected' ? reason : 'the certificate authority could not be reached', { reason: cause })
  },
})

describe.each(causes)('certificate authority %s settlement, portable host ports', cause => {
  const message = cause === 'certificate_authority_rejected' ? reason : 'the certificate authority could not be reached'
  it.each([true, false])('keeps certificate bytes unchanged and records the failed order after challenge cleanup (prepareOnly=%s)', async prepareOnly => {
    const executor = new FakeHostExecutor(), paths = services.certFiles(certId)
    for (const path of [paths.fullchain, paths.privkey]) await executor.writeFile({ path, content: 'existing certificate material', mode: 0o600, owner: 'root', group: 'root' })
    const adapter = failed(executor, cause)
    await expect(adapter.issueOrRenewCertificate({ ...input, prepareOnly })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', message,
      detail: { reason: cause, stateChanged: true, certificateMaterialChanged: false, verificationRequired: false, unknownOutcome: false } })
    for (const path of [paths.fullchain, paths.privkey]) expect(await executor.readFile(path)).toBe('existing certificate material')
    expect([...executor.files.keys()].some(path => path.endsWith('/' + token))).toBe(false)
    expect(await adapter.readOrderState(certId)).toMatchObject({ phase: 'failed', issuedPem: null, lastError: message, nextRetryAt: '2026-11-03T00:05:00.000Z' })
    expect(executor.executedActions.some(action => action.kind === 'systemd')).toBe(false)
  })
  it('keeps failed challenge cleanup uncertain instead of acknowledging a settled refusal', async () => {
    class FailedCleanup extends FakeHostExecutor {
      override async removePath(): Promise<void> { throw new Error('synthetic cleanup failure') }
    }
    const executor = new FailedCleanup(), adapter = failed(executor, cause)
    await expect(adapter.issueOrRenewCertificate({ ...input, prepareOnly: true })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE',
      detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect([...executor.files.keys()].some(path => path.endsWith('/' + token))).toBe(true)
  })
  it('keeps failure-journal write errors uncertain instead of claiming settled bookkeeping', async () => {
    class FailedJournal extends FakeHostExecutor {
      override async writeFile(file: RenderedFile): Promise<void> {
        if (file.path.endsWith(certId + '.json') && JSON.parse(file.content).phase === 'failed') throw new Error('synthetic journal failure')
        await super.writeFile(file)
      }
    }
    const executor = new FailedJournal(), adapter = failed(executor, cause)
    await expect(adapter.issueOrRenewCertificate({ ...input, prepareOnly: true })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE',
      detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect([...executor.files.keys()].some(path => path.endsWith('/' + token))).toBe(false)
    expect((await adapter.readOrderState(certId))?.phase).toBe('challenged')
  })
})
