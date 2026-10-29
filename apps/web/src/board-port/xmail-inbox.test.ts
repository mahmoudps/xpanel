// @vitest-environment jsdom
import { formatMailStamp } from './mail-truth.ts'
import {describe,expect,it} from 'vitest'
import {renderInbox,xmailInboxFromProps} from './xmail-inbox.ts'

describe('shared Inbox renderer folder workspace',()=>{
  it('preserves default Inbox integration and query-folder links',()=>{const model=xmailInboxFromProps({mailbox:'owner@tenant.test',messages:[]});const html=renderInbox(model);expect(model.activeFolder).toBe('INBOX');expect(html).not.toContain('data-mail-folder-workspace="true"');expect(model.folders.find(f=>f.id==='Sent')?.href).toBe('/mail/inbox?folder=Sent')})
  it.each(['Sent','Drafts','Trash'])('reuses the complete Inbox panes for %s',folder=>{const model=xmailInboxFromProps({mailbox:'owner@tenant.test',activeFolder:folder,folderWorkspace:true});const html=renderInbox(model);expect(html).toContain('data-mail-folder-workspace="true"');expect(html).toContain('data-mail-folder="'+folder+'"');for(const pane of ['folders','message-list','reading-pane'])expect(html).toContain('data-mail-pane="'+pane+'"');expect(html).toContain('data-mail-folder-row-template');expect(html).toContain('data-mail-folder-reading-template');expect(model.folders.find(f=>f.id===folder)?.href).toBe('/mail/'+folder.toLowerCase());expect(model.moveTargets.some(f=>f.id==='INBOX')).toBe(true);expect(model.moveTargets.some(f=>f.id===folder)).toBe(false)})
  it.each(['en','ar'] as const)('retains every selected-message field and safe plain-text rendering in %s',locale=>{const html=renderInbox(xmailInboxFromProps({locale,mailbox:'owner@tenant.test',activeFolder:'Trash',folderWorkspace:true,messages:[{uid:8,folder:'Trash',from:'sender@test.invalid',fromName:'Sender',to:'owner@tenant.test',cc:'copy@test.invalid',subject:'<unsafe>',preview:'Preview',body:'<script>no</script>',receivedAt:'2026-10-25T12:00:00Z',unread:false,attachments:[{name:'a.txt',sizeBytes:2}]}]}));for(const name of ['subject','name','from','to','cc','date','body','auth','attachments'])expect(html).toContain('data-mail-detail-'+name);expect(html).toContain('&lt;script&gt;no&lt;/script&gt;');expect(html).toContain('data-mail-action="restore"');expect(html.replace(/<script\b[\s\S]*?<\/script>/g,'')).not.toContain('data-mail-action="delete"');expect(html).toContain('data-mail-folder-status');expect(html).toContain('data-mail-folder-review')})
  it.each([['en','Unread. Sender. Hello.','Moved to {folder}: {subject}'],['ar','غير مقروءة. Sender. Hello.','نُقلت إلى {folder}: {subject}']] as const)('keeps the unread label and move notice as whole messages in %s',(locale,aria,moved)=>{const html=renderInbox(xmailInboxFromProps({locale,mailbox:'owner@tenant.test',messages:[{uid:9,folder:'INBOX',from:'sender@test.invalid',fromName:'Sender',to:'owner@tenant.test',subject:'Hello',preview:'Preview',body:'Body',receivedAt:'2026-10-25T12:00:00Z',unread:true,attachments:[]}]}));expect(html).toContain('aria-label="'+aria);expect(html).toContain('data-moved-message="'+moved+'"')})
  it('preserves custom folders without inventing a dedicated route',()=>{const model=xmailInboxFromProps({mailbox:'owner@tenant.test',activeFolder:'INBOX.Custom-1',folderWorkspace:true});expect(model.folders.find(f=>f.current)?.href).toBe('/mail/inbox?folder=INBOX.Custom-1')})
})


