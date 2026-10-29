// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAccountCollaborationWorkspace } from './board-port/account-collaboration-workspace.ts'
import { ACCOUNT_COLLABORATION_CLIENT_BINDING, readAccountCollaboration } from './account-collaboration-client.ts'

const mailbox = 'inbox@owner.example.test', sibling = 'sibling@owner.example.test'
const initial = () => ({ context: { account: 'owner' }, source: 'saved-mailbox-metadata', mailboxes: [{ mailbox, revision: 'a'.repeat(64), canCreateCalendar: true, contacts: { count: 2, groupCount: 1 }, calendars: [{ name: 'Work', color: '#4f6bed', timezone: 'UTC', eventCount: 1, shares: [{ mailbox: sibling, permission: 'read' }] }] }, { mailbox: sibling, revision: 'c'.repeat(64), canCreateCalendar: true, contacts: { count: 0, groupCount: 0 }, calendars: [] }], capabilities: { createCalendar: true, caldav: false, carddav: false, addressBookCollections: false, taskLists: false, protectedDefaults: false }, application: { status: 'saved_metadata', nativeApplied: false, syncVerified: false } })
const clone = <T>(raw: T): T => JSON.parse(JSON.stringify(raw)) as T
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const control = <T extends HTMLElement = HTMLElement>(key: string): T => document.querySelector<T>('[data-collaboration-' + key + ']')!
let listeners: EventListener[]
beforeEach(() => {
  listeners = []; const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = renderAccountCollaborationWorkspace({ locale: 'en', canManage: true })
})
afterEach(() => { for (const listener of listeners) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
const fixture = () => {
  let saved = initial(), mode = 'normal'
  const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET') { if (mode === 'read-failure') throw new Error('Synthetic read failure'); return clone(saved) }
    expect(path).toBe('/api/account/collaboration/calendars')
    if (mode === 'conflict') throw { details: { stateChanged: false } }
    if (mode === 'unknown') throw new Error('Synthetic interrupted write')
    const raw = body as { mailbox: string; expectedRevision: string; name: string; color: string; timezone: string }
    expect(raw.mailbox).toBe(mailbox); expect(raw.expectedRevision).toBe(saved.mailboxes[0]!.revision)
    saved.mailboxes[0]!.revision = 'b'.repeat(64)
    saved.mailboxes[0]!.calendars.push({ name: raw.name, color: raw.color, timezone: raw.timezone, eventCount: 0, shares: [] })
    const ack = { ...clone(saved), stateChanged: true, created: { mailbox, name: raw.name, color: raw.color, timezone: raw.timezone } }
    if (mode === 'wrong-mailbox') ack.created.mailbox = sibling
    if (mode === 'mismatch') saved.mailboxes[0]!.calendars.pop()
    return ack
  })
  const ask = vi.fn(async () => true)
  const boot = async () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport; new Function('return ' + ACCOUNT_COLLABORATION_CLIENT_BINDING)()(ask); await tick(); await tick() }
  return { ask, transport, boot, setMode: (value: string) => { mode = value }, source: () => saved, writes: () => transport.mock.calls.filter(call => call[0] === 'POST') }
}
const edit = (text = 'Team') => { control<HTMLInputElement>('name').value = text; control('name').dispatchEvent(new Event('input', { bubbles: true })) }

