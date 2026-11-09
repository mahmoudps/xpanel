/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { readXlsRows as canonicalReadXlsRows } from './xls-reader.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest

const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate
const formatMailCardTime = formatDisplayDateTime

type Json = Record<string, any>
type Ask = ((options: Record<string, unknown>) => Promise<unknown>) | undefined
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ')

/** One row per line; lines starting with # are comments. */
export function parseMailImportText(text: string, delimiter: string): string[][] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).slice(0, 5001).map(line => line.split(delimiter || ',').map(cell => cell.trim()))
}
/** Applies the chosen column uses: `email`, `password`, `quota`, `destination` or `ignore`. Rows the server needs in a fixed order. */
export function mapMailImportRows(table: readonly (readonly string[])[], uses: readonly string[], options: { kind: string; domain: string; quota: string }): string[][] {
  const pick = (row: readonly string[], use: string): string => { const index = uses.indexOf(use); return index < 0 ? '' : row[index] ?? '' }
  return table.map(row => {
    const raw = pick(row, 'email'), email = raw && !raw.includes('@') && options.domain ? raw + '@' + options.domain : raw
    return options.kind === 'forwarders' ? [email, pick(row, 'destination')] : [email, pick(row, 'password'), pick(row, 'quota') || options.quota]
  })
}
export function parseMailOverrides(text: string): Record<string, string> | null {
  const entries: [string, string][] = []
  for (const line of text.split('\n').map(item => item.trim()).filter(Boolean)) {
    const at = line.indexOf('=')
    if (at < 1) return null
    entries.push([line.slice(0, at).trim(), line.slice(at + 1).trim()])
  }
  return new Set(entries.map(([key]) => key)).size === entries.length ? Object.fromEntries(entries) : null
}
export function formatMailBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-'
  return value < 1024 ? value + ' B' : value < 1048576 ? (value / 1024).toFixed(1) + ' KiB' : value < 1073741824 ? (value / 1048576).toFixed(1) + ' MiB' : (value / 1073741824).toFixed(2) + ' GiB'
}