describe('reachable metadata datetime', () => {
  it.each([
    ['2026-10-27T15:34:56.123456+03:00', '2026-10-27 12:34 UTC', '2026-10-27T12:34:56.123Z'],
    ['2026-10-27T12:34:56.000Z', '2026-10-27 12:34 UTC', '2026-10-27T12:34:56.000Z'],
  ])('formats only the full metadata stamp for %s while retaining compact clock and normalized datetime', (source, full, datetime) => {
    expect(formatMailStamp(source)).toEqual({ time: '12:34 UTC', full, datetime })
  })
  it.each(['', 'Original external Date header'])('keeps unparsed external date %s without inventing a timezone', source => {
    expect(formatMailStamp(source)).toEqual({ time: source || '—', full: source || '—', datetime: source })
  })
  it.each(['en', 'ar'] as const)('renders readable SSR metadata in %s with the existing normalized machine datetime', locale => {
    const receivedAt = '2026-10-27T15:34:56.123456+03:00'
    const source = { uid: 17, folder: 'INBOX.Custom-1', from: 'sender@example.test', to: 'owner@tenant.test', subject: 'Original subject 2026-10-27T15:34:56.123456+03:00', preview: 'Preview', body: 'Original source DTSTART:20261027T123456Z', receivedAt, unread: false }
    document.body.innerHTML = renderInbox(xmailInboxFromProps({ locale, mailbox: 'owner@tenant.test', activeFolder: source.folder, messages: [source] }))
    try {
      const date = document.querySelector<HTMLElement>('[data-mail-detail-date]')!
      expect(date.textContent).toBe('2026-10-27 12:34 UTC')
      expect(date.getAttribute('datetime')).toBe('2026-10-27T12:34:56.123Z')
      expect(document.querySelector('[data-mail-detail-body]')!.textContent).toContain('DTSTART:20261027T123456Z')
      expect(source.receivedAt).toBe(receivedAt)
    } finally { document.body.replaceChildren() }
  })
  it.each(['en', 'ar'] as const)('renders readable fetched message dates in %s while retaining exact response identity and source', async locale => {
    const mailbox = 'owner@tenant.test', folder = 'INBOX.Custom-1', receivedAt = '2026-10-27T12:34:56.123456Z'
    const body = 'Date: 2026-10-27T12:34:56.123456Z\r\nDTSTART:20261027T123456Z\r\nOriginal body <source>'
    const fetched = { uid: 17, from: 'sender@example.test', to: mailbox, subject: 'Original fetched subject', receivedAt, body, unread: false, sizeBytes: 80, attachments: [], uidValidityObserved: true, uidValidity: 11 }
    const seed = { ...fetched, folder, preview: 'Pending preview', receivedAt: '2026-10-26T00:00:00.000Z', body: '', bodyPending: true }
    const calls: Array<{ method: string; path: string }> = []
    document.body.innerHTML = renderInbox(xmailInboxFromProps({ locale, mailbox, activeFolder: folder, messages: [seed] }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = async (method: string, path: string) => { calls.push({ method, path }); return { mailbox, folder, message: fetched } }
    try {
      new Function(document.querySelector<HTMLScriptElement>('#xmail-inbox-client')!.textContent!)()
      document.querySelector<HTMLButtonElement>('[data-mail-open][data-mail-uid="17"]')!.click()
      for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
      const date = document.querySelector<HTMLElement>('[data-mail-detail-date]')!
      expect(date.textContent).toBe('2026-10-27 12:34 UTC')
      expect(date.getAttribute('datetime')).toBe(receivedAt)
      expect(date.dir).toBe('ltr')
      expect(document.querySelector('[data-mail-detail-body]')!.textContent).toBe(body)
      expect(fetched.receivedAt).toBe(receivedAt)
      expect(calls).toEqual([{ method: 'GET', path: '/api/webmail/inbox/17?folder=INBOX.Custom-1' }])
    } finally { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest }
  })
})

describe('reachable metadata datetime external sources', () => {
  it.each([
    ['Tue, 27 Oct 2026 12:34:56 GMT', 'Tue, 27 Oct 2026 12:34:56 GMT', 'Tue, 27 Oct 2026 12:34:56 GMT', 'Tue, 27 Oct 2026 12:34:56 GMT'],
    ['2026-10-27T12:34Z', '12:34 UTC', '2026-10-27 12:34 UTC', '2026-10-27T12:34:00.000Z'],
  ])('keeps existing full-date admission and normalized machine datetime for %s', (source, time, full, datetime) => {
    expect(formatMailStamp(source)).toEqual({ time, full, datetime })
  })
  it.each((['en', 'ar'] as const).flatMap(locale => ([['Tue, 27 Oct 2026 12:34:56 GMT', '2026-10-27 12:34 UTC'], ['2026-10-27T12:34Z', '2026-10-27 12:34 UTC'], ['Unparsed original date', 'Unparsed original date']] as const).map(([receivedAt, expected]) => [locale, receivedAt, expected] as const)))('formats accepted fetched dates in %s for %s while preserving unparsed source', async (locale, receivedAt, expected) => {
    const mailbox = 'owner@tenant.test', folder = 'INBOX.Custom-1'
    const fetched = { uid: 17, from: 'sender@example.test', to: mailbox, subject: 'Original subject', receivedAt, body: 'Original body DTSTART:20261027T123456Z', unread: false, sizeBytes: 80, attachments: [], uidValidityObserved: true, uidValidity: 11 }
    const seed = { ...fetched, folder, preview: '', body: '', bodyPending: true }
    const calls: Array<{ method: string; path: string }> = []
    document.body.innerHTML = renderInbox(xmailInboxFromProps({ locale, mailbox, activeFolder: folder, messages: [seed] }))
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = async (method: string, path: string) => { calls.push({ method, path }); return { mailbox, folder, message: fetched } }
    try {
      new Function(document.querySelector<HTMLScriptElement>('#xmail-inbox-client')!.textContent!)()
      document.querySelector<HTMLButtonElement>('[data-mail-open][data-mail-uid="17"]')!.click()
      for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0))
      const date = document.querySelector('[data-mail-detail-date]')!
      expect(date.textContent).toBe(expected)
      expect(date.getAttribute('datetime')).toBe(receivedAt)
      expect(document.querySelector('[data-mail-detail-body]')!.textContent).toBe(fetched.body)
      expect(fetched.receivedAt).toBe(receivedAt)
      expect(calls).toEqual([{ method: 'GET', path: '/api/webmail/inbox/17?folder=INBOX.Custom-1' }])
    } finally { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest }
  })
})
