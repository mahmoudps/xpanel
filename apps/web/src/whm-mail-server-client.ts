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
  domains: { domain: string; account: string | null; mailboxes: number; zone: string | null; mx: { priority: number | null; host: string }[]; state: 'mx-saved' | 'mx-missing' | 'zone-missing' | 'no-mailboxes'; mode: 'local' | 'backup' | 'remote' }[]
  truncated: boolean
}
export type MailPolicyChange = { target: 'postfix' | 'master' | 'dovecot' | 'routing' | 'submission'; key: string; before: string | null; after: string | null }
export type MailServerPolicyView = {
  section: 'server' | 'routing'
  saved: boolean
  revision: string
  state: 'not-saved' | 'applied' | 'pending' | 'unavailable'
  host: 'connected' | 'not-connected' | 'unverified'
  policy: { postfix: Record<string, string>; dovecot: Record<string, string>; rbl: string[] | null; certificates: Record<'smtp' | 'submission' | 'imap', string | null> } | { domains: { domain: string; mode: 'backup' | 'remote' }[] }
  certificates: { id: string; names: string[]; notAfter: string }[]
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
    || (value.host === 'connected' ? !iso(value.observedAt) : value.observedAt !== null) || typeof value.truncated !== 'boolean' || value.editable !== true) return bad()
  const sources = value.sources
  if (!['postfix', 'master', 'dovecot'].every(key => ['read', 'unavailable'].includes(String(sources[key]))) || !['rendered', 'unavailable'].includes(String(sources.desired))
    || value.host !== 'connected' && ['postfix', 'master', 'dovecot'].some(key => sources[key] === 'read')) return bad()
  const settings = list(value.settings, 64, raw => ['postfix', 'dovecot'].includes(String(raw.source)) ? { source: raw.source as 'postfix' | 'dovecot', ...compared(raw, 4096) } : bad())
  const services = list(value.services, 64, raw => text(raw.service, 128) && nullable(raw.observed, 256) && nullable(raw.desired, 256) && ['match', 'drift', 'not-managed', 'unknown'].includes(String(raw.state)) && int(raw.otherOptions)
    ? { service: raw.service, observed: raw.observed, desired: raw.desired, state: raw.state as MailServerStateView, options: list(raw.options, 32, option => compared(option, 4096)), otherOptions: raw.otherOptions } : bad())
  const domains = list(value.domains, 2000, raw => text(raw.domain, 253) && nullable(raw.account, 64) && int(raw.mailboxes) && nullable(raw.zone, 253) && ['mx-saved', 'mx-missing', 'zone-missing', 'no-mailboxes'].includes(String(raw.state))
    && ['local', 'backup', 'remote'].includes(String(raw.mode))
    ? { domain: raw.domain, account: raw.account, mailboxes: raw.mailboxes, zone: raw.zone, state: raw.state as MailServerView['domains'][number]['state'], mode: raw.mode as 'local',
      mx: list(raw.mx, 20, mx => (mx.priority === null || int(mx.priority)) && text(mx.host, 255) ? { priority: mx.priority as number | null, host: mx.host } : bad()) } : bad())
  const consistent = (item: MailServerView['domains'][number]): boolean => item.state === 'no-mailboxes' ? item.mailboxes === 0
    : item.mailboxes > 0 && (item.state === 'zone-missing' ? item.zone === null : item.zone !== null && (item.state === 'mx-saved') === (item.mx.length > 0))
  if (!domains.every(consistent) || page !== 'routing' && domains.length || page === 'routing' && services.length) return bad()
  return { page: page as MailServerView['page'], host: value.host as MailServerView['host'], observedAt: value.observedAt as string | null,
    sources: { postfix: sources.postfix as 'read', master: sources.master as 'read', dovecot: sources.dovecot as 'read', desired: sources.desired as 'rendered' }, settings, services, domains, truncated: value.truncated }
}

