import { describe, expect, it, vi } from 'vitest'
import { handleAccountPackagesWorkspaceRoute, projectAccountPackagesView } from './account-packages-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const view = { context: { accountId, username: 'alpha' }, ecosystem: 'pear', library: '/home/alpha/php', includeSnippet: '', phpVersion: '8.3', engine: true, requiredPackage: 'php-pear', revision: 'a'.repeat(64), packages: [{ name: 'Config_Lite', version: '0.2.6' }], system: [{ name: 'PEAR', version: null }], results: [] }
const ports = (reply: unknown) => {
  const caller = { principal: { kind: 'user', id: 'p', username: 'alpha', accountId }, sessionId: 's', apiTokenId: null }
  const readAgent = vi.fn(async () => reply)
  return { readAgent, value: { requireCaller: async () => caller, store: { getAccount: async () => ({ id: accountId, username: 'alpha', status: 'active', planId: 'plan' }), getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ disabled: [] }) }, readAgent } as unknown as AccountSshPorts }
}
describe('account PEAR packages API', () => {
  it('only passes a reply bound to the signed-in account', () => {
    expect(projectAccountPackagesView(view, accountId)).toEqual(view)
    expect(() => projectAccountPackagesView({ ...view, context: { accountId: 'b', username: 'x' } }, accountId)).toThrow()
    expect(() => projectAccountPackagesView({ ...view, packages: [{ name: '../x', version: '1' }] }, accountId)).toThrow()
  })
  it('ignores other paths and refuses selectors', async () => {
    const f = ports(view), other = new URL('http://local/api/account/other')
    expect(await handleAccountPackagesWorkspaceRoute(new Request(other), other, 'GET', f.value)).toBeNull()
    const url = new URL('http://local/api/account/packages?account=x')
    await expect(handleAccountPackagesWorkspaceRoute(new Request(url), url, 'GET', f.value)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
