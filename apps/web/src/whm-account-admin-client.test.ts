import { describe, expect, it } from 'vitest'
import { readAccountAdminView } from './whm-account-admin-client.ts'
import { rankSearchHits } from './whm-home-client.ts'

const row = { id: 'a', username: 'alice', primaryDomain: 'a.test', status: 'active', home: '/home/alice', shell: 'none', planShell: 'none', shellSource: 'package', forcedPassword: false, homeMove: null }

describe('account administration client', () => {
  it('reads the rows and the home roots strictly', () => {
    expect(readAccountAdminView({ accounts: [row], homeRoots: [{ path: '/home2', availableKb: 10, filesystem: '1' }] }).homeRoots?.[0]?.path).toBe('/home2')
    expect(readAccountAdminView({ accounts: [] }).homeRoots).toBeNull()
    for (const value of [{}, { accounts: 'x' }, { accounts: [{ ...row, shell: 'bash' }] }, { accounts: [{ ...row, username: 'Bad' }] }, { accounts: [{ ...row, forcedPassword: 'yes' }] }, { accounts: [], homeRoots: [{ path: '/etc', availableKb: 1, filesystem: null }] }, { accounts: [], homeRoots: 'x' }]) expect(() => readAccountAdminView(value)).toThrow()
  })
  it('ranks an exact match first and keeps only what has a page', () => {
    const hit = (kind: string, title: string) => ({ kind, entityId: title, accountId: 'a', title, subtitle: '' })
    expect(rankSearchHits([hit('account', 'alice2'), hit('plan', 'alice'), hit('domain', 'x'), hit('account', 'ALICE')], 'alice').map(item => item.title)).toEqual(['ALICE', 'alice2', 'x'])
  })
})
