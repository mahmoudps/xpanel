// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailContactGroups } from './board-port/xmail-contact-groups.ts'
import { renderMailContactsWorkspace } from './board-port/xmail-contacts.ts'
import { MAIL_CONTACT_GROUPS_CLIENT_BINDING } from './mail-contact-groups-client.ts'
import { MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING, type MailContact } from './mail-contacts-workspace-client.ts'

const mailbox = 'reader@example.test'
const id = '10000000-0000-4000-8000-000000000001'
const sharedId = '10000000-0000-4000-8000-000000000002'
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const contact = (): MailContact => ({ id, owner: mailbox, fullName: 'Alice Example', email: 'alice@example.test', phone: '', organization: '', title: '', groups: ['Team'], shares: [], vcard: 'BEGIN:VCARD\nEND:VCARD', createdAt: '2026-10-26T00:00:00Z', revision: 'a'.repeat(64) })
const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const element = <T extends HTMLElement>(key: string): T => document.querySelector<T>('[data-groups-' + key + ']')!
const button = (key: string) => element<HTMLButtonElement>(key)
const state = () => element('status').dataset.state
const inputName = (value: string) => { element<HTMLInputElement>('name').value = value; element('name').dispatchEvent(new Event('input')) }
const selectValues = (key: string, values: string[]) => { const input = element<HTMLSelectElement>(key); for (const option of input.options) option.selected = values.includes(option.value); input.dispatchEvent(new Event('change')) }
let listeners: Array<[string, EventListenerOrEventListenerObject]>

beforeEach(() => {
  document.body.innerHTML = renderMailContactGroups({ locale: 'en', mailbox, canManage: true })
  listeners = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => { listeners.push([name, listener]); add(name, listener, options) })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const [name, listener] of listeners) window.removeEventListener(name, listener); vi.restoreAllMocks(); document.body.replaceChildren() })

const model = () => {
  let version = 1, definitions = ['Team'], mode = 'normal'
  let contacts = [contact()]
  let maxContacts = 10000, maxGroups = 256, maxGroupsPerContact = 32
  const hash = () => version.toString(16).padStart(64, '0')
  const capacity = () => ({ ownedContacts: contacts.filter(row => row.owner === mailbox).length, maxContacts, groups: definitions.length, maxGroups, maxGroupsPerContact })
  const group = (name: string) => ({ name, contactIds: contacts.filter(row => row.owner === mailbox && row.groups.includes(name)).map(row => row.id), revision: hash() })
  const listing = () => ({ metadataReview: { status: mode === 'invalid-review' ? 'verified' : 'review_required', reason: 'mailbox_metadata_binding_unverified' }, context: { mailbox: mode === 'foreign-context' ? 'foreign@example.test' : mailbox }, groups: definitions.map(group), contacts: contacts.filter(row=>row.owner===mailbox).map(({id,owner,fullName,email,groups,revision})=>({id,owner,fullName,email,groups,revision})), revision: hash(), capacity: capacity() })
  const send = vi.fn(async (method: string, path: string, raw?: unknown) => {
    if (method === 'GET' && path === '/api/webmail/contact-groups' && mode === 'budget-refusal') throw { status: 412, details: { reason: 'contact_groups_read_budget', stateChanged: false } }
    if (method === 'GET') return path === '/api/webmail/contact-groups' ? clone(listing()) : { context: { mailbox }, contacts: clone(contacts) }
    if (mode === 'denied') throw { status: 422, details: { stateChanged: false } }
    if (mode === 'uncertain') throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }
    const body = raw as { expectedRevision: string; name?: string; contactIds?: string[]; groups?: string[] }
    const oldName = path.startsWith('/api/webmail/contact-groups/') ? decodeURIComponent(path.split('/').at(-1)!) : null
    const membership = path.endsWith('/groups') && path.startsWith('/api/webmail/contacts/')
    if (body.expectedRevision !== (membership ? contacts.find(row => path.includes(row.id))!.revision : hash())) throw { status: 409, details: { stateChanged: false } }
    version++
    let reply: Record<string, unknown>
    if (membership) {
      const targetId = path.split('/').at(-2)!
      contacts = contacts.map(row => row.id === targetId ? { ...row, groups: body.groups!, revision: hash() } : row)
      reply = { context: { mailbox }, contact: clone(contacts.find(row => row.id === targetId)), stateChanged: true }
    } else if (method === 'DELETE') {
      definitions = definitions.filter(name => name !== oldName)
      contacts = contacts.map(row => row.owner === mailbox && row.groups.includes(oldName!) ? { ...row, groups: row.groups.filter(name => name !== oldName), revision: hash() } : row)
      reply = { context: { mailbox }, deletedGroup: oldName, revision: hash(), capacity: capacity(), stateChanged: true }
    } else {
      definitions = [...definitions.filter(name => name !== oldName), body.name!]
      contacts = contacts.map(row => row.owner !== mailbox ? row : { ...row, groups: [...row.groups.filter(name => name !== oldName && name !== body.name), ...(body.contactIds!.includes(row.id) ? [body.name!] : [])], revision: hash() })
      reply = { context: { mailbox }, group: group(body.name!), revision: hash(), capacity: capacity(), stateChanged: true }
    }
    if (mode === 'wrong-ack') reply.context = { mailbox: 'wrong@example.test' }
    return reply
  })
  const ask = vi.fn(async (_options: Record<string, unknown>) => true)
  const boot = (combined = false) => {
    (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    if (combined) new Function('return ' + MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING)()(ask)
    new Function('return ' + MAIL_CONTACT_GROUPS_CLIENT_BINDING)()(ask)
  }
  return { send, ask, boot, setMode: (value: string) => { mode = value }, bump: () => { version++ }, setContacts: (value: MailContact[]) => { contacts = value }, setDefinitions: (value: string[]) => { definitions = value }, setMembershipLimit: (value: number) => { maxGroupsPerContact = value }, setLimits: (contactLimit: number, groupLimit = 256) => { maxContacts = contactLimit; maxGroups = groupLimit }, getContacts: () => contacts, writes: () => send.mock.calls.filter(call => call[0] !== 'GET') }
}

