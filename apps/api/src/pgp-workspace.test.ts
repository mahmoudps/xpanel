import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { handlePgpWorkspace, validatePgpView } from './pgp-workspace.ts'
import { pgpRevision } from '../../agent/src/account-pgp.ts'
const ID = '11111111-1111-4111-8111-111111111111', FP = 'A'.repeat(40)
const account = { id: ID, username: 'alice', status: 'active', planId: 'plan' } as Account
const caller = (kind = 'user') => ({ principal: { kind, id: 'owner', username: 'alice', accountId: ID }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } }) as unknown as AuthenticatedCaller
const key = { fingerprint: FP, uids: ['Alice <alice@example.test>'], algorithm: 'Ed25519', bits: 255, created: '2023-11-14T22:13:20.000Z', expires: null, hasSecret: true, encryption: true }
const view = () => ({ context: { accountId: ID, username: 'alice' }, revision: pgpRevision(ID, [key]), keys: [key], mailboxes: ['alice@example.test'], application: { status: 'read', fingerprint: null }, capabilities: { generate: true, import: true, export: true, delete: true }, scope: 'account-keyring', messageEncryption: false })
function setup(options: { disabled?: string[]; callers?: AuthenticatedCaller[]; reply?: unknown } = {}) {
  const users = [...(options.callers ?? [])], readAgent = vi.fn(async () => options.reply ?? view())
  const store = { getAccount: async (id: string) => id === ID ? account : null, getPlan: async () => ({ featureListId: 'features' }) as Plan, getFeatureList: async () => ({ disabled: options.disabled ?? [] }) } as unknown as StateStore
  const ports = { store, requireCaller: async () => users.shift() ?? caller(), readAgent: readAgent as unknown as ReadAgent }
  const route = (method = 'GET', body?: unknown, suffix = '') => { const url = new URL('http://panel.test/api/account/pgp' + suffix); return handlePgpWorkspace(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
  return { route, readAgent }
}
describe('OpenPGP owner API', () => {
  it('pins a read to the session account and rejects unexpected secret fields', async () => {
    const t = setup(); expect(await (await t.route())!.json()).toEqual(view()); expect(t.readAgent).toHaveBeenCalledWith(expect.anything(), '/accounts/alice/pgp', undefined, false, 'GET')
    for (const raw of [{ ...view(), privateKey: 'secret' }, { ...view(), context: { accountId: 'foreign', username: 'bob' } }, { ...view(), keys: [{ ...key, passphrase: 'secret' }] }, { ...view(), messageEncryption: true }, { ...view(), revision: 'b'.repeat(64) }, { ...view(), application: { status: 'read', fingerprint: FP } }, { ...view(), capabilities: { ...view().capabilities, export: false } }]) expect(() => validatePgpView(raw, ID, 'alice', 'read')).toThrow()
  })
  it('refuses nonowners, plan restrictions and request selectors before dispatch', async () => {
    for (const kind of ['root', 'reseller']) { const t = setup({ callers: [caller(kind)] }); await expect(t.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.readAgent).not.toHaveBeenCalled() }
    const disabled = setup({ disabled: ['email-encryption'] }); await expect(disabled.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(disabled.readAgent).not.toHaveBeenCalled()
    const selector = setup(); await expect(selector.route('GET', undefined, '?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' }); expect(selector.readAgent).not.toHaveBeenCalled()
  })
  it('rechecks owner binding before mutation and requires exact confirmation', async () => {
    const changed = setup({ callers: [caller(), { ...caller(), principal: { ...caller().principal, id: 'other-owner' } } as AuthenticatedCaller] })
    await expect(changed.route('DELETE', { op: 'delete', expectedRevision: 'a'.repeat(64), fingerprint: FP, confirmation: FP })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(changed.readAgent).not.toHaveBeenCalled()
    const t = setup(); await expect(t.route('DELETE', { op: 'delete', expectedRevision: 'a'.repeat(64), fingerprint: FP, confirmation: 'delete' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('withholds a completed mutation reply if the owner binding is lost during the agent operation', async () => {
    const t = setup({ callers: [caller(), caller(), caller('root')], reply: { ...view(), application: { status: 'generated', fingerprint: FP } } })
    await expect(t.route('POST', { op: 'generate', expectedRevision: pgpRevision(ID, []), name: 'Alice', address: 'alice@example.test', algorithm: 'ed25519', days: 365, passphrase: 'private passphrase' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
    expect(t.readAgent).toHaveBeenCalledTimes(1)
    const read = setup({ callers: [caller(), caller(), caller('reseller')] })
    await expect(read.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(read.readAgent).toHaveBeenCalledTimes(1)
  })
  it('downloads public armor only and refuses private material', async () => {
    const armor = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nYWJj\n-----END PGP PUBLIC KEY BLOCK-----\n', good = setup({ reply: { fingerprint: FP, kind: 'public', armor } })
    const response = await good.route('GET', undefined, '/' + FP + '/public'); expect(response!.headers.get('content-type')).toBe('application/pgp-keys'); expect(await response!.text()).toBe(armor)
    const privateReply = setup({ reply: { fingerprint: FP, kind: 'public', armor: armor.replaceAll('PUBLIC', 'PRIVATE') } }); await expect(privateReply.route('GET', undefined, '/' + FP + '/public')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('does not acknowledge a deleted key still present in the reply', async () => {
    const t = setup({ reply: { ...view(), application: { status: 'deleted', fingerprint: FP } } })
    await expect(t.route('DELETE', { op: 'delete', expectedRevision: 'a'.repeat(64), fingerprint: FP, confirmation: FP })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
  })
  it('refuses a generation acknowledgement with an unchanged keyring revision', async () => {
    const t = setup({ reply: { ...view(), application: { status: 'generated', fingerprint: FP } } })
    await expect(t.route('POST', { op: 'generate', expectedRevision: view().revision, name: 'Alice', address: 'alice@example.test', algorithm: 'ed25519', days: 365, passphrase: 'private passphrase' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
