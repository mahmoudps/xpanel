/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

export type MailServerStateView = 'match' | 'drift' | 'not-managed' | 'unknown'
export type MailServerComparisonView = { key: string; observed: string | null; desired: string | null; state: MailServerStateView }
export type MailServerView = {
  page: 'server' | 'routing' | 'outbound'
  host: 'connected' | 'not-connected' | 'unverified'
  observedAt: string | null
  sources: { postfix: 'read' | 'unavailable'; master: 'read' | 'unavailable'; dovecot: 'read' | 'unavailable'; desired: 'rendered' | 'unavailable' }
  settings: (MailServerComparisonView & { source: 'postfix' | 'dovecot' })[]
  services: { service: string; observed: string | null; desired: string | null; state: MailServerStateView; options: MailServerComparisonView[]; otherOptions: number }[]
  domains: { domain: string; account: string | null; mailboxes: number; zone: string | null; mx: { priority: number | null; host: string }[]; state: 'mx-saved' | 'mx-missing' | 'zone-missing' | 'no-mailboxes' }[]
  truncated: boolean
}
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Strict reader for GET /api/server/mail-server/{page}; unknown fields are dropped and any inconsistent state is refused. */
export function readMailServerView(value: unknown, page: string): MailServerView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  const nullable = (item: unknown, max: number): item is string | null => item === null || text(item, max)
  const int = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const bad = (): never => { throw new Error('invalid_mail_server_view') }
  const list = <T>(item: unknown, max: number, read: (raw: Record<string, unknown>) => T): T[] => Array.isArray(item) && item.length <= max ? item.map(raw => object(raw) ? read(raw) : bad()) : bad()
  // A rendered value is required to claim match or drift, and a match needs an observed value.
  const compared = (raw: Record<string, unknown>, max: number): MailServerComparisonView => {
    if (!text(raw.key, 64) || !/^[a-z0-9_]+$/.test(raw.key) || !nullable(raw.observed, max) || !nullable(raw.desired, max) || !['match', 'drift', 'not-managed', 'unknown'].includes(String(raw.state))
      || raw.state === 'not-managed' && raw.desired !== null || ['match', 'drift'].includes(String(raw.state)) && raw.desired === null || raw.state === 'match' && raw.observed === null) return bad()
    return { key: raw.key, observed: raw.observed, desired: raw.desired, state: raw.state as MailServerStateView }
  }
  if (!object(value) || value.page !== page || !['server', 'routing', 'outbound'].includes(page) || !['connected', 'not-connected', 'unverified'].includes(String(value.host)) || !object(value.sources)
    || (value.host === 'connected' ? !iso(value.observedAt) : value.observedAt !== null) || typeof value.truncated !== 'boolean' || value.editable !== false) return bad()
  const sources = value.sources
  if (!['postfix', 'master', 'dovecot'].every(key => ['read', 'unavailable'].includes(String(sources[key]))) || !['rendered', 'unavailable'].includes(String(sources.desired))
    || value.host !== 'connected' && ['postfix', 'master', 'dovecot'].some(key => sources[key] === 'read')) return bad()
  const settings = list(value.settings, 64, raw => ['postfix', 'dovecot'].includes(String(raw.source)) ? { source: raw.source as 'postfix' | 'dovecot', ...compared(raw, 4096) } : bad())
  const services = list(value.services, 64, raw => text(raw.service, 128) && nullable(raw.observed, 256) && nullable(raw.desired, 256) && ['match', 'drift', 'not-managed', 'unknown'].includes(String(raw.state)) && int(raw.otherOptions)
    ? { service: raw.service, observed: raw.observed, desired: raw.desired, state: raw.state as MailServerStateView, options: list(raw.options, 32, option => compared(option, 4096)), otherOptions: raw.otherOptions } : bad())
  const domains = list(value.domains, 2000, raw => text(raw.domain, 253) && nullable(raw.account, 64) && int(raw.mailboxes) && nullable(raw.zone, 253) && ['mx-saved', 'mx-missing', 'zone-missing', 'no-mailboxes'].includes(String(raw.state))
    ? { domain: raw.domain, account: raw.account, mailboxes: raw.mailboxes, zone: raw.zone, state: raw.state as MailServerView['domains'][number]['state'],
      mx: list(raw.mx, 20, mx => (mx.priority === null || int(mx.priority)) && text(mx.host, 255) ? { priority: mx.priority as number | null, host: mx.host } : bad()) } : bad())
  const consistent = (item: MailServerView['domains'][number]): boolean => item.state === 'no-mailboxes' ? item.mailboxes === 0
    : item.mailboxes > 0 && (item.state === 'zone-missing' ? item.zone === null : item.zone !== null && (item.state === 'mx-saved') === (item.mx.length > 0))
  if (!domains.every(consistent) || page !== 'routing' && domains.length || page === 'routing' && services.length) return bad()
  return { page: page as MailServerView['page'], host: value.host as MailServerView['host'], observedAt: value.observedAt as string | null,
    sources: { postfix: sources.postfix as 'read', master: sources.master as 'read', dovecot: sources.dovecot as 'read', desired: sources.desired as 'rendered' }, settings, services, domains, truncated: value.truncated }
}