describe('mailbox contact groups and membership', () => {
  it.each(['bound', 'empty'])('keeps fixed metadata review guidance for %s current-lifetime data', async profile => {
    const m = model(); if (profile === 'empty') { m.setContacts([]); m.setDefinitions([]) }
    const notice = document.querySelector('[data-groups-metadata-review]')!.textContent
    m.boot(); await tick()
    expect(state()).toBe('read')
    expect(document.querySelector('[data-groups-metadata-review]')!.textContent).toBe(notice)
    expect(notice).toBe('Older mailbox metadata may require verified ownership review before it can be shown. Records are preserved.')
    expect(m.writes()).toHaveLength(0)
  })

  it('refuses a malformed metadata review status while retaining standing guidance', async () => {
    const m = model(); m.setMode('invalid-review'); m.boot(); await tick()
    expect(state()).toBe('failed'); expect(button('save').disabled).toBe(true)
    expect(document.querySelector('[data-groups-metadata-review]')!.textContent).toContain('Records are preserved.')
    expect(m.writes()).toHaveLength(0)
  })

  it('serializes without a separate fetch or HTML injection path', () => {
    expect(() => new Function('return ' + MAIL_CONTACT_GROUPS_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_CONTACT_GROUPS_CLIENT_BINDING).not.toContain('fetch(')
    expect(MAIL_CONTACT_GROUPS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('keeps all controls unavailable without an admitted transport', async () => {
    new Function('return ' + MAIL_CONTACT_GROUPS_CLIENT_BINDING)()(undefined)
    expect(state()).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')].every(input => input.disabled)).toBe(true)
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })
  it('reads server capacity and only owned contacts as membership choices', async () => {
    const f = model(); f.setContacts([contact(), { ...contact(), id: sharedId, owner: 'other@example.test', shares: [{ principal: mailbox, permission: 'read-write', sharedAt: '2026-10-26T00:00:00Z' }] }]); f.boot(); await tick()
    expect(state()).toBe('read')
    expect(element('contact-capacity').textContent).toBe('1 / 10000')
    expect(element('capacity').textContent).toBe('1 / 256')
    expect([...element<HTMLSelectElement>('members').options].map(option => option.value)).toEqual([id])
    expect(document.body.textContent).not.toContain(id)
  })
  it('creates a named group with the exact collection revision and verified membership', async () => {
    const f = model(); f.boot(); await tick(); inputName('Friends'); selectValues('members', [id]); button('save').click(); await tick()
    expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]).toEqual(['POST', '/api/webmail/contact-groups', { name: 'Friends', contactIds: [id], expectedRevision: '1'.padStart(64, '0') }])
    expect(state()).toBe('saved'); expect(f.getContacts()[0]!.groups).toContain('Friends')
  })
  it('renames a selected group without losing contacts', async () => {
    const f = model(); f.boot(); await tick(); element<HTMLSelectElement>('select').value = 'Team'; element('select').dispatchEvent(new Event('change')); await tick()
    inputName('Colleagues'); button('save').click(); await tick()
    expect(f.writes()[0]).toEqual(['PATCH', '/api/webmail/contact-groups/Team', { name: 'Colleagues', contactIds: [id], expectedRevision: '1'.padStart(64, '0') }])
    expect(f.getContacts()).toHaveLength(1); expect(f.getContacts()[0]!.groups).toEqual(['Colleagues']); expect(state()).toBe('saved')
  })
  it('deletes the group after confirmation while preserving its contacts', async () => {
    const f = model(); f.boot(); await tick(); element<HTMLSelectElement>('select').value = 'Team'; element('select').dispatchEvent(new Event('change')); await tick()
    button('delete').click(); await tick()
    expect(f.ask.mock.calls[0]![0]).toMatchObject({ danger: true })
    expect(f.writes()[0]).toEqual(['DELETE', '/api/webmail/contact-groups/Team', { expectedRevision: '1'.padStart(64, '0') }])
    expect(f.getContacts()).toHaveLength(1); expect(f.getContacts()[0]!.groups).toEqual([]); expect(state()).toBe('saved')
  })
  it('updates the selected contact membership using its captured contact revision', async () => {
    const f = model(); f.boot(); await tick(); element<HTMLSelectElement>('contact').value = id; element('contact').dispatchEvent(new Event('change')); await tick()
    selectValues('membership', []); button('membership-save').click(); await tick()
    expect(f.writes()[0]).toEqual(['PUT', '/api/webmail/contacts/' + id + '/groups', { groups: [], expectedRevision: 'a'.repeat(64) }])
    expect(f.getContacts()[0]!.fullName).toBe('Alice Example'); expect(f.getContacts()[0]!.groups).toEqual([]); expect(state()).toBe('saved')
  })
  it('cancels a mutation without a read or write and keeps the draft', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick(); inputName('Keep draft')
    const calls = f.send.mock.calls.length; button('save').click(); await tick()
    expect(f.send.mock.calls).toHaveLength(calls); expect(element<HTMLInputElement>('name').value).toBe('Keep draft')
  })
  it.each(['bad\u202ename', 'bad\u061cname', 'bad\u200ename', 'bad\u200fname', 'a'.repeat(65)])('refuses invalid names locally before confirmation or dispatch: %j', async value => {
    const f = model(); f.boot(); await tick(); inputName(value); button('save').click(); await tick()
    expect(state()).toBe('failed'); expect(f.ask).not.toHaveBeenCalled(); expect(f.writes()).toHaveLength(0)
  })
  it('accepts a group name of 64 Unicode code points even when it uses 128 UTF-16 units', async () => {
    const f = model(); f.boot(); await tick(); inputName('😀'.repeat(64)); button('save').click(); await tick()
    expect(state()).toBe('saved'); expect(f.writes()[0]![2]).toMatchObject({ name: '😀'.repeat(64) })
  })
  it('keeps creation disabled at the group limit while allowing an existing group to be renamed', async () => {
    const f = model(); f.setLimits(10000, 1); f.boot(); await tick(); inputName('Unavailable new group')
    expect(button('new').disabled).toBe(true); expect(button('save').disabled).toBe(true)
    element<HTMLSelectElement>('select').value = 'Team'; element('select').dispatchEvent(new Event('change')); await tick(); inputName('Renamed')
    expect(button('save').disabled).toBe(false); button('save').click(); await tick(); expect(state()).toBe('saved')
  })
  it('keeps a stale group draft locked until an explicit confirmed reload', async () => {
    const f = model(); f.boot(); await tick(); inputName('My group'); f.bump(); button('save').click(); await tick()
    expect(state()).toBe('stale'); expect(f.writes()).toHaveLength(0); expect(element<HTMLInputElement>('name').value).toBe('My group')
    f.ask.mockResolvedValue(false); button('reload').click(); await tick(); expect(state()).toBe('stale')
    f.ask.mockResolvedValue(true); button('reload').click(); await tick(); expect(state()).toBe('read'); expect(element<HTMLInputElement>('name').value).toBe('')
  })
  it.each(['uncertain', 'wrong-ack'])('locks %s outcomes without retrying or clearing the draft', async mode => {
    const f = model(); f.boot(); await tick(); inputName('My group'); f.setMode(mode); button('save').click(); await tick()
    expect(state()).toBe('uncertain'); expect(f.writes()).toHaveLength(1); expect(button('save').disabled).toBe(true); expect(element<HTMLInputElement>('name').value).toBe('My group')
  })
  it('keeps a definitely refused group editable', async () => {
    const f = model(); f.boot(); await tick(); inputName('My group'); f.setMode('denied'); button('save').click(); await tick()
    expect(state()).toBe('failed'); expect(button('save').disabled).toBe(false); expect(element<HTMLInputElement>('name').value).toBe('My group')
  })
  it('rejects a foreign mailbox context before enabling mutations', async () => {
    const f = model(); f.setMode('foreign-context'); f.boot(); await tick()
    expect(state()).toBe('failed'); expect(button('save').disabled).toBe(true); expect(f.writes()).toHaveLength(0)
  })
  it('preserves unsaved edits when another connected contact tool changes the collection', async () => {
    const f = model(); f.boot(); await tick(); inputName('My group')
    window.dispatchEvent(new CustomEvent('xpanel:contacts-changed', { detail: { source: 'contact-tools', mailbox } })); await tick()
    expect(state()).toBe('stale'); expect(element<HTMLInputElement>('name').value).toBe('My group'); expect(f.writes()).toHaveLength(0)
  })
  it('ignores events from another mailbox and sends no extra read', async () => {
    const f = model(); f.boot(); await tick(); const count = f.send.mock.calls.length
    window.dispatchEvent(new CustomEvent('xpanel:contacts-changed', { detail: { source: 'contact-tools', mailbox: 'foreign@example.test' } })); await tick()
    expect(f.send.mock.calls).toHaveLength(count)
  })
  it('publishes verified capacity to the existing editor and disables new contacts at the limit', async () => {
    document.body.innerHTML = renderMailContactsWorkspace({ locale: 'en', mailbox, canManage: true })
    const f = model(); f.setLimits(1); f.boot(true); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-contact-new]')!.disabled).toBe(true)
    expect(element('contact-capacity').textContent).toBe('1 / 1')
  })
  it('preserves a dirty main contact draft and requires review after group membership changes its revision', async () => {
    document.body.innerHTML = renderMailContactsWorkspace({ locale: 'en', mailbox, canManage: true })
    const f = model(); f.boot(true); await tick()
    document.querySelector<HTMLButtonElement>('[data-contact-select]')!.click(); await tick()
    const title = document.querySelector<HTMLInputElement>('[data-contact-form] [name="title"]')!
    title.value = 'Unsent draft'; title.dispatchEvent(new Event('input', { bubbles: true }))
    element<HTMLSelectElement>('contact').value = id; element('contact').dispatchEvent(new Event('change')); await tick()
    selectValues('membership', []); button('membership-save').click(); await tick()
    expect(state()).toBe('saved')
    expect(document.querySelector<HTMLElement>('[data-contact-status]')!.dataset.state).toBe('stale')
    expect(title.value).toBe('Unsent draft')
    expect(document.querySelector<HTMLButtonElement>('[data-contact-save]')!.disabled).toBe(true)
    expect(f.writes()).toHaveLength(1)
  })
  it('reads actual over-capacity contacts and permits a non-growing group rename without hiding rows', async()=>{
    const f=model();f.setContacts([contact(),{...contact(),id:'10000000-0000-4000-8000-000000000003',fullName:'Bob Example',email:'bob@example.test'}]);f.setLimits(1,1);f.boot();await tick()
    expect(state()).toBe('read');expect(element('contact-capacity').textContent).toBe('2 / 1');expect(element<HTMLSelectElement>('members').options).toHaveLength(2)
    element<HTMLSelectElement>('select').value='Team';element('select').dispatchEvent(new Event('change'));await tick();inputName('Renamed');button('save').click();await tick()
    expect(state()).toBe('saved');expect(f.getContacts()).toHaveLength(2);expect(f.getContacts().every(row=>row.groups.includes('Renamed'))).toBe(true)
  })
  it('keeps an over-limit contact membership count when reassigning without growth',async()=>{
    const f=model();f.setDefinitions(['Team','Friends','Family','Neighbors']);f.setContacts([{...contact(),groups:['Team','Friends','Family']}]);f.setMembershipLimit(2);f.boot();await tick()
    element<HTMLSelectElement>('contact').value=id;element('contact').dispatchEvent(new Event('change'));await tick();selectValues('membership',['Team','Friends','Neighbors']);button('membership-save').click();await tick()
    expect(state()).toBe('saved');expect(f.getContacts()[0]!.groups).toEqual(['Team','Friends','Neighbors'])
  })
  it('refuses further membership growth when a legacy contact is already over its limit',async()=>{
    const f=model();f.setDefinitions(['Team','Friends','Family','Neighbors']);f.setContacts([{...contact(),groups:['Team','Friends','Family']}]);f.setMembershipLimit(2);f.boot();await tick()
    element<HTMLSelectElement>('contact').value=id;element('contact').dispatchEvent(new Event('change'));await tick();selectValues('membership',['Team','Friends','Family','Neighbors']);button('membership-save').click();await tick()
    expect(state()).toBe('failed');expect(f.writes()).toHaveLength(0);expect(f.getContacts()[0]!.groups).toHaveLength(3)
  })
  it('reports a separate operational read budget without truncating or pretending an empty collection',async()=>{
    const f=model();f.setDefinitions(['Team',...Array.from({length:4096},(_,index)=>'Legacy '+index)]);f.boot();await tick()
    expect(state()).toBe('unavailable');expect(element('status').textContent).toContain('no data was truncated or changed');expect(element('capacity').textContent).toBe('Not read');expect(f.writes()).toHaveLength(0)
  })

  it('keeps truthful over-capacity groups visible and permits deletion without disabling other records',async()=>{
    const f=model();f.setDefinitions(['Team','Friends','Family']);f.setLimits(10000,1);f.boot();await tick()
    expect(state()).toBe('read');expect(element('capacity').textContent).toBe('3 / 1');expect(element<HTMLSelectElement>('select').options).toHaveLength(4);expect(button('new').disabled).toBe(true)
    element<HTMLSelectElement>('select').value='Team';element('select').dispatchEvent(new Event('change'));await tick();button('delete').click();await tick()
    expect(state()).toBe('saved');expect(element('capacity').textContent).toBe('2 / 1');expect(f.getContacts()).toHaveLength(1)
  })
  it('encodes an existing Unicode group selector without rewriting or truncating its identity',async()=>{
    const oldName='الفريق / Europe?'
    const f=model();f.setDefinitions([oldName]);f.setContacts([{...contact(),groups:[oldName]}]);f.boot();await tick()
    element<HTMLSelectElement>('select').value=oldName;element('select').dispatchEvent(new Event('change'));await tick();inputName('Updated');button('save').click();await tick()
    expect(f.writes()[0]![1]).toBe('/api/webmail/contact-groups/'+encodeURIComponent(oldName));expect(state()).toBe('saved');expect(f.getContacts()[0]!.groups).toEqual(['Updated'])
  })
  it('keeps existing contact editing and deletion available when only group reading exceeds its budget',async()=>{
    document.body.innerHTML=renderMailContactsWorkspace({locale:'en',mailbox,canManage:true})
    const f=model();f.setMode('budget-refusal');f.boot(true);await tick();expect(state()).toBe('unavailable')
    document.querySelector<HTMLButtonElement>('[data-contact-select]')!.click();await tick()
    const title=document.querySelector<HTMLInputElement>('[data-contact-form] [name="title"]')!;title.value='Still editable';title.dispatchEvent(new Event('input',{bubbles:true}))
    expect(title.disabled).toBe(false);expect(document.querySelector<HTMLButtonElement>('[data-contact-save]')!.disabled).toBe(false);expect(document.querySelector<HTMLButtonElement>('[data-contact-delete]')!.disabled).toBe(false)
  })

})