describe('account collaboration metadata and actual create request binding', () => {
  it('requires complete saved source and rejects foreign recipient or fabricated synchronization claims', () => {
    expect(readAccountCollaboration(initial())?.mailboxes).toHaveLength(2)
    const foreign = initial(); foreign.mailboxes[0]!.calendars[0]!.shares[0]!.mailbox = 'foreign@other.example.test'
    expect(readAccountCollaboration(foreign)).toBeNull()
    expect(readAccountCollaboration({ ...initial(), application: { status: 'saved_metadata', nativeApplied: false, syncVerified: true } })).toBeNull()
    expect(ACCOUNT_COLLABORATION_CLIENT_BINDING).not.toMatch(/fetch\(|innerHTML/)
    expect(() => new Function('return ' + ACCOUNT_COLLABORATION_CLIENT_BINDING)()).not.toThrow()
  })
  it('renders current metadata and isolated technical values without interpreting stored markup', async () => {
    const f = fixture(); f.source().mailboxes[0]!.calendars[0]!.name = '<img src=x onerror=alert(1)>'
    await f.boot()
    expect(control('collections').textContent).toContain('<img src=x onerror=alert(1)>'); expect(document.querySelector('img')).toBeNull()
    expect(control('shares').textContent).toContain('Read only'); expect(control('collections').querySelector('bdi[dir=ltr]')).not.toBeNull()
  })
  it('keeps unavailable components visible and sends no session request', async () => {
    document.body.innerHTML = '<section data-capability-state="unavailable">' + renderAccountCollaborationWorkspace({ locale: 'ar', canManage: false }) + '</section>'
    const f = fixture(); await f.boot()
    expect(f.transport).not.toHaveBeenCalled(); expect(document.querySelectorAll('section.xp-collaboration__card')).toHaveLength(4)
    for (const item of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) expect(item.disabled).toBe(true)
  })
  it('renders the xMail actions as one-time handoff controls for the selected mailbox and no xMail address', () => {
    expect(document.querySelectorAll('a')).toHaveLength(0)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-handoff]')]
    expect(buttons.map(button => [button.dataset.handoff, button.dataset.handoffMailboxSelect, button.dataset.handoffLanding])).toEqual([['xmail', 'collaboration-mailbox', 'calendar'], ['xmail', 'collaboration-mailbox', 'contacts']])
    expect(document.body.innerHTML).not.toMatch(/https?:\/\/|href=/)
  })
  it('creates after confirmation with current mailbox revision and exact saved readback', async () => {
    const f = fixture(); await f.boot(); edit(); control<HTMLButtonElement>('create').click(); await tick(); await tick()
    expect(f.ask).toHaveBeenCalledOnce(); expect(f.writes()).toHaveLength(1)
    expect(f.writes()[0]![2]).toEqual({ mailbox, expectedRevision: 'a'.repeat(64), name: 'Team', color: '#4f6bed', timezone: 'UTC' })
    expect(control('status').dataset.state).toBe('saved'); expect(control('collections').textContent).toContain('Team'); expect(control<HTMLInputElement>('name').value).toBe('')
  })
  it('retains the draft when confirmation is cancelled and rejects invalid creation fields locally', async () => {
    const f = fixture(); await f.boot(); f.ask.mockResolvedValue(false); edit(); control<HTMLButtonElement>('create').click(); await tick()
    expect(f.writes()).toHaveLength(0); expect(control<HTMLInputElement>('name').value).toBe('Team')
    control<HTMLInputElement>('color').value = 'red;display:none'; control('color').dispatchEvent(new Event('input', { bubbles: true })); expect(control<HTMLButtonElement>('create').disabled).toBe(true)
  })
  it.each(['wrong-mailbox', 'mismatch', 'unknown'])('locks %s outcomes without retrying or claiming creation succeeded', async mode => {
    const f = fixture(); await f.boot(); edit(); f.setMode(mode); control<HTMLButtonElement>('create').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('uncertain'); expect(control<HTMLInputElement>('name').value).toBe('Team')
    control<HTMLButtonElement>('create').click(); await tick(); expect(f.writes()).toHaveLength(1)
  })
  it('requires explicit saved-source reload after conflict and retains draft through read failure', async () => {
    const f = fixture(); await f.boot(); edit(); f.setMode('conflict'); control<HTMLButtonElement>('create').click(); await tick(); await tick()
    expect(control('status').dataset.state).toBe('stale'); expect(control<HTMLButtonElement>('create').disabled).toBe(true)
    f.setMode('read-failure'); control<HTMLButtonElement>('refresh').click(); await tick(); expect(control<HTMLInputElement>('name').value).toBe('Team')
    f.setMode('normal'); control<HTMLButtonElement>('refresh').click(); await tick(); await tick(); expect(control('status').dataset.state).toBe('read'); expect(control<HTMLInputElement>('name').value).toBe('Team')
  })
})
