// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderClassicMailCards } from './board-port/mail-cards.ts'
import { translator } from './i18n.ts'
import { MAIL_CARDS_CLIENT_BINDING, formatMailBytes, mapMailImportRows, parseMailImportText, parseMailOverrides } from './mail-cards-client.ts'
import { mailCardsFor } from './mail-cards.ts'
import { renderV2MailCards } from './themes/v2/pages/mail-cards.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const access = { canRead: true, canAct: () => true }
const mount = (route: string, render: typeof renderClassicMailCards = renderClassicMailCards, overrides: Parameters<typeof mailCardsFor>[2] = access) => { document.body.innerHTML = render(mailCardsFor(route, translator('en'), overrides), 'en') }
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: () => Promise<boolean>) => {
  (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAIL_CARDS_CLIENT_BINDING)()(ask)
}
const card = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-mail-card]')].find(node => node.dataset.mailCard === id)!
const status = (id: string) => card(id).querySelector('[data-mail-card-status]')!
const action = (id: string, key: string) => [...card(id).querySelectorAll<HTMLButtonElement>('[data-mail-card-action]')].find(node => node.dataset.mailCardAction === key)!
const field = (id: string, key: string) => [...card(id).querySelectorAll<HTMLInputElement>('[data-mail-card-field]')].find(node => node.dataset.mailCardField === key)!
const fact = (id: string, key: string) => [...card(id).querySelectorAll('[data-mail-card-fact]')].find(node => (node as HTMLElement).dataset.mailCardFact === key)!.textContent
const rows = (id: string, key: string) => [...[...card(id).querySelectorAll<HTMLElement>('[data-mail-card-rows]')].find(node => node.dataset.mailCardRows === key)!.querySelectorAll('tr')]

beforeEach(() => { document.documentElement.lang = 'en'; document.body.innerHTML = '' })

describe('pure helpers', () => {
  it('parses delimited text and skips blank and comment lines', () => {
    expect(parseMailImportText('a,b\r\n\n# note\nc,d\n', '')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseMailImportText('a;b', ';')).toEqual([['a', 'b']])
  })
  it('maps columns and applies the default domain and quota', () => {
    expect(mapMailImportRows([['info', 'Secret,1', '']], ['email', 'password', 'quota'], { kind: 'mailboxes', domain: 'a.test', quota: '100' })).toEqual([['info@a.test', 'Secret,1', '100']])
    expect(mapMailImportRows([['x', 'y@b.test', 'skip']], ['email', 'destination', 'ignore'], { kind: 'forwarders', domain: 'a.test', quota: '100' })).toEqual([['x@a.test', 'y@b.test']])
  })
  it('reads overrides and refuses repeated or malformed lines', () => {
    expect(parseMailOverrides('smtp_connect_timeout = 10s\n\nsmtp_helo_timeout=20s')).toEqual({ smtp_connect_timeout: '10s', smtp_helo_timeout: '20s' })
    expect(parseMailOverrides('no value')).toBeNull()
    expect(parseMailOverrides('a=1\na=2')).toBeNull()
  })
  it('formats sizes', () => {
    expect([formatMailBytes(10), formatMailBytes(2048), formatMailBytes(-1)]).toEqual(['\u206610\u00a0B\u2069', '\u20662.00\u00a0KiB\u2069', '-'])
  })
})