/** Strict reader for GET /api/server/mailx/server and /routing: setting names and values stay bounded text, nothing else survives. */
export function readMailPolicyView(value: unknown, section: string): MailServerPolicyView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mail_policy_view') }
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item)
  const settings = (item: unknown): Record<string, string> => object(item) && Object.keys(item).length <= 64 && Object.entries(item).every(([key, entry]) => /^[a-z0-9_]{1,64}$/.test(key) && text(entry, 4096))
    ? { ...item } as Record<string, string> : bad()
  const id = (item: unknown): string | null => item === null ? null : text(item, 64) && /^[A-Za-z0-9_-]+$/.test(item) ? item : bad()
  if (!object(value) || value.section !== section || !['server', 'routing'].includes(section) || typeof value.saved !== 'boolean' || !text(value.revision, 64) || !/^[0-9a-f]{64}$/.test(value.revision)
    || !['not-saved', 'applied', 'pending', 'unavailable'].includes(String(value.state)) || !['connected', 'not-connected', 'unverified'].includes(String(value.host)) || !object(value.policy)) return bad()
  const raw = value.policy
  const policy: MailServerPolicyView['policy'] = section === 'routing'
    ? { domains: Array.isArray(raw.domains) && raw.domains.length <= 2000 ? raw.domains.map(row => object(row) && text(row.domain, 253) && ['backup', 'remote'].includes(String(row.mode)) ? { domain: row.domain, mode: row.mode as 'backup' } : bad()) : bad() }
    : object(raw.certificates) && (raw.rbl === null || Array.isArray(raw.rbl) && raw.rbl.length <= 16 && raw.rbl.every(zone => text(zone, 253)))
      ? { postfix: settings(raw.postfix), dovecot: settings(raw.dovecot), rbl: raw.rbl === null ? null : [...raw.rbl as string[]],
        certificates: { smtp: id(raw.certificates.smtp), submission: id(raw.certificates.submission), imap: id(raw.certificates.imap) } } : bad()
  const choices = value.choices === undefined ? [] : object(value.choices) && Array.isArray(value.choices.certificates) && value.choices.certificates.length <= 500
    ? value.choices.certificates.map(cert => object(cert) && id(cert.id) !== null && Array.isArray(cert.names) && cert.names.length <= 20 && cert.names.every(name => text(name, 253)) && iso(cert.notAfter)
      ? { id: cert.id as string, names: [...cert.names as string[]], notAfter: cert.notAfter } : bad()) : bad()
  return { section: section as 'server', saved: value.saved, revision: value.revision, state: value.state as 'applied', host: value.host as 'connected', policy, certificates: choices }
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
    const routeLabels: Record<string, string> = { local: t('Local (deliver here)'), backup: t('Backup MX (relay to the primary)'), remote: t('Remote (deliver to the domain MX)') }
    const manage = (): boolean => admitted() && root.dataset.mailServerCanManage === 'true'
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
      // The route select is the edit control of the routing policy; it changes nothing until the policy is saved.
      const route = (domain: string, mode: string): HTMLSelectElement => {
        const select = document.createElement('select'); select.className = 'xp-input'; select.dataset.mailRoute = domain; select.setAttribute('aria-label', t('Routing for {domain}', { domain }))
        for (const value of ['local', 'backup', 'remote']) { const option = document.createElement('option'); option.value = value; option.textContent = routeLabels[value]!; option.selected = value === mode; select.append(option) }
        select.disabled = true
        return select
      }
      const routing = manage() && page === 'routing'
      fill(body('domains'), view.domains.map(item => ({ cells: [technical(item.domain), item.account === null ? t(msgctxt('whm-mail-server-client', 'Unassigned')) : technical(item.account), String(item.mailboxes),
        item.zone === null ? t('No saved zone') : technical(item.zone), item.mx.length ? technical(item.mx.map(mx => (mx.priority ?? '-') + ' ' + mx.host).join(', ')) : t('None saved'), expectations[item.state]!,
        ...(routing ? [route(item.domain, item.mode)] : [])] })),
      routing ? 7 : 6, t('No domains are saved.'))
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

    // ---- saved server mail policy editor: preview first, then save and apply ----
    const form = root.querySelector<HTMLFormElement>('[data-whm-mail-settings]'), formStatus = root.querySelector<HTMLElement>('[data-whm-mail-settings-status]')
    const previewBox = root.querySelector<HTMLElement>('[data-whm-mail-settings-preview]'), previewButton = root.querySelector<HTMLButtonElement>('[data-whm-mail-settings-preview-button]')
    const saveButton = root.querySelector<HTMLButtonElement>('[data-whm-mail-settings-save]')
    const section = page === 'routing' ? 'routing' : 'server'
    let policyView: MailServerPolicyView | null = null, previewed: string | null = null, saving = false
    const editable = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[data-mail-setting],[data-mail-rbl],[data-mail-rbl-managed],[data-mail-certificate],[data-mail-route]')]
    const formNote = (state: string, message: string): void => { if (formStatus) { formStatus.dataset.state = state; formStatus.textContent = message; formStatus.setAttribute('role', state === 'failed' ? 'alert' : 'status') } }
    const editorControls = (): void => {
      if (!form || !previewButton || !saveButton) return
      const on = manage() && !!policyView && !saving && !busy
      previewButton.disabled = !on; saveButton.disabled = !on || previewed === null
      for (const control of editable()) (control as HTMLInputElement).disabled = !on
    }
    const invalidate = (): void => { previewed = null; if (previewBox) previewBox.hidden = true; editorControls() }
    const fillEditor = (next: MailServerPolicyView): void => {
      policyView = next
      if ('postfix' in next.policy) {
        const policy = next.policy
        for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-mail-setting]')) {
          const values = control.dataset.mailSettingSource === 'dovecot' ? policy.dovecot : policy.postfix
          control.value = values[control.dataset.mailSetting ?? ''] ?? ''
        }
        const managed = root.querySelector<HTMLInputElement>('[data-mail-rbl-managed]'), zones = root.querySelector<HTMLTextAreaElement>('[data-mail-rbl]')
        if (managed) managed.checked = policy.rbl !== null
        if (zones) zones.value = (policy.rbl ?? []).join('\n')
        for (const select of root.querySelectorAll<HTMLSelectElement>('[data-mail-certificate]')) {
          const key = select.dataset.mailCertificate as 'smtp', chosen = policy.certificates[key]
          select.textContent = ''
          const add = (value: string, label: string): void => { const option = document.createElement('option'); option.value = value; option.textContent = label; option.selected = value === (chosen ?? ''); select.append(option) }
          add('', t('Default certificate'))
          for (const cert of next.certificates) add(cert.id, t('{names}, expires {date}', { names: cert.names.join(', '), date: formatMailDateTime(cert.notAfter) }))
          if (chosen !== null && !next.certificates.some(cert => cert.id === chosen)) add(chosen, t('{id} (no longer usable)', { id: chosen }))
        }
      }
      const states: Record<string, string> = { applied: t('The saved policy is applied on this server.'), pending: t('The saved policy is not applied on this server yet.'),
        unavailable: t('The host configuration could not be read.'), 'not-saved': t('xPanel does not manage these settings yet. Saving takes over these settings.') }
      if (next.host !== 'connected') formNote('unavailable', next.host === 'not-connected' ? t('No protected host agent is connected. The saved policy is shown without a host observation.') : t('The host observation could not be verified. The saved policy is shown without it.'))
      else formNote(next.state === 'applied' || next.state === 'not-saved' ? 'read' : 'partial', states[next.state]!)
      invalidate()
    }
    // Starts from the saved policy, so a page edits only its own fields and keeps every other saved value.
    const collect = (): Record<string, unknown> | null => {
      if (!policyView) return null
      if ('domains' in policyView.policy) {
        const shown = new Map([...root.querySelectorAll<HTMLSelectElement>('[data-mail-route]')].map(select => [select.dataset.mailRoute!, select.value]))
        const kept = policyView.policy.domains.filter(row => !shown.has(row.domain))
        return { domains: [...kept, ...[...shown].filter(([, mode]) => mode !== 'local').map(([domain, mode]) => ({ domain, mode }))].sort((a, b) => a.domain.localeCompare(b.domain)) }
      }
      const saved = policyView.policy, postfix = { ...saved.postfix }, dovecot = { ...saved.dovecot }
      for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-mail-setting]')) {
        const key = control.dataset.mailSetting ?? '', target = control.dataset.mailSettingSource === 'dovecot' ? dovecot : postfix
        // Lists are saved in Postfix's canonical ", " form; Dovecot protocols are space separated.
        const raw = control.value.trim(), value = control.dataset.mailSettingList === 'true' ? raw.split(/[\s,]+/).filter(Boolean).join(', ') : key === 'protocols' ? raw.split(/\s+/).filter(Boolean).join(' ') : raw
        if (value === '') delete target[key]; else target[key] = value
      }
      const managed = root.querySelector<HTMLInputElement>('[data-mail-rbl-managed]'), zones = root.querySelector<HTMLTextAreaElement>('[data-mail-rbl]')
      const rbl = !managed ? saved.rbl : managed.checked ? (zones?.value ?? '').split('\n').map(line => line.trim().toLowerCase()).filter(Boolean) : null
      const certificates = { ...saved.certificates }
      for (const select of root.querySelectorAll<HTMLSelectElement>('[data-mail-certificate]')) certificates[select.dataset.mailCertificate as 'smtp'] = select.value || null
      return { postfix, dovecot, rbl, certificates }
    }
    const loadPolicy = async (): Promise<void> => {
      if (!form || !manage()) return
      try { const next = readMailPolicyView(await request!('GET', '/api/server/mailx/' + section), section); if (manage()) fillEditor(next) }
      catch { policyView = null; formNote('failed', t('The mail policy could not be read. Values shown are from the last successful read.')); editorControls() }
    }
    const problem = (error: unknown): string => {
      const raw = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = raw.details && typeof raw.details === 'object' ? raw.details : {}
      const field = typeof details.field === 'string' && /^[a-z0-9_.]{1,80}$/.test(details.field) ? details.field : null
      return details.unknownOutcome === true || details.verificationRequired === true ? t('The save outcome is unknown. Reload and review before retrying.')
        : raw.status === 401 || raw.status === 403 ? t('You are not allowed to change this policy. Nothing was saved.')
          : raw.status === 409 || raw.code === 'CONFLICT' ? t('The policy changed since it was read. Reload and review before saving.')
            : raw.status === 422 || raw.code === 'VALIDATION' ? field ? t('{field} is not valid. Nothing was saved.', { field }) : t('Some values are not valid. Nothing was saved.')
              : t('The request failed. Reload to see what was saved.')
    }
    const showChanges = (changes: MailPolicyChange[]): void => {
      const where: Record<string, string> = { postfix: 'main.cf', master: 'master.cf', dovecot: '99-xpanel-server.conf', routing: t('Routing'), submission: t('Mail clients sending (ports 587 and 465)') }
      const shownValue = (value: string | null, target: string): string | Node => value === null ? t('Not managed by xPanel') : target === 'routing' ? routeLabels[value] ?? technical(value) : technical(value)
      fill(body('changes'), changes.map(change => ({ cells: [where[change.target] ?? change.target, technical(change.key), shownValue(change.before, change.target), shownValue(change.after, change.target)] })), 4, t('No change to save.'))
      if (previewBox) previewBox.hidden = false
    }
    const preview = async (): Promise<void> => {
      const policy = collect()
      if (!policy || !policyView || saving || !manage()) return
      saving = true; editorControls(); formNote('reading', t('Checking the changes…'))
      try {
        const reply = await request!('POST', '/api/server/mailx/' + section + '/preview', { policy, expectedRevision: policyView.revision }) as { changes?: unknown }
        const changes = Array.isArray(reply?.changes) && reply.changes.length <= 4500 ? reply.changes.map(item => {
          const row = item as Record<string, unknown>
          if (!['postfix', 'master', 'dovecot', 'routing', 'submission'].includes(String(row.target)) || typeof row.key !== 'string' || row.key.length > 300
            || ![row.before, row.after].every(value => value === null || typeof value === 'string' && value.length <= 4096)) throw new Error('invalid_preview')
          return { target: row.target, key: row.key, before: row.before, after: row.after } as MailPolicyChange
        }) : (() => { throw new Error('invalid_preview') })()
        showChanges(changes)
        if (changes.length) { previewed = JSON.stringify(policy); formNote('read', t('Review the changes, then save and apply.')) }
        else formNote('read', t('No change to save.'))
      } catch (error) { formNote('failed', problem(error)) }
      finally { saving = false; editorControls() }
    }
    const outcomes: Record<string, string> = {
      applied: t('Saved and applied. Postfix confirmed the change.'), nothing: t('Saved. There was nothing to apply.'), refused: t('Saved, but the host refused to apply it. Check the state above.'),
      'rolled-back': t('Saved, but the new settings failed the configuration check, so the previous settings were restored.'),
      unknown: t('Saved, but the apply outcome is unknown. Review the mail service before retrying.'), 'not-connected': t('Saved. No host agent is connected, so it is not applied yet.'),
    }
    const save = async (): Promise<void> => {
      const policy = collect()
      if (!policy || !policyView || saving || !manage()) return
      if (previewed !== JSON.stringify(policy)) { invalidate(); formNote('partial', t('Preview the changes before saving.')); return }
      saving = true; editorControls(); formNote('saving', t('Saving and applying…'))
      let message = '', state = 'failed'
      try {
        const reply = await request!('PUT', '/api/server/mailx/' + section, { policy, expectedRevision: policyView.revision }) as { application?: { outcome?: string; failedCheck?: string; reconcile?: string } } | null
        const application = reply?.application ?? {}, outcome = String(application.outcome ?? 'unknown')
        const check = application.failedCheck === 'dovecot' ? 'doveconf -n' : application.failedCheck === 'postfix' ? 'postfix check' : null
        message = (outcomes[outcome] ?? outcomes.unknown!) + (outcome === 'rolled-back' && check ? ' ' + t('The failed check was {check}.', { check }) : '')
          + ((outcome === 'applied' || outcome === 'nothing') && application.reconcile === 'failed' ? ' ' + t('The configuration generation that applies the certificate and routing failed and was rolled back. Check the generation history.') : '')
        state = outcome === 'applied' || outcome === 'nothing' ? application.reconcile === 'failed' ? 'partial' : 'saved' : outcome === 'unknown' ? 'failed' : 'partial'
        formNote(state, message)
      } catch (error) { message = problem(error); formNote('failed', message) }
      finally { saving = false; editorControls() }
      await load()
      formNote(state, message)
    }
    form?.addEventListener('input', invalidate); form?.addEventListener('change', invalidate)
    root.addEventListener('change', event => { if ((event.target as HTMLElement | null)?.dataset?.mailRoute !== undefined) invalidate() })
    previewButton?.addEventListener('click', () => { void preview() })
    form?.addEventListener('submit', event => { event.preventDefault(); void save() })

    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; refresh.disabled = true; editorControls(); root.setAttribute('aria-busy', 'true'); note('reading', t('Reading the mail server configuration…'))
      try {
        const view = readMailServerView(await request!('GET', '/api/server/mail-server/' + page), page)
        if (admitted()) paint(view)
      } catch { if (admitted()) note('failed', t('The configuration could not be read. Any rows shown are from the last successful read.')) }
      finally { busy = false; refresh.disabled = !admitted(); root.setAttribute('aria-busy', 'false') }
      await loadPolicy()
      editorControls()
    }
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { refresh.disabled = true; editorControls(); note('unavailable', t('The mail server configuration is unavailable here. Nothing was read.')); return }
    void load()
  })
}

export const WHM_MAIL_SERVER_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readMailServerView=${readMailServerView.toString()};const readMailPolicyView=${readMailPolicyView.toString()};return ${bindWhmMailServer.toString()};})()`
