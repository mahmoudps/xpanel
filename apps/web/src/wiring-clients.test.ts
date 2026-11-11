// @vitest-environment jsdom
import { suggestedWorkerFields } from '@xpanel/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_FTP_REMOVE_CLIENT_BINDING } from './account-ftp-remove-client.ts'
import { webDiskSettingsText } from './account-dav-client.ts'
import { ftpRemovalHooks } from './models/ftp-removal.ts'
import { SERVER_SETTINGS_SUGGEST_CLIENT_BINDING } from './server-settings-suggest-client.ts'
import { MAIL_BULK_CLIENT_BINDING, bulkTargets } from './mail-bulk-client.ts'
import { WHM_DNS_FILE_CLIENT_BINDING, readZoneFilePreview } from './whm-dns-file-client.ts'
import { WHM_RESELLER_SUSPEND_CLIENT_BINDING } from './whm-reseller-suspend-client.ts'

const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const transport = (send: Send) => { (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send }
const mount = (binding: string, ask: unknown) => new Function('return ' + binding)()(ask)
beforeEach(() => { document.body.innerHTML = '' })

describe('worker suggestions', () => {
  it('needs both hardware facts and returns the form field names', () => {
    expect(suggestedWorkerFields(null)).toBeNull()
    expect(suggestedWorkerFields({ cores: 2 })).toBeNull()
    const fields = JSON.parse(suggestedWorkerFields({ cores: 2, memory: { totalBytes: 2 * 1024 ** 3 } })!)
    expect(fields['nginx.workerProcesses']).toBe(2)
    expect(fields['apache.maxRequestWorkers']).toBeGreaterThan(0)
  })
  it('fills the form and discards a draft, never touching a disabled field', () => {
    document.body.innerHTML = `<form data-server-settings-form><input name="nginx.workerProcesses" value="1"><input type="checkbox" name="nginx.multiAccept"><input name="apache.serverLimit" value="5" disabled><p data-server-settings-status hidden></p></form>
      <button data-server-settings-suggest='{"nginx.workerProcesses":4,"nginx.multiAccept":true,"apache.serverLimit":9}'></button><button data-server-settings-discard></button>`
    new Function(SERVER_SETTINGS_SUGGEST_CLIENT_BINDING)()
    document.querySelector<HTMLButtonElement>('[data-server-settings-suggest]')!.click()
    const form = document.querySelector('form')!, value = (name: string) => form.elements.namedItem(name) as HTMLInputElement
    expect(value('nginx.workerProcesses').value).toBe('4')
    expect(value('nginx.multiAccept').checked).toBe(true)
    expect(value('apache.serverLimit').value).toBe('5')
    document.querySelector<HTMLButtonElement>('[data-server-settings-discard]')!.click()
    expect(value('nginx.workerProcesses').value).toBe('1')
    expect(document.querySelector<HTMLElement>('[data-server-settings-status]')!.hidden).toBe(false)
  })
})

describe('server settings suggestion for a radio group', () => {
  it('checks the suggested choice, keeps each choice value and leaves a disabled group alone', () => {
    document.body.innerHTML = `<form data-server-settings-form><input type="radio" name="apacheMpm" value="event" checked><input type="radio" name="apacheMpm" value="itk">
      <input type="radio" name="engine" value="apache" checked disabled><input type="radio" name="engine" value="openlitespeed" disabled></form>
      <button data-server-settings-suggest='{"apacheMpm":"itk","engine":"openlitespeed"}'></button>`
    new Function(SERVER_SETTINGS_SUGGEST_CLIENT_BINDING)()
    document.querySelector<HTMLButtonElement>('[data-server-settings-suggest]')!.click()
    expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'), item => [item.value, item.checked])).toEqual([['event', false], ['itk', true], ['apache', true], ['openlitespeed', false]])
  })
})

describe('FTP login removal', () => {
  const row = (hooks: Record<string, string>) => { document.body.innerHTML = `<button ${Object.entries(hooks).map(([name, value]) => `${name}='${value}'`).join(' ')}>Delete</button><p data-ftp-remove-status hidden></p>`; return document.querySelector('button')! }
  it('keeps the other services of a shared login', async () => {
    const hooks = ftpRemovalHooks({ id: 'u1', services: { email: true, ftp: true, webdisk: false } })
    expect(JSON.parse(hooks['data-ftp-remove-keep']!)).toEqual({ email: true, ftp: false, webdisk: false })
    const send = vi.fn(async () => { throw new Error('refused') }); transport(send as Send)
    const button = row(hooks); mount(ACCOUNT_FTP_REMOVE_CLIENT_BINDING, async () => true)
    button.click(); await tick()
    expect(send).toHaveBeenCalledWith('PATCH', '/api/service-users/u1', { services: { email: true, ftp: false, webdisk: false } })
    expect(document.querySelector('[data-ftp-remove-status]')!.textContent).toBe('refused')
  })
  it('deletes an FTP-only login, and does nothing without confirmation', async () => {
    const hooks = ftpRemovalHooks({ id: 'u2', services: { email: false, ftp: true, webdisk: false } })
    expect(hooks['data-ftp-remove-keep']).toBeUndefined()
    const send = vi.fn(async () => { throw new Error('x') }); transport(send as Send)
    const button = row(hooks); mount(ACCOUNT_FTP_REMOVE_CLIENT_BINDING, async () => false)
    button.click(); await tick()
    expect(send).not.toHaveBeenCalled()
    delete button.dataset.ftpRemoveBound
    const again = row(hooks); mount(ACCOUNT_FTP_REMOVE_CLIENT_BINDING, async () => true)
    again.click(); await tick()
    expect(send).toHaveBeenCalledWith('DELETE', '/api/service-users/u2')
  })
})

describe('FTP login creation', () => {
  it('sends an FTP-only login and shows a refusal', async () => {
    document.body.innerHTML = '<section><div data-ftp-create><input name="login" value="u1"><input name="password" value="secret12"><input name="ftpDir" value="public_html/up"></div><button data-ftp-create-submit>Create</button><p data-ftp-remove-status hidden></p></section>'
    const send = vi.fn(async () => { throw new Error('taken') }); transport(send as Send)
    mount(ACCOUNT_FTP_REMOVE_CLIENT_BINDING, async () => true)
    document.querySelector<HTMLButtonElement>('[data-ftp-create-submit]')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/service-users', { login: 'u1', password: 'secret12', ftpDir: 'public_html/up', services: { email: false, ftp: true, webdisk: false } })
    expect(document.querySelector('[data-ftp-remove-status]')!.textContent).toBe('taken')
  })
})

describe('Web Disk settings file', () => {
  it('lists addresses and logins and holds no password', () => {
    const text = webDiskSettingsText({ addresses: [{ url: 'https://example.test:2078' }], unsecuredDomains: [], logins: [{ kind: 'user', id: 'a', login: 'a@example.test', directory: 'public_html', access: 'read-only', otherServices: [] }] } as never, 'Settings')
    expect(text).toBe('Settings\n\nhttps://example.test:2078\n\na@example.test (read-only) public_html\n')
  })
})

describe('reseller suspension control', () => {
  it('reports accounts that did not change', async () => {
    document.body.innerHTML = '<div><button data-reseller-suspend="r1" data-reseller-suspended="false">Suspend</button><p data-reseller-suspend-status></p></div>'
    const send = vi.fn(async () => ({ failed: ['acct1'] })); transport(send as Send)
    mount(WHM_RESELLER_SUSPEND_CLIENT_BINDING, async () => true)
    document.querySelector('button')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/resellers/r1/suspend')
    expect(document.querySelector('[data-reseller-suspend-status]')!.textContent).toContain('acct1')
  })
  it('sends unsuspend for a suspended reseller', async () => {
    document.body.innerHTML = '<div><button data-reseller-suspend="r1" data-reseller-suspended="true">Unsuspend</button><p data-reseller-suspend-status></p></div>'
    const send = vi.fn(async () => { throw new Error('no') }); transport(send as Send)
    mount(WHM_RESELLER_SUSPEND_CLIENT_BINDING, async () => true)
    document.querySelector('button')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/resellers/r1/unsuspend')
  })
})

describe('bulk junk', () => {
  const boot = (folder: string, action: string) => { document.body.innerHTML = `<div data-mail-bulk data-mail-bulk-folder="${folder}"><button data-mail-bulk-action="${action}">Go</button><p data-mail-bulk-status></p></div>` }
  it('leaves out a message whose UIDVALIDITY was not observed', () => {
    expect(bulkTargets({ messages: [{ uid: 1, uidValidity: 9 }, { uid: 2 }] })).toEqual([{ uid: 1, uidValidity: 9 }])
    expect(() => bulkTargets({})).toThrow()
  })
  it('reports each message of the page into Junk and stops at a refusal', async () => {
    boot('INBOX', 'report')
    const send = vi.fn(async (method: string, path: string) => { if (method === 'GET') return { messages: [{ uid: 1, uidValidity: 9 }, { uid: 2, uidValidity: 9 }] }; if (path.includes('/2/')) throw new Error('refused'); return {} })
    transport(send as Send); mount(MAIL_BULK_CLIENT_BINDING, async () => true)
    document.querySelector('button')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/webmail/inbox/1/report', { folder: 'Junk', from: 'INBOX', uidValidity: 9 })
    expect(document.querySelector('[data-mail-bulk-status]')!.textContent).toContain('refused')
  })
  it('empties Junk only after confirmation', async () => {
    boot('Junk', 'empty')
    const send = vi.fn(async () => ({ messages: [] })); transport(send as Send)
    mount(MAIL_BULK_CLIENT_BINDING, async () => false)
    document.querySelector('button')!.click(); await tick()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('DNS zone file card', () => {
  const REVISION = 'a'.repeat(64)
  const preview = { revision: REVISION, records: [{ id: 'x' }], differences: [{ name: 'www', type: 'A', current: null, imported: '300 192.0.2.2', action: 'add' }], skipped: [] }
  const boot = (send: Send, ask: unknown = async () => true) => {
    document.body.innerHTML = `<div data-whm-dns-workspace><select data-dns-zone><option value="example.test" selected>example.test</option></select><button data-dns-refresh></button>
      <div data-dns-file><template data-xp-template="dns-file-row"><tr><td data-xp-slot="name"></td><td data-xp-slot="type"></td><td data-xp-slot="current"></td><td data-xp-slot="imported"></td><td data-xp-slot="action"></td></tr></template>
      <input type="file" data-dns-file-input><textarea data-dns-file-text></textarea><table><tbody data-dns-file-rows></tbody></table>
      <button data-dns-file-export></button><button data-dns-file-preview></button><button data-dns-file-import></button><button data-dns-file-cancel></button><p data-dns-file-status></p></div></div>`
    transport(send); mount(WHM_DNS_FILE_CLIENT_BINDING, ask)
  }
  const button = (name: string) => document.querySelector<HTMLButtonElement>(`[data-dns-file-${name}]`)!
  const type = (value: string) => { const text = document.querySelector<HTMLTextAreaElement>('[data-dns-file-text]')!; text.value = value; text.dispatchEvent(new Event('input')) }

  it('rejects a malformed preview', () => {
    expect(() => readZoneFilePreview({ ...preview, revision: 'short' })).toThrow()
    expect(() => readZoneFilePreview({ ...preview, differences: [{ name: 1 }] })).toThrow()
    expect(readZoneFilePreview(preview).records).toHaveLength(1)
  })
  it('stays closed until a preview, then saves through the guarded zone route', async () => {
    const send = vi.fn(async (method: string) => method === 'POST' ? preview : { zone: {} })
    boot(send as Send)
    expect(button('import').disabled).toBe(true)
    type('@ IN A 192.0.2.2')
    button('preview').click(); await tick()
    expect(document.querySelectorAll('[data-dns-file-rows] tr')).toHaveLength(1)
    expect(document.querySelector('[data-dns-file-rows] td')!.textContent).toBe('www')
    expect(button('import').disabled).toBe(false)
    button('import').click(); await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/dns/zones/example.test', { records: preview.records, expectedZoneRevision: REVISION })
    expect(document.querySelectorAll('[data-dns-file-rows] tr')).toHaveLength(0)
  })
  it('a text change drops the reviewed preview, and a refused import keeps the draft', async () => {
    const send = vi.fn(async (method: string) => { if (method === 'PUT') throw new Error('conflict'); return preview })
    boot(send as Send)
    type('one'); button('preview').click(); await tick()
    type('two')
    expect(button('import').disabled).toBe(true)
    button('preview').click(); await tick()
    button('import').click(); await tick()
    expect(document.querySelector('[data-dns-file-status]')!.textContent).toBe('conflict')
    expect(document.querySelector<HTMLTextAreaElement>('[data-dns-file-text]')!.value).toBe('two')
  })
  it('is unavailable without a confirmation dialog', () => {
    boot(vi.fn() as never, null)
    expect(document.querySelector<HTMLElement>('[data-dns-file-status]')!.dataset.state).toBe('unavailable')
  })
})