describe('both themes render the same hooks', () => {
  it.each(['/whm/email/delivery', '/whm/email/outbound', '/whm/email/spam', '/whm/email/server', '/whm/email/maintenance', '/email/forwarders', '/email/deliverability', '/email/filters', '/email/spam-filters', '/metrics/logs', '/mail/later'])('%s', route => {
    const hooks = (html: string) => [...html.matchAll(/data-(mail-card[a-z-]*)(?:="([^"]*)")?/g)].map(match => match[0]).sort()
    const cards = mailCardsFor(route, translator('en'), access)
    expect(cards.length).toBeGreaterThan(0)
    expect(hooks(renderV2MailCards(cards, 'en'))).toEqual(hooks(renderClassicMailCards(cards, 'en')))
  })
  it('renders no card on another route and keeps write actions off without the tool', () => {
    expect(mailCardsFor('/whm/email/queue', translator('en'), access)).toEqual([])
    expect(mailCardsFor('/whm/email/spam', translator('en'), { canRead: true, canAct: () => false }).every(item => !item.canAct)).toBe(true)
  })
})

describe('mail cards client', () => {
  it('traces an address and names the failed step', async () => {
    mount('/whm/email/delivery')
    const request = vi.fn(async () => ({ route: 'remote', deliverable: false, failedStep: 'remote-domain-lookup', dnssec: 'unknown', relayHost: null, destination: null, hosts: [], steps: [{ step: 'address', state: 'passed', reason: null }, { step: 'remote-domain-lookup', state: 'failed', reason: 'no_mx_or_address' }] }))
    boot(request); await tick()
    field('mail-trace', 'address').value = 'x@nowhere.test'; action('mail-trace', 'run').click(); await tick()
    expect(request).toHaveBeenCalledWith('POST', '/api/server/mail-trace', { address: 'x@nowhere.test' })
    expect(fact('mail-trace', 'result')).toBe('Failed at: Remote domain lookup')
    expect(rows('mail-trace', 'steps')[1]!.textContent).toContain('The domain has no MX or address record.')
    expect(status('mail-trace').getAttribute('role')).toBe('alert')
  })
  it('links a relayer to delivery reports with its filter', async () => {
    mount('/whm/email/outbound')
    boot(async (_method, path) => path.includes('send-limits') ? { limits: { domainHourlyLimit: 0, deferFailPercent: 0, deferFailMinimum: 5 } } : { state: 'read', complete: true, observedAt: '2026-11-07T10:00:00.000Z', window: { since: '2026-11-07T09:00:00Z', until: '2026-11-07T10:00:00Z' }, rows: [{ user: 'a@b.test', domain: 'b.test', account: 'alice', messages: 3, sent: 2, deferred: 1, failed: 0, bytes: 2048 }] }); await tick()
    action('relayers', 'read').click(); await tick()
    expect(rows('relayers', 'relayers')[0]!.querySelector('a')!.getAttribute('href')).toBe('/whm/email/delivery?sender=a%40b.test')
  })
  it('flags a domain over its hourly limit in the current view', async () => {
    mount('/whm/email/outbound')
    const request = vi.fn(async (_method: string, path: string) => path.includes('send-limits') ? { limits: { domainHourlyLimit: 1, deferFailPercent: 0, deferFailMinimum: 5 } } : { state: 'read', complete: true, observedAt: '2026-11-07T10:00:00.000Z', window: { since: '2026-11-07T09:00:00Z', until: '2026-11-07T10:00:00Z' }, rows: [{ domain: 'b.test', account: 'alice', messages: 3, sent: 3, deferred: 0, failed: 0, bytes: 1, overHourly: true, overDeferFail: false }] })
    boot(request); await tick()
    field('sent-summary', 'view').value = 'current'; action('sent-summary', 'read').click(); await tick()
    expect(request).toHaveBeenCalledWith('GET', '/api/server/mail-reports/sent-summary?view=current', undefined)
    expect(rows('sent-summary', 'domains')[0]!.textContent).toContain('Over the hourly limit')
  })
  it('states a missing country database and keeps the countries unchecked', async () => {
    mount('/whm/email/spam')
    boot(async (_method, path) => path.endsWith('/country') ? { revision: 'r', state: 'not-saved', policy: { blocked: [] }, geoip: { installed: false, month: null } } : { revision: 'r', state: 'not-saved', policy: { allowedIps: [], children: 1, maxConnPerChild: 200, timeoutTcp: 30, timeoutChild: 300 }, engine: null }); await tick()
    expect(status('country-filter').textContent).toContain('not installed')
    expect(fact('country-filter', 'database')).toBe('Not installed')
    expect(card('country-filter').querySelectorAll('[data-mail-card-list] input')).toHaveLength(249)
  })
  it('refuses malformed advanced options without a request', async () => {
    mount('/whm/email/server')
    const request = vi.fn(async (_method: string, path: string) => path.endsWith('advanced') ? { revision: 'r', state: 'not-saved', policy: { postfix: { smtp_connect_timeout: '10s' } } } : { backups: [], compositeRevision: 'c', fingerprint: 'f'.repeat(64), limit: 20 })
    boot(request); await tick()
    expect(field('mta-advanced', 'overrides').value).toBe('smtp_connect_timeout = 10s')
    field('mta-advanced', 'overrides').value = 'no value'; action('mta-advanced', 'save').click(); await tick()
    expect(request.mock.calls.some(([method]) => method === 'PUT')).toBe(false)
    expect(status('mta-advanced').textContent).toContain('one name = value')
  })
  it('asks before a reset and sends the revision it read', async () => {
    mount('/whm/email/server')
    const request = vi.fn(async (method: string, path: string, _body?: unknown): Promise<unknown> => method === 'POST' ? { application: { outcome: 'applied' } } : path.endsWith('advanced') ? { revision: 'r', state: 'applied', policy: { postfix: {} } } : { backups: [], compositeRevision: 'c'.repeat(64), fingerprint: 'f'.repeat(64), limit: 20 })
    boot(request, async () => true); await tick()
    action('mta-backups', 'reset-full').click(); await tick()
    expect(request).toHaveBeenCalledWith('POST', '/api/server/mailx-config/reset', { type: 'full', expectedRevision: 'c'.repeat(64) })
  })
  it('stops at a declined confirmation', async () => {
    mount('/whm/email/maintenance')
    const request = vi.fn(async () => ({}))
    boot(request, async () => false); await tick()
    action('repair-permissions', 'run').click(); await tick()
    expect(request).not.toHaveBeenCalled()
  })
  it('imports the mapped rows and lists what was refused', async () => {
    mount('/email/filters', renderClassicMailCards, { ...access, domains: ['a.test'] })
    const request = vi.fn(async (_method: string): Promise<unknown> => ({ summary: { mailboxesImported: 2, forwardersImported: 0, errorCount: 1 }, errors: [{ row: 3, code: 'WEAK_PASSWORD', error: 'weak' }] }))
    boot(request); await tick()
    const input = field('address-importer', 'file')
    Object.defineProperty(input, 'files', { value: [new File(['one,GoodPassword1,10\ntwo,GoodPassword2,10\nthree,weak,10\n'], 'mail.csv')] })
    ;(File.prototype as unknown as { text?: unknown }).text ??= function (this: Blob) { return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(this) }) }
    field('address-importer', 'domain').value = 'a.test'
    action('address-importer', 'review').click(); await tick(); await tick()
    expect(fact('address-importer', 'rows')).toBe('3')
    action('address-importer', 'import').click(); await tick()
    const body = request.mock.calls.find(([method]) => method === 'POST') as unknown as [string, string, { rows: string[][] }]
    expect(body[2].rows[0]).toEqual(['one@a.test', 'GoodPassword1', '10'])
    const refused = rows('address-importer', 'results')[0]!.textContent
    expect(refused).toContain('Weak password')
    expect(refused).toContain('The password does not meet the mail password strength rule.')
    expect(refused).not.toContain('weak')
    expect(status('address-importer').textContent).toBe('Some rows were not imported.')
  })
  it('saves the enabled greylisting domains', async () => {
    mount('/email/spam-filters')
    const view = { revision: 'r', engine: 'rspamd', state: 'not-saved', domains: [{ domain: 'a.test', enabled: false }, { domain: 'b.test', enabled: false }] }
    const request = vi.fn(async (method: string, _path: string, _body?: unknown) => method === 'PUT' ? { ...view, stateChanged: true, application: { outcome: 'applied' } } : view)
    boot(request); await tick()
    action('greylisting', 'all').click(); await tick()
    action('greylisting', 'save').click(); await tick()
    expect(request).toHaveBeenCalledWith('PUT', '/api/account/mailx/greylisting', { domains: ['a.test', 'b.test'], expectedRevision: 'r' })
  })
  it('keeps rebuild off while full text search is not configured', async () => {
    mount('/mail/later')
    boot(async () => ({ fts: 'not_configured', jobsAvailable: true, job: null })); await tick()
    expect(action('search-index', 'rebuild').disabled).toBe(true)
    expect(status('search-index').textContent).toContain('not configured')
  })
  it('isolates the last rebuild time after its state', async () => {
    mount('/mail/later', renderV2MailCards)
    boot(async () => ({ fts: 'configured', jobsAvailable: true, job: { status: 'succeeded', finishedAt: '2026-11-09T22:03:00.000Z' } })); await tick()
    const cell = [...card('search-index').querySelectorAll<HTMLElement>('[data-mail-card-fact]')].find(node => node.dataset.mailCardFact === 'job')!
    expect(cell.textContent).toBe('Finished 2026-11-09 22:03 UTC')
    expect(cell.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2026-11-09 22:03 UTC')
  })
  it('reads nothing where the card is not admitted', async () => {
    mount('/whm/email/server', renderClassicMailCards, { canRead: false, canAct: () => false })
    const request = vi.fn(async () => ({}))
    boot(request); await tick()
    expect(request).not.toHaveBeenCalled()
    expect(status('mta-advanced').textContent).toContain('Nothing was read')
  })
})
