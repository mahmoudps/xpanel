import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { handleAccountPackagesWorkspaceRoute, projectAccountPackagesView } from './account-packages-workspace.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active' } as Account
const caller = { principal: { kind: 'user', id: 'principal', username: 'alice', accountId: account.id }, principalRecord: {}, scopes: [], apiTokenId: null } as unknown as AuthenticatedCaller
const pkg = { name: 'Config_Lite', version: '1.0.0', source: 'https://pear.php.net/get/Config_Lite-1.0.0.tgz', archiveSha256: 'c'.repeat(64), requires: [], files: [{ path: 'Config/Lite.php', sha256: 'd'.repeat(64) }] }
const view = (op = 'read') => ({ context: { accountId: account.id, username: 'alice' }, ecosystem: 'pear', scope: 'managed-private-library', library: '.xpanel-packages/pear/library', revision: (op === 'read' ? 'a' : 'b').repeat(64), catalogRevision: 'f'.repeat(64), inventory: 'verified', packages: op === 'install' ? [pkg] : [], available: [{ name: pkg.name, version: pkg.version, source: pkg.source, requires: [], summary: 'Reviewed library' }], recovery: op === 'read' ? 'none' : 'committed', capabilities: { install: true, remove: true, recover: false }, application: { op, state: op === 'read' ? 'read' : 'verified', verificationRequired: false } })
function setup() {
  let disabled: string[] = [], current = caller
  const readAgent = vi.fn(async (_caller: unknown, _path: string, input?: unknown) => view(input ? (input as { op: string }).op : 'read'))
  const ports: AccountSshPorts = { store: { getAccount: async () => account, getPlan: async () => ({ featureListId: 'features' }), getFeatureList: async () => ({ disabled }) } as unknown as StateStore, requireCaller: async () => current, readAgent: readAgent as unknown as AccountSshPorts['readAgent'] }
  const route = (method = 'GET', body?: unknown, search = '') => { const url = new URL('http://panel.test/api/account/packages' + search); return handleAccountPackagesWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
  return { route, readAgent, disable: () => { disabled = ['modules-php-pear'] }, foreign: () => { current = { ...caller, principal: { kind: 'root', id: 'root', username: 'root' } } } }
}
describe('account private packages API', () => {
  it('uses owner-derived agent targets and returns verified exact install/remove acknowledgements', async () => {
    const t = setup(), read = await (await t.route())!.json(), response = await t.route('POST', { op: 'install', name: 'Config_Lite', expectedRevision: read.revision })
    expect((await response!.json()).packages).toEqual([pkg]); expect(t.readAgent.mock.calls.at(-1)!.slice(1)).toEqual(['/accounts/alice/packages', { op: 'install', name: 'Config_Lite', expectedRevision: 'a'.repeat(64) }, true, 'POST'])
  })
  it('projects out artifact PHP contents and recovery snapshots', () => {
    const raw = { ...view('install'), transaction: { secret: 'preimage' }, packages: [{ ...pkg, sourceContent: '<?php secret', files: [{ ...pkg.files[0]!, content: '<?php secret' }] }] }
    const projected = projectAccountPackagesView(raw, account, { op: 'install', name: 'Config_Lite', expectedRevision: 'a'.repeat(64) })
    expect(JSON.stringify(projected)).not.toContain('secret'); expect(projected).not.toHaveProperty('transaction')
  })
  it('refuses feature-disabled, foreign-role, selector and source-injected requests before dispatch', async () => {
    const t = setup(); t.disable(); await expect(t.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.readAgent).not.toHaveBeenCalled()
    const other = setup(); other.foreign(); await expect(other.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(other.readAgent).not.toHaveBeenCalled()
    const selector = setup(); await expect(selector.route('GET', undefined, '?accountId=foreign')).rejects.toMatchObject({ code: 'VALIDATION' }); await expect(selector.route('POST', { op: 'install', name: 'Config_Lite', expectedRevision: 'a'.repeat(64), url: 'https://example.com' })).rejects.toMatchObject({ code: 'VALIDATION' }); expect(selector.readAgent).not.toHaveBeenCalled()
  })
  it('rechecks feature revocation after transport and refuses uncertain or wrong-name mutation replies', async () => {
    const t = setup(); t.readAgent.mockImplementation(async () => { t.disable(); return view() }); await expect(t.route()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    const other = setup(); other.readAgent.mockImplementation(async () => ({ ...view('install'), packages: [] })); await expect(other.route('POST', { op: 'install', name: 'Config_Lite', expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
  })
  it('rejects inconsistent dependency, recovery and catalog capabilities', () => {
    for (const raw of [{ ...view(), catalogRevision: null }, { ...view(), inventory: 'recovery-required' }, { ...view(), capabilities: { install: true, remove: true, recover: true } }, { ...view('install'), packages: [{ ...pkg, requires: [{ name: 'Missing', version: '1.0.0' }] }] }, { ...view(), details: { unknownOutcome: true } }]) expect(() => projectAccountPackagesView(raw, account, { op: 'read' })).toThrow()
  })
})