function bindMailCards(askDialog: Ask): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const applied: Record<string, string> = { applied: t('Saved and applied.'), nothing: t('Saved. There was nothing to apply.'), 'rolled-back': t('The new settings failed the configuration check, so the previous settings were restored.'), refused: t('Saved, but the host refused to apply it.'), unknown: t('The apply outcome is unknown. Review the mail service before retrying.'), 'not-connected': t('Saved. No host agent is connected, so it is not applied yet.') }
  const refusals: Record<string, string> = { unknown_postfix_parameter: t('Saved, but an advanced option is not a parameter of this Postfix release, so nothing was applied.'), unmanaged_client_restrictions: t('Saved, but smtpd_client_restrictions holds rules not managed by xPanel. Merge them by hand first.'), geoip_unavailable: t('The country database is not installed on this server, so nothing was changed.'), country_filter_too_large: t('Saved, but the chosen countries hold too many networks for a Postfix table, so nothing was applied.'), unmanaged_file: t('Saved, but a file not managed by xPanel is in the way. Move it aside or merge it by hand.') }
  const sectionStates: Record<string, string> = { 'not-saved': t('Not managed by xPanel'), applied: t('Applied'), pending: t('Not applied yet'), unavailable: t('Unavailable') }
  const stepNames: Record<string, string> = { address: t('Address check'), 'local-route': t('Local route'), 'remote-domain-lookup': t('Remote domain lookup'), 'remote-host-address': t('Host address lookup'), 'remote-host-connect': t('Host connection') }
  const reasons: Record<string, string> = { invalid_address: t('This is not a valid address.'), unknown_recipient: t('No mailbox, forwarder or default address accepts this address.'), lookup_failed: t('The DNS lookup failed or timed out.'), null_mx: t('The domain publishes that it accepts no mail.'), no_mx_or_address: t('The domain has no MX or address record.'), host_has_no_address: t('No receiving host has an address.'), no_smtp_greeting: t('No receiving host answered with an SMTP greeting.') }
  const routes: Record<string, string> = { 'local-mailbox': t('Local mailbox'), forwarder: t('Forwarder'), 'mailing-list': t('Mailing list'), 'domain-forwarder': t('Domain forwarder'), 'default-address': t('Default address'), 'not-accepted': t('Not accepted'), remote: t('Remote server'), 'relay-host': t('Smart host') }
  const dnssec: Record<string, string> = { validated: t('Validated'), 'not-validated': t('Not validated'), unknown: t('Not read') }
  const statusNames: Record<string, string> = { sent: t('Delivered'), deferred: t('Deferred'), bounced: t('Bounced'), expired: t('Expired'), rejected: t('Rejected'), queued: t('Queued') }
  const checkStates: Record<string, string> = { ok: t('OK'), problem: t('Problem'), unavailable: t('Unavailable') }
  const modes: readonly (readonly [string, string])[] = [['auto', t('Automatic')], ['local', t('Local')], ['backup', t('Backup')], ['remote', t('Remote')]]
  const uses: readonly (readonly [string, string])[] = [['ignore', t('Ignore')], ['email', t('Email address')], ['password', t('Password')], ['quota', t('Quota in MB')], ['destination', t('Destination')]]
  const codes: Record<string, string> = { WEAK_PASSWORD: t('Weak password'), LIMIT_EXCEEDED: t('Plan limit reached'), INVALID_ADDRESS: t('Invalid address'), CONFLICT: t('Already exists'), FAILED: t('Could not be created') }
  const rowDetails: Record<string, string> = { WEAK_PASSWORD: t('The password does not meet the mail password strength rule.'), LIMIT_EXCEEDED: t('The account limit for this item has been reached.'), INVALID_ADDRESS: t('The address is not valid, or its domain is not on this account.'), CONFLICT: t('This address is already in use.'), FAILED: t('Check the address, its domain and the account limits.') }
  const backupReasons: Record<string, string> = { manual: t('Manual'), 'before-restore': t('Before a restore'), 'before-reset': t('Before a reset') }

  document.querySelectorAll<HTMLElement>('[data-mail-card]').forEach(card => {
    if (card.dataset.mailCardBound === 'true') return
    card.dataset.mailCardBound = 'true'
    const send = frameRequest(card)
    const id = card.dataset.mailCard ?? '', statusNode = card.querySelector<HTMLElement>('[data-mail-card-status]')
    if (!statusNode) return
    const canRead = (): boolean => card.isConnected && card.dataset.mailCardCanRead === 'true' && !!send
    const canAct = (): boolean => canRead() && card.dataset.mailCardCanAct === 'true' && !card.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    let busy = false, ready = false
    const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(key: string): T => [...card.querySelectorAll<T>('[data-mail-card-field]')].find(item => item.dataset.mailCardField === key)!
    const action = (key: string): HTMLButtonElement | undefined => [...card.querySelectorAll<HTMLButtonElement>('[data-mail-card-action]')].find(item => item.dataset.mailCardAction === key)
    const note = (state: string, text: string): void => { statusNode.dataset.state = state; statusNode.textContent = text; statusNode.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const cell = [...card.querySelectorAll<HTMLElement>('[data-mail-card-fact]')].find(item => item.dataset.mailCardFact === key); if (cell) cell.textContent = value }
    const sync = (): void => {
      card.querySelectorAll<HTMLButtonElement>('[data-mail-card-action]').forEach(button => { button.disabled = busy || !(button.hasAttribute('data-mail-card-write') ? canAct() && ready : canRead()) })
      card.querySelectorAll<HTMLInputElement>('[data-mail-card-field]').forEach(input => { input.disabled = busy || !canRead() })
    }
    const problem = (error: unknown): string => {
      const raw = error && typeof error === 'object' ? error as Json : {}, detail = raw.details && typeof raw.details === 'object' ? raw.details as Json : {}
      if (detail.unknownOutcome === true || detail.verificationRequired === true) return t('The outcome is unknown. Reload and review before retrying.')
      if (detail.reason === 'geoip_unavailable') return t('The country database is not installed on this server, so nothing was changed.')
      if (detail.reason === 'REINDEX_IN_PROGRESS') return t('A rebuild is already running for this mailbox.')
      if (detail.reason === 'fts_not_configured') return t('Full text search is not configured on this server, so no index was built.')
      if (detail.reason === 'relay_password_required') return t('The file names a relay user whose password is not saved here, so nothing was changed.')
      if (detail.reason === 'no_saved_mx') return t('This domain has no MX record in a zone on this server, so its routing cannot be detected.')
      if (raw.status === 401 || raw.status === 403) return t('You are not allowed to do this. Nothing was changed.')
      if (raw.status === 409 || raw.code === 'CONFLICT') return t('This changed since it was read. Reload and review before saving.')
      if (raw.status === 422 || raw.code === 'VALIDATION') return t('Some values are not valid. Nothing was changed.')
      return t('The request failed. Reload to see the current state.')
    }
    const work = async (task: () => Promise<void>): Promise<void> => {
      if (busy) return
      busy = true; sync(); card.setAttribute('aria-busy', 'true')
      try { await task() } catch (error) { note('failed', problem(error)) } finally { busy = false; sync(); card.setAttribute('aria-busy', 'false') }
    }
    const call = async (method: string, path: string, body?: unknown): Promise<Json> => await send!(method, path, body) as Json
    const on = (key: string, handler: () => Promise<void> | void): void => { const button = action(key); button?.addEventListener('click', () => { if (!button.disabled) void work(async () => { await handler() }) }) }
    const rows = <T>(key: string, items: readonly T[], fill: (slot: (name: string) => HTMLElement, item: T, row: HTMLElement) => void, slots: readonly string[]): void => {
      const body = [...card.querySelectorAll<HTMLElement>('[data-mail-card-rows]')].find(item => item.dataset.mailCardRows === key)
      if (!body) return
      const nodes = items.map(item => { const row = cloneClientTemplate(clientTemplate(card, 'mail-card-' + key), 'tr', slots); fill(name => clientTemplateSlot(row, name), item, row); return row })
      body.replaceChildren(...nodes)
    }
    const text = (slot: HTMLElement, value: unknown, technical = false): void => { slot.textContent = value === null || value === undefined || value === '' ? '-' : String(value); if (technical) slot.dir = 'ltr' }
    const link = (slot: HTMLElement, label: string, href: string): void => { const node = cloneClientTemplate(clientTemplate(card, 'mail-card-link'), 'a', ['content']) as HTMLAnchorElement; node.textContent = label; node.href = href; node.dir = 'ltr'; slot.replaceChildren(node) }
    const button = (slot: HTMLElement, label: string, handler: () => Promise<void>, write = true): void => { const node = cloneClientTemplate(clientTemplate(card, 'mail-card-button'), 'button', ['content']) as HTMLButtonElement; node.textContent = label; node.disabled = write && !canAct(); node.addEventListener('click', () => { void work(handler) }); slot.append(node) }
    const confirmed = async (title: string, body: string): Promise<boolean> => !!(askDialog ? await askDialog({ title, body, confirm: title, danger: true }) : window.confirm(title + '\n' + body))
    const range = (hours: string): string => { const end = Math.floor(Date.now() / 1000) * 1000, iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'; return 'since=' + encodeURIComponent(iso(end - Number(hours) * 3600000)) + '&until=' + encodeURIComponent(iso(end)) }
    const windowFacts = (view: Json): void => { fact('observed', formatMailCardTime(view.observedAt)); fact('window', formatMailCardTime(view.window?.since) + ' - ' + formatMailCardTime(view.window?.until)) }
    const readable = (view: Json, count: number): void => view.state !== 'read' ? note('unavailable', t('The system journal could not be read, so no report is shown.')) : !view.complete ? note('partial', t('The bounded read may be incomplete. Narrow the time range.')) : note('read', count ? t('Read {count} rows.', { count: String(count) }) : t('Nothing matched in this window.'))
    const policyLine = (view: Json): string => sectionStates[view.state] ?? t('Unavailable')
    const appliedNote = (reply: Json): void => { const outcome = String(reply.application?.outcome ?? 'unknown'); note(outcome === 'applied' || outcome === 'nothing' ? 'saved' : outcome === 'unknown' ? 'failed' : 'partial', refusals[reply.application?.reason] ?? applied[outcome] ?? applied.unknown!) }
    let start: (() => Promise<void>) | null = null, revision = ''

    if (id === 'mail-trace') on('run', async () => {
      const address = field('address').value.trim()
      if (!address) { note('failed', t('Enter an address.')); return }
      note('reading', t('Tracing the route…'))
      const view = await call('POST', '/api/server/mail-trace', { address })
      fact('route', routes[view.route] ?? String(view.route)); fact('result', view.deliverable ? t('Mail can be routed') : t('Failed at: {step}', { step: stepNames[view.failedStep] ?? String(view.failedStep) })); fact('dnssec', dnssec[view.dnssec] ?? dnssec.unknown!); fact('relay', view.relayHost ?? '-'); fact('destination', view.destination ?? '-')
      rows('steps', view.steps as Json[], (slot, item) => { text(slot('step'), stepNames[item.step] ?? item.step); text(slot('state'), item.state === 'passed' ? t('Passed') : t('Failed')); text(slot('reason'), item.reason ? reasons[item.reason] ?? item.reason : '') }, ['step', 'state', 'reason'])
      rows('hosts', view.hosts as Json[], (slot, item) => { text(slot('host'), item.host, true); text(slot('priority'), item.priority, true); text(slot('addresses'), item.addresses.join(', '), true); text(slot('connected'), item.connected === null ? t('Not tried') : item.connected ? t('Answered') : t('No answer')) }, ['host', 'priority', 'addresses', 'connected'])
      note(view.deliverable ? 'read' : 'failed', view.deliverable ? t('The route is traced.') : t('The route fails at one step.'))
    })
    if (id === 'relayers') { const read = async (): Promise<void> => {
      note('reading', t('Reading the system journal…'))
      const view = await call('GET', '/api/server/mail-reports/relayers?' + range(field('hours').value)); windowFacts(view)
      rows('relayers', view.rows as Json[], (slot, item) => { link(slot('user'), item.user, '/whm/email/delivery?sender=' + encodeURIComponent(item.user)); text(slot('domain'), item.domain, true); text(slot('account'), item.account, true); for (const key of ['messages', 'sent', 'deferred', 'failed']) text(slot(key), item[key], true); text(slot('bytes'), formatMailBytes(item.bytes), true) }, ['user', 'domain', 'account', 'messages', 'sent', 'deferred', 'failed', 'bytes'])
      readable(view, view.rows.length) }; on('read', read) }
    if (id === 'sent-summary') { const read = async (): Promise<void> => {
      note('reading', t('Reading the system journal…'))
      const current = field<HTMLSelectElement>('view').value === 'current', view = await call('GET', '/api/server/mail-reports/sent-summary?' + (current ? 'view=current' : range(field('hours').value))); windowFacts(view)
      rows('domains', view.rows as Json[], (slot, item) => { link(slot('domain'), item.domain, '/whm/email/delivery?domain=' + encodeURIComponent(item.domain)); text(slot('account'), item.account, true); for (const key of ['messages', 'sent', 'deferred', 'failed']) text(slot(key), item[key], true); text(slot('bytes'), formatMailBytes(item.bytes), true); text(slot('limits'), !current ? '' : item.overHourly ? t('Over the hourly limit') : item.overDeferFail ? t('Over the deferred and failed share') : t('Within limits')) }, ['domain', 'account', 'messages', 'sent', 'deferred', 'failed', 'bytes', 'limits'])
      readable(view, view.rows.length) }; on('read', read) }
    if (id === 'send-limits') {
      start = async () => { const { limits } = await call('GET', '/api/server/mail-reports/send-limits'); for (const key of ['domainHourlyLimit', 'deferFailPercent', 'deferFailMinimum']) field(key).value = String(limits[key]); ready = true; note('read', t('The reporting limits are read.')) }
      on('save', async () => { await call('PUT', '/api/server/mail-reports/send-limits', { domainHourlyLimit: Number(field('domainHourlyLimit').value), deferFailPercent: Number(field('deferFailPercent').value), deferFailMinimum: Number(field('deferFailMinimum').value) }); note('saved', t('The reporting limits are saved.')) })
    }
    if (id === 'spamd-startup') {
      start = async () => { const view = await call('GET', '/api/server/mailx/spamd'); revision = view.revision; const policy = view.policy
        field<HTMLTextAreaElement>('allowedIps').value = policy.allowedIps.join('\n'); for (const key of ['children', 'maxConnPerChild', 'timeoutTcp', 'timeoutChild']) field(key).value = String(policy[key])
        fact('state', policyLine(view)); fact('engine', view.engine?.engine ?? t('No supported filter is running')); ready = true; note('read', t('The startup options are read.')) }
      on('save', async () => { const number = (key: string): number => Number(field(key).value), reply = await call('PUT', '/api/server/mailx/spamd', { expectedRevision: revision, policy: { allowedIps: field<HTMLTextAreaElement>('allowedIps').value.split('\n').map(line => line.trim()).filter(Boolean), maxConnPerChild: number('maxConnPerChild'), children: number('children'), timeoutTcp: number('timeoutTcp'), timeoutChild: number('timeoutChild') } }); revision = reply.revision; fact('state', policyLine(reply)); appliedNote(reply) })
    }
    if (id === 'country-filter') {
      const list = card.querySelector<HTMLElement>('[data-mail-card-list]')!, names = new Intl.DisplayNames([document.documentElement.lang || 'en'], { type: 'region' }), boxes = new Map<string, HTMLInputElement>()
      const entries = COUNTRY_CODES.map(code => { const label = cloneClientTemplate(clientTemplate(card, 'mail-card-check'), 'label', ['control', 'label']), box = clientTemplateSlot(label, 'control', 'input') as HTMLInputElement; clientTemplateSlot(label, 'label').textContent = (names.of(code) ?? code) + ' (' + code + ')'; box.addEventListener('change', count); boxes.set(code, box); return label })
      function count(): void { fact('blocked', String([...boxes.values()].filter(box => box.checked).length)) }
      list.replaceChildren(...entries)
      field('search').addEventListener('input', () => { const query = field('search').value.trim().toLowerCase(); for (const label of entries) label.hidden = !!query && !label.textContent!.toLowerCase().includes(query) })
      start = async () => { const view = await call('GET', '/api/server/mailx/country'); revision = view.revision; for (const [code, box] of boxes) box.checked = view.policy.blocked.includes(code)
        count(); fact('state', policyLine(view)); fact('database', view.geoip?.installed ? t('Installed: {month}', { month: view.geoip.month }) : t('Not installed')); ready = true; for (const box of boxes.values()) box.disabled = !canAct()
        note(view.geoip?.installed ? 'read' : 'unavailable', view.geoip?.installed ? t('The country filter is read.') : t('The country database is not installed on this server, so countries cannot be blocked.')) }
      on('all', () => { for (const [, box] of boxes) box.checked = true; count() }); on('none', () => { for (const [, box] of boxes) box.checked = false; count() })
      on('save', async () => { const reply = await call('PUT', '/api/server/mailx/country', { expectedRevision: revision, policy: { blocked: [...boxes].filter(([, box]) => box.checked).map(([code]) => code) } }); revision = reply.revision; fact('state', policyLine(reply)); appliedNote(reply) })
    }
    if (id === 'mta-advanced') {
      start = async () => { const view = await call('GET', '/api/server/mailx/advanced'); revision = view.revision; field<HTMLTextAreaElement>('overrides').value = Object.entries(view.policy.postfix as Record<string, string>).map(([key, value]) => key + ' = ' + value).join('\n'); fact('state', policyLine(view)); ready = true; note('read', t('Advanced options are read.')) }
      on('save', async () => { const postfix = parseMailOverrides(field<HTMLTextAreaElement>('overrides').value); if (!postfix) { note('failed', t('Use one name = value per line, each name once. Nothing was saved.')); return } const reply = await call('PUT', '/api/server/mailx/advanced', { expectedRevision: revision, policy: { postfix } }); revision = reply.revision; fact('state', policyLine(reply)); appliedNote(reply) })
    }
    if (id === 'mta-backups') {
      const short = (value: string): string => value.slice(0, 12)
      const load = async (): Promise<void> => { const view = await call('GET', '/api/server/mailx-config/backups'); revision = view.compositeRevision; fact('fingerprint', short(view.fingerprint)); fact('limit', String(view.limit)); ready = true
        rows('backups', view.backups as Json[], (slot, item) => { text(slot('created'), formatMailCardTime(item.createdAt), true); text(slot('by'), item.createdBy, true); text(slot('reason'), backupReasons[item.reason] ?? item.reason); text(slot('fingerprint'), short(item.fingerprint), true); slot('actions').replaceChildren()
          button(slot('actions'), t('Restore'), async () => { if (!await confirmed(t('Restore this backup?'), t('The saved mail settings are replaced and applied. A safety copy is taken first.'))) return; const reply = await call('POST', '/api/server/mailx-config/restore', { backup: item.id, expectedRevision: revision }); appliedNote(reply); await load() })
          button(slot('actions'), t('Download'), async () => { const copy = await call('GET', '/api/server/mailx-config/backups/' + item.id), anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' })); anchor.download = 'mail-config-' + String(item.createdAt).slice(0, 10) + '.json'; anchor.click(); URL.revokeObjectURL(anchor.href) }, false) }, ['created', 'by', 'reason', 'fingerprint', 'actions']) }
      start = async () => { await load(); note('read', t('Backups are read.')) }
      on('create', async () => { await call('POST', '/api/server/mailx-config/backups'); await load(); note('saved', t('A backup was stored on this server.')) })
      on('upload', async () => { const file = field('upload').files?.[0]; if (!file) { note('failed', t('Choose a backup file first.')); return } let backup: unknown; try { backup = JSON.parse(await file.text()) } catch { note('failed', t('This file is not a mail configuration backup.')); return } if (!await confirmed(t('Restore this backup?'), t('The saved mail settings are replaced and applied. A safety copy is taken first.'))) return; appliedNote(await call('POST', '/api/server/mailx-config/restore', { backup, expectedRevision: revision })); await load() })
      const reset = (type: string, title: string, body: string): (() => Promise<void>) => async () => { if (!await confirmed(title, body)) return; appliedNote(await call('POST', '/api/server/mailx-config/reset', { type, expectedRevision: revision })); await load() }
      on('reset-advanced', reset('advanced', t('Reset advanced options?'), t('Every advanced option returns to the Postfix default. A safety copy is taken first.')))
      on('reset-full', reset('full', t('Reset the mail settings?'), t('Every saved mail setting returns to its default, including relay, copies and routing. A safety copy is taken first.')))
    }
    if (id === 'repair-permissions') {
      ready = true
      on('run', async () => { const some = field<HTMLSelectElement>('scope').value === 'some', accounts = some ? field<HTMLTextAreaElement>('accounts').value.split('\n').map(line => line.trim()).filter(Boolean) : 'all'
        if (some && !accounts.length) { note('failed', t('List at least one account.')); return }
        if (!await confirmed(t('Repair mail permissions?'), t('Owners and modes change under each chosen account\'s mail directory.'))) return
        const reply = await call('POST', '/api/server/mail-maintenance/repair', { accounts }); note('saved', t('{jobs} host jobs queued for {accounts} accounts. Each job log lists the paths it changed.', { jobs: String(reply.jobs.length), accounts: String(reply.accounts) })) })
    }
    if (id === 'domain-forwarders') {
      const select = field<HTMLSelectElement>('sourceDomain')
      const load = async (): Promise<void> => { const view = await call('GET', '/api/mail/domain-forwarders'); ready = true
        rows('forwarders', view.forwarders as Json[], (slot, item) => { text(slot('source'), item.sourceDomain, true); text(slot('target'), item.targetDomain, true); text(slot('state'), item.application?.state === 'applied' ? t('Applied') : item.application?.state === 'failed' ? t('Failed') : t('Not applied yet')); slot('actions').replaceChildren()
          button(slot('actions'), t('Delete'), async () => { if (!await confirmed(t('Delete this domain forwarder?'), t('Mail for addresses without a mailbox stops going to the destination domain.'))) return; await call('DELETE', '/api/mail/domain-forwarders/' + encodeURIComponent(item.id)); await load(); note('saved', t('The domain forwarder was deleted.')) }) }, ['source', 'target', 'state', 'actions'])
      }
      start = async () => { await load(); note('read', t('Domain forwarders are read.')) }
      on('add', async () => { const targetDomain = field('targetDomain').value.trim().toLowerCase(); if (!targetDomain) { note('failed', t('Enter a destination domain.')); return } await call('POST', '/api/mail/domain-forwarders', { sourceDomain: select.value, targetDomain }); field('targetDomain').value = ''; await load(); note('saved', t('The domain forwarder was added.')) })
    }
    if (id === 'deliverability') {
      let domains: string[] = [], checks = new Map<string, Json>(), max = 50
      const paint = (): void => rows('domains', domains, (slot, domain) => { text(slot('domain'), domain, true); const result = checks.get(domain); for (const key of ['mx', 'spf', 'dkim', 'dmarc', 'ptr']) text(slot(key), result ? checkStates[result[key].state] ?? result[key].state : t('Not read')); slot('actions').replaceChildren()
        button(slot('actions'), t('Repair'), async () => { if (!await confirmed(t('Repair this domain?'), t('Missing SPF, DKIM and DMARC records are added to its zone.'))) return; await call('POST', '/api/dns/email-auth/batch', { domains: [domain] }); note('saved', t('The records were saved. Run the checks again after DNS has updated.')) }) }, ['domain', 'mx', 'spf', 'dkim', 'dmarc', 'ptr', 'actions'])
      start = async () => { const view = await call('GET', '/api/account/mailx/deliverability'); domains = (view.domains as Json[]).map(item => item.domain); max = view.maxCheck; ready = true; paint(); note('read', domains.length ? t('Run the checks to read each domain.') : t('This account has no domains.')) }
      on('check', async () => { note('reading', t('Checking public DNS…')); const view = await call('POST', '/api/account/mailx/deliverability', { domains: domains.slice(0, max) }); checks = new Map((view.results as Json[]).map(item => [item.domain, item])); fact('checked', formatMailCardTime(view.checkedAt)); paint(); note(view.timedOut ? 'partial' : 'read', view.timedOut ? t('Some checks timed out. Run them again.') : t('The checks are complete.')) })
    }
    if (id === 'email-routing') {
      const load = async (): Promise<void> => { const view = await call('GET', '/api/account/mailx/routing'); revision = view.revision; ready = true
        rows('routes', view.domains as Json[], (slot, item) => { text(slot('domain'), item.domain, true); text(slot('mx'), (item.mx as Json[]).map(mx => mx.priority + ' ' + mx.host).join(', '), true); const choice = cloneClientTemplate(clientTemplate(card, 'mail-card-select'), 'select', ['content']) as HTMLSelectElement; choice.replaceChildren(...modes.map(([value, label]) => new Option(label, value))); choice.value = item.auto ? 'auto' : item.mode; choice.disabled = !canAct(); choice.setAttribute('aria-label', item.domain); slot('mode').replaceChildren(choice); slot('actions').replaceChildren()
          button(slot('actions'), t('Save'), async () => { if (!await confirmed(t('Change email routing?'), t('A wrong choice can stop mail for this domain.'))) return; const reply = await call('PUT', '/api/account/mailx/routing', { domain: item.domain, mode: choice.value, expectedRevision: revision }); revision = reply.revision; appliedNote(reply); await load() }) }, ['domain', 'mx', 'mode', 'actions']) }
      start = async () => { await load(); note('read', t('Email routing is read.')) }
    }
    if (id === 'greylisting') {
      let domains: Json[] = []
      const paint = (): void => { const query = field('search').value.trim().toLowerCase(); rows('domains', domains.filter(item => !query || item.domain.includes(query)), (slot, item) => { text(slot('domain'), item.domain, true); const label = cloneClientTemplate(clientTemplate(card, 'mail-card-check'), 'label', ['control', 'label']), box = clientTemplateSlot(label, 'control', 'input') as HTMLInputElement; clientTemplateSlot(label, 'label').textContent = t('Enabled'); box.checked = item.enabled; box.disabled = !canAct(); box.addEventListener('change', () => { item.enabled = box.checked }); slot('enabled').replaceChildren(label) }, ['domain', 'enabled']) }
      const show = (view: Json): void => { domains = view.domains; revision = view.revision; fact('engine', view.engine ?? t('No supported filter is running')); fact('state', sectionStates[view.state] ?? t('Unavailable')); paint() }
      start = async () => { show(await call('GET', '/api/account/mailx/greylisting')); ready = true; note('read', t('Greylisting is read.')) }
      field('search').addEventListener('input', paint)
      on('all', () => { for (const item of domains) item.enabled = true; paint() }); on('none', () => { for (const item of domains) item.enabled = false; paint() })
      on('save', async () => { const reply = await call('PUT', '/api/account/mailx/greylisting', { domains: domains.filter(item => item.enabled).map(item => item.domain), expectedRevision: revision }); show(reply); reply.stateChanged ? appliedNote(reply) : note('read', t('Nothing changed.')) })
    }
    if (id === 'track-delivery') on('read', async () => {
      note('reading', t('Reading the system journal…'))
      const recipient = field('recipient').value.trim().toLowerCase(), problems = field<HTMLSelectElement>('view').value === 'problems'
      const view = await call('GET', '/api/account/mailx/track-delivery?' + range(field('hours').value) + (recipient ? '&recipient=' + encodeURIComponent(recipient) : '') + (problems ? '&statuses=deferred,bounced,expired,rejected' : '')); windowFacts(view); fact('matched', String(view.matched))
      rows('messages', view.messages as Json[], (slot, item) => { text(slot('when'), formatMailCardTime(item.lastSeen), true); text(slot('sender'), item.sender, true); text(slot('recipients'), (item.recipients as Json[]).map(row => row.address).join(', ') + (item.otherRecipients ? ' ' + t('and {count} others', { count: String(item.otherRecipients) }) : ''), true); text(slot('status'), statusNames[item.status] ?? item.status); text(slot('result'), (item.recipients as Json[])[0]?.response ?? item.dsn); text(slot('size'), item.size === null ? '' : formatMailBytes(item.size), true) }, ['when', 'sender', 'recipients', 'status', 'result', 'size'])
      readable(view, view.messages.length)
    })
    if (id === 'search-index') {
      const states: Record<string, string> = { configured: t('Configured'), not_configured: t('Not configured'), unavailable: t('Unavailable') }, jobs: Record<string, string> = { queued: t('Queued'), running: t('Running'), succeeded: t('Finished'), failed: t('Failed'), cancelled: t('Cancelled') }
      const load = async (): Promise<void> => { const view = await call('GET', '/api/webmail/search-index'); fact('fts', states[view.fts] ?? t('Unavailable')); fact('job', view.job ? (jobs[view.job.status] ?? view.job.status) + (view.job.finishedAt ? ' ' + formatMailCardTime(view.job.finishedAt) : '') : t('Never')); ready = view.fts === 'configured' && view.jobsAvailable === true; note(view.fts === 'configured' ? 'read' : 'unavailable', view.fts === 'configured' ? t('The search index is read.') : t('Full text search is not configured on this server. Search still reads each folder directly.')) }
      start = load
      on('rebuild', async () => { await call('POST', '/api/webmail/search-index'); await load(); note('saved', t('The rebuild is queued.')) })
    }
    if (id === 'address-importer') {
      const kind = field<HTMLSelectElement>('kind'), domain = field<HTMLSelectElement>('domain'), file = field('file')
      let table: string[][] = [], choices: HTMLSelectElement[] = []
      const reset = (): void => { table = []; choices = []; ready = false; rows('columns', [], () => {}, []); fact('rows', ''); sync() }
      field('quota').value = '1024'
      for (const control of [kind, file, field('delimiter'), field('header')]) control.addEventListener('change', reset)
      on('review', async () => {
        const chosen = file.files?.[0]; if (!chosen) { note('failed', t('Choose a file first.')); return }
        if (chosen.size > 1048576) { note('failed', t('This file is larger than 1 MiB.')); return }
        const delimiter = field('delimiter').value; if (delimiter.length > 1) { note('failed', t('The delimiter is one character.')); return }
        let parsed: string[][]
        try { parsed = /\.xls$/i.test(chosen.name) ? readXlsRows(new Uint8Array(await chosen.arrayBuffer())) : parseMailImportText(await chosen.text(), delimiter) }
        catch (error) { note('failed', (error as Error).message === 'encrypted_xls' ? t('This workbook is password protected. Remove the password, or save it as CSV.') : t('This file could not be read as an Excel workbook. Save it as CSV.')); return }
        const first = parsed[0] ?? [], header = field('header').checked; table = header ? parsed.slice(1) : parsed
        if (!table.length) { note('failed', t('This file has no rows.')); return }
        const guess = kind.value === 'forwarders' ? ['email', 'destination'] : ['email', 'password', 'quota']
        choices = []; rows('columns', first.map((value, index) => ({ value, index })), (slot, item) => { text(slot('column'), item.index + 1, true); text(slot('sample'), kind.value === 'mailboxes' && guess[item.index] === 'password' ? '***' : header ? item.value : table[0]![item.index], true); const choice = cloneClientTemplate(clientTemplate(card, 'mail-card-select'), 'select', ['content']) as HTMLSelectElement; choice.replaceChildren(...uses.map(([value, label]) => new Option(label, value))); choice.value = guess[item.index] ?? 'ignore'; choice.disabled = false; choice.setAttribute('aria-label', String(item.index + 1)); slot('use').replaceChildren(choice); choices.push(choice) }, ['column', 'sample', 'use'])
        fact('rows', String(table.length)); ready = true; note('read', t('Check the column mapping, then import.'))
      })
      on('import', async () => {
        const mapped = mapMailImportRows(table, choices.map(choice => choice.value), { kind: kind.value, domain: domain.value, quota: field('quota').value })
        const reply = await call('POST', '/api/mail/import-csv', { kind: kind.value, rows: mapped }); fact('imported', String(reply.summary.mailboxesImported + reply.summary.forwardersImported)); fact('failed', String(reply.summary.errorCount))
        rows('results', reply.errors as Json[], (slot, item) => { text(slot('row'), item.row, true); text(slot('code'), codes[item.code] ?? item.code); text(slot('detail'), rowDetails[item.code] ?? rowDetails.FAILED!) }, ['row', 'code', 'detail'])
        note(reply.summary.errorCount ? 'partial' : 'saved', reply.summary.errorCount ? t('Some rows were not imported.') : t('Every row was imported.'))
      })
    }
    sync()
    if (!canRead()) { note('unavailable', t('This tool is unavailable here. Nothing was read.')); return }
    if (start) { const begin = start; void work(begin) }
  })
}

const readXlsRows = canonicalReadXlsRows
export const MAIL_CARDS_CLIENT_BINDING = withFrameRequest(`(()=>{const readXlsRows=${readXlsRows.toString()};const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const formatMailCardTime=${DISPLAY_DATETIME_BINDING};const COUNTRY_CODES=${JSON.stringify(COUNTRY_CODES)};const parseMailImportText=${parseMailImportText.toString()};const mapMailImportRows=${mapMailImportRows.toString()};const parseMailOverrides=${parseMailOverrides.toString()};const formatMailBytes=${formatMailBytes.toString()};return ${bindMailCards.toString()};})()`)
