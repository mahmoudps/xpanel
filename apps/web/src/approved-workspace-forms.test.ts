/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { APPROVED_WORKSPACE_FORMS_CLIENT, mergeWorkspacePhp, mergeWorkspaceServerSettings, workspaceFeatureReceipt, workspaceDisabledFeatures, workspaceResellerPatch } from './approved-workspace-forms.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

type Request = (method: string, path: string, body?: unknown) => Promise<unknown>
const id = '10000000-0000-4000-8000-000000000001'
const otherId = '10000000-0000-4000-8000-000000000002'
const domainRevision = 'b'.repeat(64)
const php = {
  version: '8.3', handler: 'fpm',
  fpm: { mode: 'ondemand', maxChildren: 5, startServers: 1, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 },
  ini: { memory_limit: '128M', display_errors: 'Off', custom_unexposed: 'preserve' },
}
const settings = {
  hostname: 'host.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'ops@example.test',
  engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 10000, multiAccept: false, keepaliveTimeoutSec: 15 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 5, maxRequestWorkers: 150, maxConnectionsPerChild: 1000, serverLimit: 200 },
}
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const request = (fn: Request) => { (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = fn }
const boot = (html: string, confirm = vi.fn().mockResolvedValue(true)) => {
  document.body.innerHTML = html
  new Function('confirmDelete', `(${APPROVED_WORKSPACE_FORMS_CLIENT})(confirmDelete);`)(confirm)
  return confirm
}
const form = () => document.querySelector<HTMLFormElement>('form')!
const submit = () => form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const status = () => document.querySelector<HTMLElement>('[data-workspace-form-status],[data-feature-list-status],[data-domain-php-status],[data-server-settings-status],[data-setup-wizard-status],[data-reseller-update-status],[data-reseller-owner-status],[data-account-plan-status],[data-firewall-port-rule-status]')!
const button = () => form().querySelector<HTMLButtonElement>('button[type="submit"]')!
const field = (name: string, value: string, type = 'text') => `<input type="${type}" name="${name}" value="${value}">`
const featureForm = (update = false) => `<form ${update ? `data-feature-list-update-form data-feature-list-id="${id}"` : 'data-feature-list-create-form'}>${field('name', 'Standard tools')}<input name="disabled" type="checkbox" value="SSL/TLS" checked><input name="disabled" type="checkbox" value="popaccts (Email Accounts)"><button type="submit">Save</button><p data-feature-list-status></p></form>`

beforeEach(() => { document.documentElement.lang = 'en' })
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('approved workspace configuration values', () => {
  it('merges a server form without resetting unexposed nested values or marking setup complete', () => {
    const result = mergeWorkspaceServerSettings(settings, { sshPort: '2222', 'nginx.workerConnections': '2048', 'nginx.multiAccept': true, ignoredEndpoint: '/api/unrelated' })
    expect(result).toEqual({ ...settings, sshPort: 2222, nginx: { ...settings.nginx, workerConnections: 2048, multiAccept: true }, markSetupComplete: false })
    expect(settings.sshPort).toBe(22)
  })
  it('merges full PHP data and preserves fpm/ini values not shown in the form', () => {
    const result = mergeWorkspacePhp(php, { version: '8.4', 'fpm.maxChildren': '8', 'ini.memory_limit': '256M' })
    expect(result).toEqual({ ...php, version: '8.4', fpm: { ...php.fpm, maxChildren: 8 }, ini: { ...php.ini, memory_limit: '256M' } })
    expect(php.fpm.maxChildren).toBe(5)
  })
  it('allows an explicit INI override to be removed but rejects unread PHP and numeric coercion', () => {
    expect((mergeWorkspacePhp(php, { 'ini.memory_limit': '' }).ini as Record<string, string>).memory_limit).toBeUndefined()
    expect(() => mergeWorkspacePhp(null, { version: '8.4' })).toThrow('unread')
    for (const raw of ['', '4x', '-1', '1e3', 'Infinity', '1.5']) expect(() => mergeWorkspacePhp(php, { 'fpm.maxChildren': raw })).toThrow()
    expect(() => mergeWorkspaceServerSettings(settings, { engine: 'unknown' })).toThrow()
  })
  it('requires a matching feature list receipt, not merely an HTTP-shaped success', () => {
    expect(workspaceFeatureReceipt({ featureList: { id, name: 'One', disabled: ['a'] } }, 'One', ['a'])).toBe(true)
    expect(workspaceFeatureReceipt({ ok: true }, 'One', ['a'])).toBe(false)
    expect(workspaceFeatureReceipt({ featureList: { id: otherId, name: 'One', disabled: ['a'] } }, 'One', ['a'], id)).toBe(false)
    expect(workspaceFeatureReceipt({ featureList: { id, name: 'One', disabled: [] } }, 'One', ['a'])).toBe(false)
  })
  it('preserves feature flags not represented by an editable checkbox', () => {
    expect(workspaceDisabledFeatures(['legacy-flag', 'disabled-control', 'popaccts (Email Accounts)'], ['SSL/TLS', 'popaccts (Email Accounts)'], ['SSL/TLS'])).toEqual(['legacy-flag', 'disabled-control', 'SSL/TLS'])
    expect(() => workspaceDisabledFeatures(null, ['popaccts (Email Accounts)'], [])).toThrow('unread')
  })
  it('compares shared feature keys as a set, retaining their exact spelling', () => {
    expect(workspaceFeatureReceipt({ featureList: { id, name: 'One', disabled: ['SSL/TLS', 'popaccts (Email Accounts)'] } }, 'One', ['SSL/TLS', 'SSL/TLS', 'popaccts (Email Accounts)'])).toBe(true)
  })
  it('parses explicit reseller unlimited values without erasing hidden ACL privileges', () => {
    expect(workspaceResellerPatch({ acl: ['list-accounts', 'manage-plans'] }, { maxAccountsUnlimited: true, totalDiskMb: '20480', totalBandwidthMb: '50000', totalBandwidthMbUnlimited: false, oversell: false, nameservers: 'ns1.example.test\nns2.example.test', delegatedIps: '192.0.2.1\n2001:db8::1' }, ['create-account', 'manage-plans'], ['create-account'])).toEqual({ acl: ['list-accounts', 'create-account'], maxAccounts: 'unlimited', totalDiskMb: 20480, totalBandwidthMb: 50000, oversell: false, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: ['192.0.2.1', '2001:db8::1'] })
    expect(() => workspaceResellerPatch({ acl: [] }, { maxAccountsUnlimited: false }, [], [])).toThrow('maxAccounts')
  })
})

describe('approved workspace browser bindings', () => {
  it('produces standalone executable JS and is embedded into the existing client with its dialog', () => {
    expect(() => new Script(`(${APPROVED_WORKSPACE_FORMS_CLIENT})(undefined);`)).not.toThrow()
    expect(() => new Script(BROWSER_REALTIME_SCRIPT)).not.toThrow()
    expect(BROWSER_REALTIME_SCRIPT).toContain(`(${APPROVED_WORKSPACE_FORMS_CLIENT})(askDialog);`)
  })
  it.each([false, true])('submits feature-list fields with the expected create/update method: %s', async update => {
    const send = vi.fn<Request>()
    if (update) send.mockResolvedValueOnce({ featureLists: [{ id, name: 'Old name', disabled: ['popaccts (Email Accounts)', 'legacy-flag'] }] })
    send.mockResolvedValueOnce({ featureList: { id, name: 'Standard tools', disabled: update ? ['legacy-flag', 'SSL/TLS'] : ['SSL/TLS'] } })
    request(send); boot(featureForm(update)); submit(); await tick()
    expect(send.mock.calls).toEqual(update
      ? [['GET', '/api/feature-lists'], ['PATCH', '/api/feature-lists/' + id, { name: 'Standard tools', disabled: ['legacy-flag', 'SSL/TLS'] }]]
      : [['POST', '/api/feature-lists', { name: 'Standard tools', disabled: ['SSL/TLS'] }]])
    expect(status().dataset.state).toBe('stored'); expect(button().disabled).toBe(true)
    expect(document.querySelector('a')?.textContent).toBe('Reload page')
  })
  it('binds once, rejects repeated pending submits, and does not repeat an acknowledged create', async () => {
    let resolve!: (value: unknown) => void
    const send = vi.fn<Request>().mockImplementation(() => new Promise(done => { resolve = done }))
    request(send); boot(featureForm())
    new Function('confirmDelete', `(${APPROVED_WORKSPACE_FORMS_CLIENT})(confirmDelete);`)(vi.fn())
    submit(); submit(); expect(send).toHaveBeenCalledTimes(1)
    resolve({ featureList: { id, name: 'Standard tools', disabled: ['SSL/TLS'] } }); await tick(); submit()
    expect(send).toHaveBeenCalledTimes(1)
  })
  it.each(['<fieldset disabled>', '<section data-capability-unavailable="true">', '<section data-wiring="soon">'])('sends no requests from unavailable UI: %s', async prefix => {
    const send = vi.fn<Request>(); request(send); boot(prefix + featureForm() + (prefix.startsWith('<fieldset') ? '</fieldset>' : '</section>'))
    submit(); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('rejects forged endpoint attributes and invalid IDs before starting a mutation', async () => {
    const send = vi.fn<Request>(); request(send); boot(featureForm(true).replace(id, '../../server/settings').replace('<form ', '<form data-api-endpoint="/api/accounts" '))
    submit(); await tick(); expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('failed')
  })
  it('does not modify a feature list absent from its authorized reader', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ featureLists: [{ id: otherId, disabled: [] }] }); request(send); boot(featureForm(true))
    submit(); await tick(); expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/feature-lists'); expect(status().dataset.state).toBe('failed')
  })
  it('accepts official feature keys with spaces, case, parentheses and separators and deduplicates shared keys', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ featureList: { id, name: 'Readable keys', disabled: ['SSL/TLS', 'popaccts (Email Accounts)'] } }); request(send)
    boot(`<form data-feature-list-create-form>${field('name', 'Readable keys')}<input name="disabled" type="checkbox" value="SSL/TLS" checked><input name="disabled" type="checkbox" value="SSL/TLS" checked><input name="disabled" type="checkbox" value="popaccts (Email Accounts)" checked><button type="submit">Save</button></form>`)
    submit(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/feature-lists', { name: 'Readable keys', disabled: ['SSL/TLS', 'popaccts (Email Accounts)'] })
  })
  it('changes only the name while preserving every feature constraint outside the rendered form', async () => {
    const disabled = ['legacy feature name', 'Email Filtering Manager', 'SSL/TLS']
    const send = vi.fn<Request>().mockResolvedValueOnce({ featureLists: [{ id, name: 'Old', disabled }] }).mockResolvedValueOnce({ featureList: { id, name: 'Renamed only', disabled } }); request(send)
    boot(`<form data-feature-list-update-form data-feature-list-id="${id}">${field('name', 'Renamed only')}<input name="disabled" type="checkbox" value="SSL/TLS" checked disabled><button type="submit">Save</button></form>`)
    submit(); await tick()
    expect(send.mock.calls[1]).toEqual(['PATCH', '/api/feature-lists/' + id, { name: 'Renamed only', disabled }])
    expect(status().dataset.state).toBe('stored')
  })
  it('does not add an unregistered feature key supplied through a changed control value', async () => {
    const send = vi.fn<Request>(); request(send); boot(featureForm().replace('SSL/TLS', 'unregistered arbitrary key'))
    submit(); await tick(); expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('failed')
  })
  it('retains input and permits a corrected retry after definite refusal', async () => {
    const send = vi.fn<Request>().mockRejectedValue({ status: 403, details: { stateChanged: false } }); request(send); boot(featureForm())
    submit(); await tick(); expect(button().disabled).toBe(false); expect((form().elements.namedItem('name') as HTMLInputElement).value).toBe('Standard tools')
    submit(); await tick(); expect(send).toHaveBeenCalledTimes(2)
  })
  it.each([new Error('transport'), { status: 503 }, null])('requires review after uncertain response/failure: %j', async result => {
    const send = vi.fn<Request>(); if (result === null) send.mockResolvedValue({ ok: true }); else send.mockRejectedValue(result)
    request(send); boot(featureForm()); submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(status().dataset.state).toBe('uncertain'); expect(button().disabled).toBe(true)
  })
  it.each([
    { status: 409, details: { stateChanged: true } },
    { status: 412, details: { verificationRequired: true } },
    { status: 409, details: { stateChanged: false, unknownOutcome: true } },
    { status: 412, verificationRequired: true, details: { stateChanged: false } },
  ])('prioritizes uncertain-operation flags over a 4xx refusal: %j', async error => {
    const send = vi.fn<Request>().mockRejectedValue(error); request(send); boot(featureForm())
    submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(status().dataset.state).toBe('uncertain'); expect(button().disabled).toBe(true)
  })
  it('reads server settings, merges only visible fields, and distinguishes storage from host application', async () => {
    const expected = { ...settings, sshPort: 2222, markSetupComplete: false }
    const send = vi.fn<Request>().mockResolvedValueOnce({ settings }).mockResolvedValueOnce({ settings: expected, reconcile: { targetVerified: false } })
    request(send); boot(`<form data-server-settings-form>${field('sshPort', '2222')}<button type="submit">Save</button><p data-server-settings-status></p></form>`)
    submit(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/settings'], ['PUT', '/api/server/settings', expected]])
    expect(status().textContent).toContain('Host activation still requires verification')
  })
  it('does not submit settings after the initial reader fails, and permits retry of that read', async () => {
    const send = vi.fn<Request>().mockRejectedValue(new Error('read failed')); request(send)
    boot(`<form data-server-settings-form>${field('sshPort', '2222')}<button type="submit">Save</button></form>`); submit(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/server/settings'); expect(button().disabled).toBe(false)
  })
  it('selects the exact domain from the authorized list before preserving and patching its full PHP model', async () => {
    const merged = mergeWorkspacePhp(php, { version: '8.4', 'ini.memory_limit': '256M' })
    const send = vi.fn<Request>().mockResolvedValueOnce({ domains: [{ id: otherId, php: { ...php, version: '8.2' } }, { id, php }], revision: domainRevision }).mockResolvedValueOnce({ domain: { id, php: merged }, reconcile: null })
    request(send); boot(`<form data-domain-php-form data-domain-id="${id}">${field('version', '8.4')}${field('ini.memory_limit', '256M')}<button type="submit">Save</button><p data-domain-php-status></p></form>`)
    submit(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/domains'], ['PATCH', '/api/domains/' + id, { php: merged, expectedRevision: domainRevision }]])
    expect(status().dataset.state).toBe('stored')
  })
  it('does not patch a domain absent from the authorized reader result', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ domains: [{ id: otherId, php }], revision: domainRevision }); request(send)
    boot(`<form data-domain-php-form data-domain-id="${id}">${field('version', '8.4')}<button type="submit">Save</button></form>`); submit(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/domains'); expect(status().dataset.state).toBe('failed')
  })
  it('rehydrates every visible PHP field before accepting a changed domain selection', async () => {
    const nextPhp = { ...php, version: '8.2', fpm: { ...php.fpm, maxChildren: 9 }, ini: { ...php.ini, memory_limit: '512M' } }
    const domains = [{ id, php }, { id: otherId, php: nextPhp }]
    const send = vi.fn<Request>().mockResolvedValueOnce({ domains, revision: domainRevision }).mockResolvedValueOnce({ domains, revision: domainRevision }).mockResolvedValueOnce({ domain: { id: otherId, php: nextPhp } }); request(send)
    boot(`<form data-domain-php-form data-domain-id="${id}"><select name="domainId" data-domain-php-select><option value="${id}">One</option><option value="${otherId}">Two</option></select>${field('version', '8.3')}${field('fpm.maxChildren', '5')}${field('ini.memory_limit', '128M')}<button type="submit">Save</button><p data-domain-php-status></p></form>`)
    const select = document.querySelector<HTMLSelectElement>('select')!; select.value = otherId; select.dispatchEvent(new Event('change')); expect(button().disabled).toBe(true); await tick()
    expect(form().dataset.domainId).toBe(otherId); expect((form().elements.namedItem('version') as HTMLInputElement).value).toBe('8.2')
    expect((form().elements.namedItem('fpm.maxChildren') as HTMLInputElement).value).toBe('9')
    expect((form().elements.namedItem('ini.memory_limit') as HTMLInputElement).value).toBe('512M')
    submit(); await tick(); expect(send.mock.calls[2]).toEqual(['PATCH', '/api/domains/' + otherId, { php: nextPhp, expectedRevision: domainRevision }])
  })
  it('blocks a changed domain until its current configuration can be read', async () => {
    const send = vi.fn<Request>().mockRejectedValue(new Error('read failed')); request(send)
    boot(`<form data-domain-php-form data-domain-id="${id}"><select name="domainId" data-domain-php-select><option value="${id}">One</option><option value="${otherId}">Two</option></select>${field('version', '8.3')}<button type="submit">Save</button></form>`)
    const select = document.querySelector<HTMLSelectElement>('select')!; select.value = otherId; select.dispatchEvent(new Event('change')); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/domains'); expect(form().dataset.domainId).toBeUndefined(); expect(button().disabled).toBe(true)
  })
  it('keeps PHP Reset bound to the last read domain before saving A to B to reset to save', async () => {
    const nextPhp = { ...php, version: '8.2', handler: 'lsphp', fpm: { ...php.fpm, mode: 'dynamic', maxChildren: 9 }, ini: {} }
    const domains = [{ id, php }, { id: otherId, php: nextPhp }]
    const send = vi.fn<Request>().mockResolvedValueOnce({ domains, revision: domainRevision }).mockResolvedValueOnce({ domains, revision: domainRevision }).mockResolvedValueOnce({ domain: { id: otherId, php: nextPhp } }); request(send)
    boot('<form data-domain-php-form data-domain-id="' + id + '"><select name="domainId" data-domain-php-select><option value="' + id + '" selected>One</option><option value="' + otherId + '">Two</option></select>' + field('version', '8.3') + '<select name="handler"><option value="fpm" selected>FPM</option><option value="lsphp">LSAPI</option><option value="cgi">CGI</option></select><select name="fpm.mode"><option value="ondemand" selected>On demand</option><option value="dynamic">Dynamic</option></select>' + field('fpm.maxChildren', '5', 'number') + field('ini.memory_limit', '128M') + '<button type="reset">Reset</button><button type="submit">Save</button><p data-domain-php-status></p></form>')
    const domain = form().querySelector<HTMLSelectElement>('[data-domain-php-select]')!
    domain.value = otherId; domain.dispatchEvent(new Event('change')); await tick()
    ;(form().elements.namedItem('version') as HTMLInputElement).value = '8.4'
    ;(form().elements.namedItem('handler') as HTMLSelectElement).value = 'cgi'
    ;(form().elements.namedItem('fpm.maxChildren') as HTMLInputElement).value = '20'
    ;(form().elements.namedItem('ini.memory_limit') as HTMLInputElement).value = '999M'
    form().querySelector<HTMLButtonElement>('[type="reset"]')!.click()
    expect(domain.value).toBe(otherId); expect(form().dataset.domainId).toBe(otherId)
    expect((form().elements.namedItem('version') as HTMLInputElement).value).toBe('8.2')
    expect((form().elements.namedItem('handler') as HTMLSelectElement).value).toBe('lsphp')
    expect((form().elements.namedItem('fpm.mode') as HTMLSelectElement).value).toBe('dynamic')
    expect((form().elements.namedItem('fpm.maxChildren') as HTMLInputElement).value).toBe('9')
    expect((form().elements.namedItem('ini.memory_limit') as HTMLInputElement).value).toBe('')
    submit(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/domains'], ['GET', '/api/domains'], ['PATCH', '/api/domains/' + otherId, { php: nextPhp, expectedRevision: domainRevision }]])
    expect(status().dataset.state).toBe('stored')
  })
  it('does not reset PHP selection during a pending read', async () => {
    let resolve!: (value: unknown) => void
    const send = vi.fn<Request>().mockImplementation(() => new Promise(done => { resolve = done })); request(send)
    boot('<form data-domain-php-form data-domain-id="' + id + '"><select name="domainId" data-domain-php-select><option value="' + id + '">One</option><option value="' + otherId + '">Two</option></select>' + field('version', '8.3') + '<button type="submit">Save</button></form>')
    const domain = form().querySelector<HTMLSelectElement>('select')!
    domain.value = otherId; domain.dispatchEvent(new Event('change')); form().reset()
    expect(domain.value).toBe(otherId); expect(button().disabled).toBe(true)
    resolve({ domains: [{ id: otherId, php: { ...php, version: '8.2' } }], revision: domainRevision }); await tick()
    expect(form().dataset.domainId).toBe(otherId); expect(button().disabled).toBe(false)
    form().reset(); expect(domain.value).toBe(otherId); expect((form().elements.namedItem('version') as HTMLInputElement).value).toBe('8.2')
  })
  it.each([false, true])('saves a version change with empty INI controls, clearing only displayed overrides: %s', async clearOverride => {
    const current = { ...php, ini: clearOverride ? { ...php.ini } : {} }
    const expected = { ...current, version: '8.4', ini: clearOverride ? { display_errors: 'Off', custom_unexposed: 'preserve' } : {} }
    const send = vi.fn<Request>().mockResolvedValueOnce({ domains: [{ id, php: current }], revision: domainRevision }).mockResolvedValueOnce({ domain: { id, php: expected } }); request(send)
    boot('<form data-domain-php-form data-domain-id="' + id + '">' + field('version', '8.4') + field('ini.memory_limit', '') + field('ini.upload_max_filesize', '') + field('ini.post_max_size', '') + field('ini.max_execution_time', '') + field('saveTarget', 'global') + field('ini.date.timezone', 'invented') + '<button type="submit">Save</button><p data-domain-php-status></p></form>')
    submit(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/domains'], ['PATCH', '/api/domains/' + id, { php: expected, expectedRevision: domainRevision }]])
    expect(status().dataset.state).toBe('stored')
  })
  it('sends the selected setup IPv4 and verifies its real primaryIp acknowledgement', async () => {
    const payload = { initQuotas: false, hostname: 'new.example.test', primaryIpv4: '192.0.2.42' }
    const send = vi.fn<Request>().mockResolvedValue({ ok: true, settings: { hostname: payload.hostname }, primaryIp: { address: payload.primaryIpv4, version: 4 }, quotaInitialized: false }); request(send)
    boot('<form data-setup-wizard-form>' + field('hostname', payload.hostname) + field('primaryIpv4', ' 192.0.2.42 ') + '<button type="submit">Save</button><p data-setup-wizard-status></p></form>')
    submit(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/setup/wizard', payload); expect(status().dataset.state).toBe('stored')
  })
  it('omits a blank optional setup IPv4 field without changing the legacy request', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ ok: true, settings: { hostname: 'new.example.test' }, quotaInitialized: false }); request(send)
    boot('<form data-setup-wizard-form>' + field('hostname', 'new.example.test') + field('primaryIpv4', '') + '<button type="submit">Save</button><p data-setup-wizard-status></p></form>')
    submit(); await tick(); expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/setup/wizard', { initQuotas: false, hostname: 'new.example.test' })
    expect(status().dataset.state).toBe('stored')
  })
  it.each(['not-an-ip', '256.1.2.3', '1.2.3.04'])('rejects malformed explicit setup IPv4 before sending: %s', async address => {
    const send = vi.fn<Request>(); request(send)
    boot('<form data-setup-wizard-form>' + field('hostname', 'new.example.test') + field('primaryIpv4', address) + '<button type="submit">Save</button></form>')
    submit(); await tick(); expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('failed')
  })
  it('retains setup edits and blocks retry when the selected IPv4 acknowledgement differs', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ ok: true, settings: { hostname: 'new.example.test' }, primaryIp: { address: '192.0.2.43', version: 4 } }); request(send)
    boot('<form data-setup-wizard-form>' + field('hostname', 'new.example.test') + field('primaryIpv4', '192.0.2.42') + '<button type="submit">Save</button><p data-setup-wizard-status></p></form>')
    submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(status().dataset.state).toBe('uncertain'); expect(button().disabled).toBe(true)
    expect((form().elements.namedItem('primaryIpv4') as HTMLInputElement).value).toBe('192.0.2.42')
  })
  it('confirms a single account plan change and verifies GET PATCH GET before storing', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ account: { username: 'alpha', planId: id } }).mockResolvedValueOnce({ account: { username: 'alpha', planId: otherId } }).mockResolvedValueOnce({ account: { username: 'alpha', planId: otherId } }); request(send)
    const confirm = boot('<form data-account-plan-form data-account-username="alpha"><select name="planId"><option value="' + otherId + '">Next</option></select><button type="submit">Save</button><p data-account-plan-status></p></form>', vi.fn().mockResolvedValue('alpha'))
    submit(); submit(); await tick()
    expect(confirm).toHaveBeenCalledTimes(1); expect(confirm.mock.calls[0]?.[0]).toMatchObject({ input: true, danger: true })
    expect(send.mock.calls).toEqual([['GET', '/api/accounts/alpha'], ['PATCH', '/api/accounts/alpha', { planId: otherId }], ['GET', '/api/accounts/alpha']])
    expect(status().dataset.state).toBe('stored'); expect(status().textContent).toContain('Hosting changes still require verification')
  })
  it.each([null, 'another'])('sends no plan mutation on cancelled or mismatched confirmation: %s', async answer => {
    const send = vi.fn<Request>().mockResolvedValue({ account: { username: 'alpha', planId: id } }); request(send)
    boot('<form data-account-plan-form data-account-username="alpha"><select name="planId"><option value="' + otherId + '">Next</option></select><button type="submit">Save</button><p data-account-plan-status></p></form>', vi.fn().mockResolvedValue(answer))
    submit(); await tick(); expect(send.mock.calls).toEqual([['GET', '/api/accounts/alpha']]); expect(button().disabled).toBe(false)
  })
  it('does not mutate an unchanged account plan', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ account: { username: 'alpha', planId: otherId } }); request(send)
    const confirm = boot('<form data-account-plan-form data-account-username="alpha"><select name="planId"><option value="' + otherId + '">Current</option></select><button type="submit">Save</button><p data-account-plan-status></p></form>')
    submit(); await tick(); expect(send).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unchanged')
  })
  it('locks a plan change whose readback fails even on a definite HTTP refusal', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ account: { username: 'alpha', planId: id } }).mockResolvedValueOnce({ account: { username: 'alpha', planId: otherId } }).mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }); request(send)
    boot('<form data-account-plan-form data-account-username="alpha"><select name="planId"><option value="' + otherId + '">Next</option></select><button type="submit">Save</button><p data-account-plan-status></p></form>', vi.fn().mockResolvedValue('alpha'))
    submit(); await tick(); submit(); await tick(); expect(send).toHaveBeenCalledTimes(3); expect(status().dataset.state).toBe('uncertain'); expect(button().disabled).toBe(true)
  })
  it('stores only an explicit port rule and reads it back without claiming traffic enforcement', async () => {
    const payload = { kind: 'port', action: 'accept', protocol: 'tcp', port: '8443', source: null, forwardTo: null, list: null, comment: 'Web', enabled: true }
    const rule = { ...payload, id }
    const send = vi.fn<Request>().mockResolvedValueOnce({ rule, reconcile: null }).mockResolvedValueOnce({ rules: [rule], prefixLists: [] }); request(send)
    boot('<form data-firewall-port-rule-form><input type="radio" name="action" value="drop"><input type="radio" name="action" value="accept" checked><select name="protocol"><option value="tcp">TCP</option></select>' + field('port', '8443') + field('source', '') + field('comment', 'Web') + '<select name="position" disabled><option value="top">Unsupported</option></select><button type="submit">Save</button><p data-firewall-port-rule-status></p></form>')
    submit(); submit(); await tick()
    expect(send.mock.calls).toEqual([['POST', '/api/firewall/rules', payload], ['GET', '/api/firewall']]); expect(status().dataset.state).toBe('stored'); expect(status().textContent).toContain('traffic enforcement are not verified')
  })
  it.each(['0', '65536', '9000-8000', '1,2', '1e3'])('rejects an invalid firewall port before mutation: %s', async port => {
    const send = vi.fn<Request>(); request(send)
    boot('<form data-firewall-port-rule-form><input type="radio" name="action" value="accept" checked><select name="protocol"><option value="tcp">TCP</option></select>' + field('port', port) + '<button type="submit">Save</button><p data-firewall-port-rule-status></p></form>')
    submit(); await tick(); expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('failed')
  })
  it('locks a firewall rule when its desired-state readback cannot be established', async () => {
    const payload = { kind: 'port', action: 'drop', protocol: 'udp', port: '8000-8100', source: '192.0.2.0/24', forwardTo: null, list: null, comment: '', enabled: true }
    const send = vi.fn<Request>().mockResolvedValueOnce({ rule: { ...payload, id } }).mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }); request(send)
    boot('<form data-firewall-port-rule-form><input type="radio" name="action" value="drop" checked><select name="protocol"><option value="udp">UDP</option></select>' + field('port', '8000-8100') + field('source', '192.0.2.0/24') + '<button type="submit">Save</button><p data-firewall-port-rule-status></p></form>')
    submit(); await tick(); submit(); await tick(); expect(send).toHaveBeenCalledTimes(2); expect(status().dataset.state).toBe('uncertain')
  })
  it('refuses unavailable account-plan and firewall forms without operations', async () => {
    const send = vi.fn<Request>(); request(send)
    for (const marker of ['data-account-plan-form data-account-username="alpha"', 'data-firewall-port-rule-form']) {
      boot('<form ' + marker + ' data-capability-unavailable="true">' + field('planId', otherId) + field('port', '8443') + '<button type="submit">Save</button></form>'); submit(); await tick()
    }
    expect(send).not.toHaveBeenCalled()
  })
  it('records setup with explicit no-quota-initialization and never claims a native result', async () => {
    const payload = { initQuotas: false, hostname: 'new.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], sshPort: 2222, quotaFilesystem: '/home' }
    const send = vi.fn<Request>().mockResolvedValue({ ok: true, settings: { hostname: payload.hostname, nameservers: payload.nameservers, sshPort: 2222 }, quotaInitialized: false })
    request(send); boot(`<form data-setup-wizard-form>${field('hostname', payload.hostname)}<textarea name="nameservers">ns1.example.test\nns2.example.test</textarea>${field('sshPort', '2222')}${field('quotaFilesystem', '/home')}<input name="initQuotas" type="checkbox" checked><button type="submit">Save</button><p data-setup-wizard-status></p></form>`)
    submit(); await tick(); expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/setup/wizard', payload)
    expect(status().textContent).toContain('quotas and host activation are not verified')
  })
  it('requires the existing confirmation dialog before deleting and prevents duplicate deletes', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ ok: true }); request(send)
    const confirm = boot(`<section data-feature-list-row><button data-feature-list-delete data-feature-list-id="${id}">Delete</button></section>`)
    const remove = document.querySelector<HTMLButtonElement>('button')!; remove.click(); remove.click(); await tick()
    expect(confirm).toHaveBeenCalledTimes(1); expect(confirm.mock.calls[0]?.[0]).toMatchObject({ danger: true })
    expect(send).toHaveBeenCalledExactlyOnceWith('DELETE', '/api/feature-lists/' + id); expect(remove.disabled).toBe(true)
  })
  it('does not delete on a cancelled dialog or without the dialog helper', async () => {
    const send = vi.fn<Request>(); request(send)
    boot(`<section data-feature-list-row><button data-feature-list-delete data-feature-list-id="${id}">Delete</button></section>`, vi.fn().mockResolvedValue(null))
    document.querySelector<HTMLButtonElement>('button')!.click(); await tick(); expect(send).not.toHaveBeenCalled()
    new Function(`(${APPROVED_WORKSPACE_FORMS_CLIENT})(undefined);`)()
    document.querySelector<HTMLButtonElement>('button')!.click(); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('updates reseller metadata through current read, patch, and verified readback', async () => {
    const payload = { acl: ['list-accounts', 'create-account'], maxAccounts: 'unlimited', totalDiskMb: 20480, oversell: false, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: [] }
    const send = vi.fn<Request>().mockResolvedValueOnce({ resellers: [{ id, acl: ['list-accounts', 'manage-plans'] }] }).mockResolvedValueOnce({ reseller: { id, ...payload } }).mockResolvedValueOnce({ resellers: [{ id, ...payload, acl: ['create-account', 'list-accounts'] }] }); request(send)
    boot(`<form data-reseller-update-form data-reseller-id="${id}"><input name="acl" value="create-account" type="checkbox" checked><input name="acl" value="manage-plans" type="checkbox"><input name="maxAccountsUnlimited" data-reseller-unlimited-field="maxAccounts" type="checkbox" checked><input name="maxAccounts" value="" disabled>${field('totalDiskMb', '20480')}<input name="oversell" type="checkbox"><textarea name="nameservers">ns1.example.test\nns2.example.test</textarea><textarea name="delegatedIps"></textarea><button type="submit">Save</button><p data-reseller-update-status></p></form>`)
    submit(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/resellers'], ['PATCH', '/api/resellers/' + id, payload], ['GET', '/api/resellers']])
    expect(status().dataset.state).toBe('stored'); expect(status().textContent).not.toContain('host applied')
  })
  it('enables the numeric reseller limit only when explicit unlimited is cleared', () => {
    boot(`<form data-reseller-update-form data-reseller-id="${id}"><input name="maxAccountsUnlimited" data-reseller-unlimited-field="maxAccounts" type="checkbox" checked><input name="maxAccounts" value="" disabled><button type="submit">Save</button></form>`)
    const unlimited = form().elements.namedItem('maxAccountsUnlimited') as HTMLInputElement, number = form().elements.namedItem('maxAccounts') as HTMLInputElement
    unlimited.checked = false; unlimited.dispatchEvent(new Event('change')); expect(number.disabled).toBe(false); expect(number.required).toBe(true)
    unlimited.checked = true; unlimited.dispatchEvent(new Event('change')); expect(number.disabled).toBe(true); expect(number.required).toBe(false)
  })
  it('does not modify a reseller outside the authorized list', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ resellers: [{ id: otherId, acl: [] }] }); request(send)
    boot(`<form data-reseller-update-form data-reseller-id="${id}">${field('totalDiskMb', '1024')}<button type="submit">Save</button></form>`); submit(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/resellers'); expect(status().dataset.state).toBe('failed')
  })
  it('keeps a post-write readback refusal uncertain even when it is an HTTP 403', async () => {
    const send = vi.fn<Request>().mockResolvedValueOnce({ resellers: [{ id, acl: [] }] }).mockResolvedValueOnce({ reseller: { id, totalDiskMb: 1024 } }).mockRejectedValueOnce({ status: 403, details: { stateChanged: false } }); request(send)
    boot(`<form data-reseller-update-form data-reseller-id="${id}">${field('totalDiskMb', '1024')}<button type="submit">Save</button></form>`); submit(); await tick(); submit(); await tick()
    expect(send).toHaveBeenCalledTimes(3); expect(status().dataset.state).toBe('uncertain'); expect(button().disabled).toBe(true)
  })
  it.each([otherId, ''])('confirms the account username and reads ownership back, including root owner %s', async ownerId => {
    const payload = { ownerId: ownerId || null }, account = { username: 'preview', ownerId: id }
    const send = vi.fn<Request>().mockResolvedValueOnce({ account }).mockResolvedValueOnce({ account: { ...account, ...payload } }).mockResolvedValueOnce({ account: { ...account, ...payload } }); request(send)
    const confirm = boot(`<form data-reseller-owner-form data-account-username="preview"><select name="ownerId"><option value="${ownerId}">Chosen owner</option></select><button type="submit">Change</button><p data-reseller-owner-status></p></form>`, vi.fn().mockResolvedValue('preview'))
    submit(); await tick()
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ input: true, danger: true })
    expect(send.mock.calls).toEqual([['GET', '/api/accounts/preview'], ['PATCH', '/api/accounts/preview', payload], ['GET', '/api/accounts/preview']])
    expect(status().dataset.state).toBe('stored')
  })
  it.each([null, true, 'wrong-account'])('does not change ownership without an exact username confirmation: %j', async confirmation => {
    const send = vi.fn<Request>().mockResolvedValue({ account: { username: 'preview', ownerId: id } }); request(send)
    boot(`<form data-reseller-owner-form data-account-username="preview"><select name="ownerId"><option value="${otherId}">Another owner</option></select><button type="submit">Change</button></form>`, vi.fn().mockResolvedValue(confirmation))
    submit(); await tick(); expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/accounts/preview'); expect(status().dataset.state).toBe('cancelled')
  })
  it('does not write an unchanged owner or accept a malformed owner identifier', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ account: { username: 'preview', ownerId: id } }); request(send)
    boot(`<form data-reseller-owner-form data-account-username="preview"><select name="ownerId"><option value="${id}">Same owner</option></select><button type="submit">Change</button></form>`)
    submit(); await tick(); expect(send).toHaveBeenCalledTimes(1); expect(status().dataset.state).toBe('unchanged')
    boot(`<form data-reseller-owner-form data-account-username="preview"><select name="ownerId"><option value="../../unrelated">Malformed</option></select><button type="submit">Change</button></form>`)
    submit(); await tick(); expect(send).toHaveBeenCalledTimes(1); expect(status().dataset.state).toBe('failed')
  })
})
