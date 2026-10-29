// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailContactsTools } from './board-port/xmail-contacts-tools.ts'
import {
  MAIL_CONTACTS_TOOLS_CLIENT_BINDING, contactsToolsList, contactsToolsSharePayload, contactsToolsVcardPreview,
} from './mail-contacts-tools-client.ts'

const mailbox = 'inbox@example.test'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const peers = [{ id: 'c1', owner: mailbox, fullName: 'Contact One', email: 'one@example.test', shares: [] as { principal: string; permission: 'read' | 'read-write' }[] }]
const first = peers[0]!
const listReply = (contacts: typeof peers = peers) => ({ context: { mailbox }, contacts })
const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Imported Person\nEMAIL;TYPE=INTERNET:imported@example.test\nEND:VCARD'
const status = (selector: string) => document.querySelector<HTMLElement>(selector)!
const boot = (transport: ReturnType<typeof vi.fn>) => {
  (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
  new Function(`(${MAIL_CONTACTS_TOOLS_CLIENT_BINDING})((options) => Promise.resolve(true));`)()
}

describe('contacts tools helpers', () => {
  it('previews valid vCards and reports every problem before import', () => {
    expect(contactsToolsVcardPreview(vcard)).toEqual({ cards: 1, errors: [] })
    const two = vcard + '\n' + vcard.replace('Imported Person', 'Second Person')
    expect(contactsToolsVcardPreview(two)).toEqual({ cards: 2, errors: [] })
    expect(contactsToolsVcardPreview('').errors).toEqual(['empty'])
    expect(contactsToolsVcardPreview('<script>x</script>').errors).toEqual(['unsafe'])
    expect(contactsToolsVcardPreview('BEGIN:VCARD\nFN:No email\nEND:VCARD').errors).toContain('missing_name_or_email:1')
    expect(contactsToolsVcardPreview('BEGIN:VCARD\nBEGIN:VCARD').errors).toContain('nested')
    expect(contactsToolsVcardPreview('END:VCARD').errors).toContain('unmatched')
    expect(contactsToolsVcardPreview('BEGIN:VCARD\nFN:x').errors).toContain('unterminated')
  })
  it('validates sharing payloads and the contacts list shape', () => {
    expect(contactsToolsSharePayload(' Teammate@Example.Test ', 'read-write')).toEqual({ principal: 'teammate@example.test', permission: 'read-write' })
    expect(() => contactsToolsSharePayload('not-an-email', 'read')).toThrow('invalid_share_principal')
    expect(() => contactsToolsSharePayload('a@b.test', 'write')).toThrow('invalid_share_permission')
    expect(contactsToolsList(listReply(), mailbox)).toEqual(peers)
    for (const bad of [{ context: { mailbox: 'foreign@example.test' }, contacts: [] }, { context: { mailbox }, contacts: [{ id: 'x' }] }, { context: { mailbox }, contacts: [{ ...first, shares: [{ principal: 'a@b.test', permission: 'owner' }] }] }, null]) expect(() => contactsToolsList(bad, mailbox)).toThrow()
  })
})

describe('contacts tools browser binding', () => {
  beforeEach(() => {
    document.body.innerHTML = renderMailContactsTools({ locale: 'en', mailbox, canManage: true })
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  it('constructs the serialized binding and renders the approved tools section', () => {
    expect(() => new Function('return ' + MAIL_CONTACTS_TOOLS_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_CONTACTS_TOOLS_CLIENT_BINDING).not.toContain('fetch(')
    expect(document.querySelector('[data-mail-contacts-tools]')).not.toBeNull()
    expect(document.querySelectorAll('[data-contacts-tools-section]')).toHaveLength(3)
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })
  it('leaves every control disabled and explicit without a transport', () => {
    new Function(`(${MAIL_CONTACTS_TOOLS_CLIENT_BINDING})(undefined);`)()
    for (const node of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-mail-contacts-tools] button, [data-mail-contacts-tools] input, [data-mail-contacts-tools] textarea, [data-mail-contacts-tools] select')) expect(node.disabled).toBe(true)
    expect(status('[data-contacts-import-status]').dataset.state).toBe('unavailable')
  })
  it('previews then imports reviewed cards and verifies the readback', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    let stored = listReply()
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (path === '/api/webmail/contacts' && method === 'GET') return stored
      if (path === '/api/webmail/contacts/import') {
        if (body && typeof body === 'object' && typeof (body as { vcard?: unknown }).vcard === 'string' && (body as { vcard: string }).vcard.includes('Imported Person')) {
          const imported = { ...first, id: 'imported-1', fullName: 'Imported Person', email: 'imported@example.test' }
          stored = listReply([...peers, imported])
          return { contacts: [imported], importedCount: 1 }
        }
        throw { status: 422, details: { stateChanged: false } }
      }
      throw new Error('unexpected_request ' + path)
    })
    boot(transport); await tick()
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-contacts-import-text]')!
    textarea.value = vcard; textarea.dispatchEvent(new Event('input', { bubbles: true }))
    expect(status('[data-contacts-import-preview]').dataset.state).toBe('ready')
    document.querySelector<HTMLButtonElement>('[data-contacts-import]')!.click(); await tick(); await tick()
    const imported = calls.find(call => call.path === '/api/webmail/contacts/import')
    expect(imported).toMatchObject({ method: 'POST', body: { vcard } })
    expect(status('[data-contacts-import-status]').dataset.state).toBe('saved')
    expect(status('[data-contacts-import-status]').textContent).toContain('1 card(s)')
    expect(calls.filter(call => call.method === 'GET' && call.path === '/api/webmail/contacts').length).toBeGreaterThan(1)
  })
  it('downloads exactly the server export document and reports its count', async () => {
    const transport = vi.fn(async (method: string, path: string) => {
      if (path === '/api/webmail/contacts') return listReply()
      if (path === '/api/webmail/contacts/export') return { mailbox, vcard, count: 1 }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    document.querySelector<HTMLButtonElement>('[data-contacts-export]')!.click(); await tick(); await tick()
    expect(status('[data-contacts-export-status]').dataset.state).toBe('saved')
    expect(status('[data-contacts-export-status]').textContent).toContain('1 contact(s)')
  })
  it('adds and removes sharing with confirmation and readback verification', async () => {
    let shares: { principal: string; permission: 'read' | 'read-write' }[] = []
    const calls: { method: string; path: string; body?: unknown }[] = []
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (path === '/api/webmail/contacts' && method === 'GET') return listReply([{ ...first, shares }])
      if (path.endsWith('/share') && method === 'POST') {
        const payload = body as { principal: string; permission: 'read' | 'read-write' }
        shares = [...shares, payload]
        return { contact: { ...first, shares } }
      }
      if (path.endsWith('/share') && method === 'DELETE') {
        const payload = body as { principal: string }
        shares = shares.filter(share => share.principal !== payload.principal)
        return { contact: { ...first, shares } }
      }
      throw new Error('unexpected_request ' + method + ' ' + path)
    })
    boot(transport); await tick()
    document.querySelector<HTMLInputElement>('[data-contacts-share-principal]')!.value = 'teammate@example.test'
    document.querySelector<HTMLSelectElement>('[data-contacts-share-permission]')!.value = 'read'
    document.querySelector<HTMLButtonElement>('[data-contacts-share-add]')!.click(); await tick(); await tick()
    expect(calls.find(call => call.method === 'POST')).toMatchObject({ path: '/api/webmail/contacts/c1/share', body: { principal: 'teammate@example.test', permission: 'read' } })
    expect(status('[data-contacts-share-status]').dataset.state).toBe('saved')
    expect(document.querySelectorAll('[data-contacts-shares] li button')).toHaveLength(1)
    document.querySelector<HTMLButtonElement>('[data-contacts-shares] li button')!.click(); await tick(); await tick()
    expect(calls.some(call => call.method === 'DELETE' && String(call.path).endsWith('/share'))).toBe(true)
    expect(document.querySelectorAll('[data-contacts-shares] li button')).toHaveLength(0)
  })
  it.each([true,false])('notifies connected contacts only after verified import readback: %s', async verified => {
    const notices: unknown[] = []
    const notice = (event: Event) => notices.push((event as CustomEvent).detail)
    window.addEventListener('xpanel:contacts-changed', notice)
    let stored = listReply(), posted = 0
    const imported = {...first,id:'imported-notice',fullName:'Imported Person',email:'imported@example.test'}
    const transport = vi.fn(async (method:string,path:string) => {
      if(method==='GET'&&path==='/api/webmail/contacts')return stored
      if(method==='POST'&&path==='/api/webmail/contacts/import'){posted++;if(verified)stored=listReply([...peers,imported]);return {contacts:[imported],importedCount:1}}
      throw new Error('unexpected_request')
    })
    try {
      boot(transport);await tick()
      const textarea=document.querySelector<HTMLTextAreaElement>('[data-contacts-import-text]')!
      textarea.value=vcard;textarea.dispatchEvent(new Event('input',{bubbles:true}))
      document.querySelector<HTMLButtonElement>('[data-contacts-import]')!.click();await tick();await tick()
      expect(posted).toBe(1)
      expect(notices).toEqual(verified?[{source:'contact-tools',mailbox}]:[])
      if(verified)expect(status('[data-contacts-import-status]').dataset.state).toBe('saved')
      else expect(status('[data-contacts-import-status]').dataset.state).not.toBe('saved')
    } finally {window.removeEventListener('xpanel:contacts-changed',notice)}
  })

  it.each([
    ['refused',{status:422,details:{stateChanged:false}},'failed',false],
    ['uncertain',{status:503,details:{stateChanged:true,unknownOutcome:true}},'uncertain',true],
  ] as const)('keeps %s import feedback in the import section and preserves its draft',async(_name,failure,wanted,locked)=>{
    let posted=0
    const notices:unknown[]=[]
    const notice=(event:Event)=>notices.push((event as CustomEvent).detail)
    window.addEventListener('xpanel:contacts-changed',notice)
    const transport=vi.fn(async(method:string,path:string)=>{
      if(method==='GET'&&path==='/api/webmail/contacts')return listReply()
      if(method==='POST'&&path==='/api/webmail/contacts/import'){posted++;throw failure}
      throw new Error('unexpected_request')
    })
    try {
      boot(transport);await tick()
      const textarea=document.querySelector<HTMLTextAreaElement>('[data-contacts-import-text]')!
      textarea.value=vcard;textarea.dispatchEvent(new Event('input',{bubbles:true}))
      const button=document.querySelector<HTMLButtonElement>('[data-contacts-import]')!
      button.click();await tick();await tick()
      expect(status('[data-contacts-import-status]').dataset.state).toBe(wanted)
      expect(status('[data-contacts-import-status]').hidden).toBe(false)
      expect(textarea.value).toBe(vcard)
      expect(button.disabled).toBe(locked)
      expect(status('[data-contacts-share-status]').dataset.state).not.toBe(wanted)
      expect(posted).toBe(1);expect(notices).toEqual([])
    } finally {window.removeEventListener('xpanel:contacts-changed',notice)}
  })

})