function bindWhmMailServer(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-mail-server-workspace]').forEach(root => {
    if (root.dataset.mailServerBound === 'true') return
    root.dataset.mailServerBound = 'true'
    const page = root.dataset.mailServerPage ?? '', status = root.querySelector<HTMLElement>('[data-whm-mail-server-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-mail-server-refresh]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!['server', 'routing', 'outbound'].includes(page) || !status || !refresh) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.mailServerCanRead === 'true' && !root.closest(denied) && !!request
    const states: Record<string, string> = { match: t('Matches'), drift: t(msgctxt('whm-mail-server-client', 'Drift')), 'not-managed': t('Not managed'), unknown: t('Not verified') }
    const expectations: Record<string, string> = { 'mx-saved': t('MX saved'), 'mx-missing': t('No MX saved; senders fall back to the domain address (RFC 5321)'),
      'zone-missing': t('No saved DNS zone on this server'), 'no-mailboxes': t('No mailboxes; not a virtual mailbox domain') }
    let busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const shown = (value: string | null, missing: string): string | Node => value === null ? missing : value === '' ? t('Empty value') : technical(value)
    const body = (name: string): HTMLElement | null => root.querySelector<HTMLElement>('[data-whm-mail-server-' + name + ']')
    // The last cell of a compared row carries its state key so drift stays distinguishable without colour.
    const fill = (tbody: HTMLElement | null, rows: { cells: (string | Node)[]; state?: string }[], columns: number, empty: string): void => {
      if (!tbody) return
      tbody.textContent = ''
      for (const { cells, state } of rows.length ? rows : [{ cells: [empty] }]) {
        const row = document.createElement('tr')
        for (const content of cells) { const cell = document.createElement('td'); cell.append(content); row.append(cell) }
        if (!rows.length) (row.firstChild as HTMLTableCellElement).colSpan = columns
        if (state) { const cell = document.createElement('td'); cell.dataset.state = state; cell.textContent = states[state] ?? ''; row.append(cell) }
        tbody.append(row)
      }
    }
    const paint = (view: MailServerView): void => {
      const fact = (key: string, value: string): void => { const cell = root.querySelector<HTMLElement>('[data-whm-mail-server-fact="' + key + '"]'); if (cell) cell.textContent = value }
      const source = (state: string): string => state === 'read' ? t(msgctxt('whm-mail-server-client', 'Read')) : state === 'rendered' ? t('Rendered') : t('Unavailable')
      for (const key of ['postfix', 'master', 'dovecot', 'desired'] as const) fact(key, source(view.sources[key]))
      fact('observed-at', view.observedAt === null ? t('Not read') : formatMailDateTime(view.observedAt))
      const rendered = (value: string | null): string | Node => shown(value, view.sources.desired === 'rendered' ? t('Not managed by xPanel') : t('Unavailable'))
      const unread = t('Not read')
      fill(body('settings'), view.settings.map(item => ({ state: item.state, cells: [item.source === 'postfix' ? 'Postfix main.cf' : 'Dovecot', technical(item.key),
        shown(item.observed, view.sources[item.source] !== 'read' ? unread : item.source === 'postfix' ? t('Not set in main.cf') : t('Not returned by doveconf')), rendered(item.desired)] })),
      5, t('No settings are listed.'))
      fill(body('services'), view.services.flatMap(item => [
        { state: item.state, cells: [technical(item.service), t('Service columns'), shown(item.observed, view.sources.master !== 'read' ? unread : t('Not present in master.cf')), rendered(item.desired)] },
        ...item.options.map(option => ({ state: option.state, cells: ['', technical('-o ' + option.key), shown(option.observed, view.sources.master !== 'read' ? unread : t(msgctxt('whm-mail-server-client', 'Not set'))), rendered(option.desired)] })),
        ...(item.otherOptions ? [{ cells: ['', t('Other overrides (not shown)'), technical(String(item.otherOptions)), '', ''] }] : []),
      ]), 5, view.sources.master === 'read' ? t('No matching services are configured.') : t('Services were not read.'))
      fill(body('domains'), view.domains.map(item => ({ cells: [technical(item.domain), item.account === null ? t(msgctxt('whm-mail-server-client', 'Unassigned')) : technical(item.account), String(item.mailboxes),
        item.zone === null ? t('No saved zone') : technical(item.zone), item.mx.length ? technical(item.mx.map(mx => (mx.priority ?? '-') + ' ' + mx.host).join(', ')) : t('None saved'), expectations[item.state]!] })),
      6, t('No domains are saved.'))
      const truncated = root.querySelector<HTMLElement>('[data-whm-mail-server-truncated]')
      if (truncated) truncated.hidden = !view.truncated
      const relevant = (page === 'server' ? ['postfix', 'master', 'dovecot'] : page === 'routing' ? ['postfix'] : ['postfix', 'master']) as ('postfix' | 'master' | 'dovecot')[]
      const drift = view.settings.filter(item => item.state === 'drift').length + view.services.reduce((sum, item) => sum + (item.state === 'drift' ? 1 : 0) + item.options.filter(option => option.state === 'drift').length, 0)
      if (view.host !== 'connected') note('unavailable', view.host === 'not-connected' ? t('No protected host agent is connected. Rendered and saved values are shown without a host observation.')
        : t('The host observation could not be verified. Rendered and saved values are shown without it.'))
      else if (relevant.some(key => view.sources[key] !== 'read')) note('partial', t('Some configuration sources could not be read. Their values are shown as not read.'))
      else if (drift) note('drift', t('{n} values differ from the configuration xPanel renders. Use the reviewed repair workflow.', { n: drift }))
      else note('read', view.sources.desired === 'rendered' ? t('Configuration read from the host. No drift was found in managed values.') : t('Configuration read from the host. The rendered configuration is unavailable, so drift was not checked.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true'); note('reading', t('Reading the mail server configuration…'))
      try {
        const view = readMailServerView(await request!('GET', '/api/server/mail-server/' + page), page)
        if (admitted()) paint(view)
      } catch { if (admitted()) note('failed', t('The configuration could not be read. Any rows shown are from the last successful read.')) }
      finally { busy = false; refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false') }
    }
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('The mail server configuration is unavailable here. Nothing was read.')); return }
    void load()
  })
}

export const WHM_MAIL_SERVER_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readMailServerView=${readMailServerView.toString()};return ${bindWhmMailServer.toString()};})()`
