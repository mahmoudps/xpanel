import { describe, expect, it } from 'vitest'
import { renderAccountFilters } from './account-filters.ts'

describe('account filter configuration view', () => {
  it('keeps unread mailbox inventory and empty inventory distinct', () => {
    expect(renderAccountFilters({expectedAccountId:'account-a',lang:'en',canManage:false})).toContain('Mailbox options have not been read.')
    expect(renderAccountFilters({expectedAccountId:'account-a',lang:'en',canManage:false,mailboxes:[]})).not.toContain('Mailbox options have not been read.')
  })
  it('does not expose a write form or account IDs in the read-only view', () => {
    const html=renderAccountFilters({expectedAccountId:'account-a',lang:'en',canManage:false,mailboxes:[{login:'a@tenant.test'}]})
    expect(html).not.toContain('<form')
    expect(html).not.toContain('data-filter-new')
    expect(html).not.toContain('name="accountId"')
    expect(html).toContain('data-filter-refresh')
  })
  it('retains all required configuration actions and truthful native limitations', () => {
    const html=renderAccountFilters({expectedAccountId:'account-a',lang:'en',canManage:true,mailboxes:[]})
    for(const text of ['Filter name','Match mode','Add condition','Action','Save configuration','With no conditions','whether the mail server runs it','Add action','Stop processing later rules','Test a message','Run test'])expect(html).toContain(text)
    expect(html).toContain('data-filter-editor')
    expect(html).toContain('hidden')
    expect(html).not.toContain('name="accountId"')
    expect(html).not.toContain('type="password"')
  })
  it('escapes mailbox option content and values', () => {
    const html=renderAccountFilters({expectedAccountId:'account-a',lang:'en',canManage:true,mailboxes:[{login:'"><img src=x onerror=bad>'}]})
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
  it('provides Arabic labels, RTL, live feedback and keyboard preview access', () => {
    const html=renderAccountFilters({expectedAccountId:'account-a',lang:'ar',canManage:true,mailboxes:[{login:'a@tenant.test'}]})
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('نطاق المرشحات')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('<pre tabindex="0"')
  })
})
