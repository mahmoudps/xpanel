import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'

const formatMailDateTime = formatDisplayDateTime

export type MailQualityStateView = 'ok' | 'problem' | 'unavailable'
export type MailQualityCheckView = { state: MailQualityStateView; cause: string; fix: '/whm/dns' | '/whm/email/server' | null; detail: Record<string, unknown> }
export type MailQualityListView = { hostname: string | null; helo: string | null; addresses: { address: string; version: 4 | 6; public: boolean }[]; domains: { domain: string; account: string | null; mailboxes: number; zone: string | null }[]; truncated: boolean; maxCheck: number }
export type MailQualityResultView = { domain: string; mx: MailQualityCheckView; spf: MailQualityCheckView; dkim: MailQualityCheckView; dmarc: MailQualityCheckView; ptr: MailQualityCheckView }
export type MailQualityRunView = { checkedAt: string; timedOut: boolean; results: MailQualityResultView[] }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Strict reader for GET /api/server/mail-quality; unknown fields are dropped. */
export function readMailQualityList(value: unknown): MailQualityListView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const name = (item: unknown): item is string => typeof item === 'string' && /^[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9])?$/.test(item)
  const nullable = (item: unknown, test: (raw: unknown) => boolean): boolean => item === null || test(item)
  const bad = (): never => { throw new Error('invalid_mail_quality_list') }
  if (!object(value) || !nullable(value.hostname, name) || !nullable(value.helo, name) || !Array.isArray(value.addresses) || value.addresses.length > 2 || !Array.isArray(value.domains) || value.domains.length > 2000
    || typeof value.truncated !== 'boolean' || value.maxCheck !== 50) return bad()
  const addresses = value.addresses.map(raw => object(raw) && typeof raw.address === 'string' && raw.address.length <= 45 && /^[0-9a-f.:]+$/i.test(raw.address) && (raw.version === 4 || raw.version === 6) && typeof raw.public === 'boolean'
    ? { address: raw.address, version: raw.version as 4 | 6, public: raw.public } : bad())
  const seen = new Set<string>()
  const domains = value.domains.map(raw => {
    if (!object(raw) || !name(raw.domain) || seen.has(raw.domain) || !nullable(raw.account, item => typeof item === 'string' && item.length <= 64) || !Number.isSafeInteger(raw.mailboxes) || (raw.mailboxes as number) < 1 || !nullable(raw.zone, name)) return bad()
    seen.add(raw.domain)
    return { domain: raw.domain, account: raw.account as string | null, mailboxes: raw.mailboxes as number, zone: raw.zone as string | null }
  })
  return { hostname: value.hostname as string | null, helo: value.helo as string | null, addresses, domains, truncated: value.truncated, maxCheck: 50 }
}

/** Strict reader for POST /api/server/mail-quality/check: one result per requested domain, in order; an ok check never carries a cause or a fix. */
export function readMailQualityResults(value: unknown, requested: string[]): MailQualityRunView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mail_quality_results') }
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  const host = (item: unknown): item is string => text(item, 255)
  const address = (item: unknown): item is string => typeof item === 'string' && item.length <= 45 && /^[0-9a-f.:]+$/i.test(item)
  const list = (item: unknown, max: number, test: (raw: unknown) => boolean): boolean => Array.isArray(item) && item.length <= max && item.every(test)
  const mx = (item: unknown): boolean => object(item) && (item.priority === null || Number.isSafeInteger(item.priority)) && host(item.host)
  const common = ['ok', 'lookup_failed', 'lookup_timeout']
  const causes: Record<string, string[]> = {
    mx: [...common, 'mx_missing', 'mx_null', 'mx_differs_saved', 'mx_not_this_server', 'mx_target_unverified'],
    spf: [...common, 'spf_missing', 'spf_multiple', 'spf_invalid', 'spf_too_many_lookups', 'spf_not_authorized', 'spf_not_decidable', 'no_server_address', 'address_not_public'],
    dkim: [...common, 'dkim_key_unknown', 'dkim_missing', 'dkim_multiple', 'dkim_invalid', 'dkim_revoked', 'dkim_mismatch'],
    dmarc: [...common, 'dmarc_missing', 'dmarc_multiple', 'dmarc_invalid'],
    ptr: [...common, 'hostname_unknown', 'no_server_address', 'address_not_public', 'ptr_missing', 'ptr_not_confirmed', 'ptr_hostname_mismatch'],
  }
  const details: Record<string, (detail: Record<string, unknown>) => boolean> = {
    mx: detail => list(detail.published, 32, mx) && list(detail.saved, 20, mx) && (detail.hostname === null || host(detail.hostname)) && [true, false, null].includes(detail.pointsHere as boolean | null),
    spf: detail => (detail.record === null || text(detail.record, 512)) && Number.isSafeInteger(detail.records) && list(detail.addresses, 2, raw => object(raw) && address(raw.address) && ['pass', 'fail', 'softfail', 'neutral', 'permerror', 'temperror', 'undecided'].includes(String(raw.result))),
    dkim: detail => (detail.selector === null || text(detail.selector, 63)) && [null, 'signing-key', 'saved-zone'].includes(detail.source as string | null) && Number.isSafeInteger(detail.records),
    dmarc: detail => (detail.record === null || text(detail.record, 512)) && [null, 'none', 'quarantine', 'reject'].includes(detail.policy as string | null) && !(detail.policy !== null && detail.record === null),
    ptr: detail => (detail.expected === null || host(detail.expected)) && list(detail.addresses, 2, raw => object(raw) && address(raw.address) && list(raw.names, 16, host) && list(raw.confirmed, 16, host)),
  }
  const check = (raw: unknown, key: string): MailQualityCheckView => {
    if (!object(raw) || !['ok', 'problem', 'unavailable'].includes(String(raw.state)) || !causes[key]!.includes(String(raw.cause)) || (raw.state === 'ok') !== (raw.cause === 'ok')
      || ![null, '/whm/dns', '/whm/email/server'].includes(raw.fix as string | null) || raw.state === 'ok' && raw.fix !== null || !object(raw.detail) || !details[key]!(raw.detail)
      || key === 'dmarc' && raw.state === 'ok' && raw.detail.policy === null) return bad()
    return { state: raw.state as MailQualityStateView, cause: raw.cause as string, fix: raw.fix as MailQualityCheckView['fix'], detail: raw.detail }
  }
  if (!object(value) || typeof value.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.checkedAt) || typeof value.timedOut !== 'boolean'
    || !Array.isArray(value.results) || value.results.length !== requested.length) return bad()
  const results = value.results.map((raw, index) => object(raw) && raw.domain === requested[index]
    ? { domain: raw.domain as string, mx: check(raw.mx, 'mx'), spf: check(raw.spf, 'spf'), dkim: check(raw.dkim, 'dkim'), dmarc: check(raw.dmarc, 'dmarc'), ptr: check(raw.ptr, 'ptr') } : bad())
  return { checkedAt: value.checkedAt, timedOut: value.timedOut, results }
}

function bindWhmMailQuality(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-mail-quality-workspace]').forEach(root => {
    if (root.dataset.mailQualityBound === 'true') return
    root.dataset.mailQualityBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-whm-mail-quality-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-mail-quality-refresh]'), run = root.querySelector<HTMLButtonElement>('[data-whm-mail-quality-check]')
    const rows = root.querySelector<HTMLElement>('[data-whm-mail-quality-rows]'), banner = root.querySelector<HTMLElement>('[data-whm-mail-quality-result]'), selectAll = root.querySelector<HTMLInputElement>('[data-whm-mail-quality-select-all]')
    const selectedLabel = root.querySelector<HTMLElement>('[data-whm-mail-quality-selected]'), truncated = root.querySelector<HTMLElement>('[data-whm-mail-quality-truncated]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!status || !refresh || !run || !rows || !banner || !selectAll || !selectedLabel) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.mailQualityCanRead === 'true' && !root.closest(denied) && !!request
    const stateLabels: Record<string, string> = { ok: t('OK'), problem: t('Problem'), unavailable: t('Unavailable') }
    const okText: Record<string, string> = { mx: t('Points to this server.'), spf: t('Authorizes the sending addresses.'), dkim: t('Matches the signing key.'), ptr: t('Forward-confirmed for the HELO host.') }
    const causes: Record<string, string> = {
      lookup_failed: t('The DNS lookup failed or returned an unusable answer.'), lookup_timeout: t('The DNS lookup timed out.'),
      mx_missing: t('No MX record is published.'), mx_null: t('A null MX is published, so the domain refuses mail (RFC 7505).'),
      mx_differs_saved: t('The published MX differs from the saved zone.'), mx_not_this_server: t('The published MX does not point to this server.'),
      mx_target_unverified: t('Could not confirm that the MX host points to this server.'),
      spf_missing: t('No SPF record is published.'), spf_multiple: t('More than one SPF record is published; receivers treat this as an error (RFC 7208).'),
      spf_invalid: t('The SPF record is not valid.'), spf_too_many_lookups: t('The SPF record needs more than 10 DNS lookups (RFC 7208).'),
      spf_not_authorized: t('SPF does not authorize every sending address.'),
      spf_not_decidable: t('SPF uses include chains deeper than one level, ptr, exists or macros, which are not evaluated here.'),
      no_server_address: t('No sending IP address is saved for this server.'), address_not_public: t('The saved sending address is not a public address.'),
      dkim_key_unknown: t('The DKIM signing key is not available, so there is nothing to compare.'), dkim_missing: t('No DKIM key is published for the selector.'),
      dkim_multiple: t('More than one DKIM record is published for the selector.'), dkim_invalid: t('The published DKIM record is not valid.'),
      dkim_revoked: t('The published DKIM key is empty (revoked).'), dkim_mismatch: t('The published DKIM key differs from the signing key.'),
      dmarc_missing: t('No DMARC record is published.'), dmarc_multiple: t('More than one DMARC record is published, so none applies.'),
      dmarc_invalid: t('The DMARC record cannot be parsed or has no valid policy.'),
      hostname_unknown: t('No server hostname is saved.'), ptr_missing: t('The sending address has no reverse DNS (PTR) record.'),
      ptr_not_confirmed: t('The PTR name does not resolve back to the sending address.'), ptr_hostname_mismatch: t('Reverse DNS does not name the HELO host.'),
    }
    const fixes: Record<string, string> = { '/whm/dns': t('Fix in DNS zones'), '/whm/email/server': t('Review mail server') }
    const results: Record<string, MailQualityResultView & { checkedAt: string }> = {}
    const selected = new Set<string>()
    let list: MailQualityListView | null = null, busy = false
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const show = (kind: string, message: string): void => { banner.hidden = false; banner.dataset.outcome = kind; banner.textContent = message; banner.setAttribute('role', kind === 'failed' || kind === 'denied' ? 'alert' : 'status') }
    const fact = (key: string, value: string): void => { const cell = root.querySelector<HTMLElement>('[data-whm-mail-quality-fact="' + key + '"]'); if (cell) cell.textContent = value }
    const checks = ['mx', 'spf', 'dkim', 'dmarc', 'ptr'] as const
    const detailText = (key: string, check: MailQualityCheckView): string => {
      const detail = check.detail
      if (key === 'mx') return (detail.published as { priority: number; host: string }[]).slice(0, 3).map(item => item.priority + ' ' + item.host).join(', ')
      if (key === 'spf' || key === 'dmarc') return (detail.record as string | null) ?? ''
      if (key === 'dkim') return detail.selector ? detail.source === 'signing-key' ? t('{selector} (signing key)', { selector: String(detail.selector) }) : t('{selector} (saved zone)', { selector: String(detail.selector) }) : ''
      return (detail.addresses as { address: string; names: string[] }[]).map(item => item.address + ': ' + (item.names.join(' ') || '-')).join(', ')
    }
    const controls = (): void => {
      const can = admitted() && !busy && !!list
      refresh.disabled = busy || !admitted()
      run.disabled = !can || selected.size === 0
      selectedLabel.textContent = t('Selected: {n}', { n: selected.size })
      root.querySelectorAll<HTMLInputElement>('[data-whm-mail-quality-select]').forEach(box => { box.disabled = !can; box.checked = selected.has(box.dataset.whmMailQualitySelect ?? '') })
      const first = (list?.domains ?? []).slice(0, list?.maxCheck ?? 50)
      selectAll.disabled = !can || first.length === 0
      selectAll.checked = first.length > 0 && first.every(item => selected.has(item.domain))
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      const current = list, listed = (current?.domains ?? []).map(item => results[item.domain]).filter((item): item is MailQualityResultView & { checkedAt: string } => !!item)
      fact('hostname', current ? current.hostname ?? t('Not saved') : t('Not read'))
      fact('helo', current ? current.helo ?? t('Not saved') : t('Not read'))
      fact('addresses', current ? current.addresses.map(item => item.public ? item.address : t('{address} (not public)', { address: item.address })).join(', ') || t('Not saved') : t('Not read'))
      fact('checked', current ? String(listed.length) : t('Not read'))
      fact('problems', current ? String(listed.filter(item => checks.some(key => item[key].state === 'problem')).length) : t('Not read'))
      fact('unavailable', current ? String(listed.filter(item => checks.some(key => item[key].state === 'unavailable')).length) : t('Not read'))
      fact('checked-at', listed.length ? formatMailDateTime(listed.map(item => item.checkedAt).sort().pop()!) : t('Not checked'))
      if (truncated) truncated.hidden = !current?.truncated
      rows.textContent = ''
      for (const item of current?.domains ?? []) {
        const row = document.createElement('tr'), cell = (content: (string | Node)[]): HTMLTableCellElement => { const td = document.createElement('td'); td.append(...content); row.append(td); return td }
        const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.whmMailQualitySelect = item.domain; box.setAttribute('aria-label', t('Select {domain}', { domain: item.domain }))
        cell([box]); cell([technical(item.domain)]); cell([item.account ? technical(item.account) : t('None')])
        const result = results[item.domain]
        for (const key of checks) {
          const check = result?.[key], wrap = document.createElement('div'); wrap.className = 'xp-whm-mail-quality__check'
          const label = document.createElement('strong'); label.dataset.state = check?.state ?? 'unchecked'; label.textContent = check ? stateLabels[check.state]! : t('Not checked'); wrap.append(label)
          if (check) {
            const cause = document.createElement('span')
            if (check.state === 'ok' && key === 'dmarc') { const [before = '', after = ''] = t('Policy: {policy}').split('{policy}'); cause.append(before, technical(String(check.detail.policy)), after) }
            else cause.textContent = check.state === 'ok' ? okText[key]! : causes[check.cause] ?? causes.lookup_failed!
            wrap.append(cause)
            const extra = detailText(key, check); if (extra) wrap.append(technical(extra))
            if (check.fix) { const link = document.createElement('a'); link.href = check.fix; link.textContent = fixes[check.fix]!; wrap.append(link) }
          }
          cell([wrap]).dataset.check = key
        }
        cell([result ? technical(formatMailDateTime(result.checkedAt)) : t('Not checked')])
        rows.append(row)
      }
      if (!current?.domains.length) {
        const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 9
        td.textContent = current ? t('No hosted mail domains. A domain is listed once it has a mailbox.') : t('No domains have been read.')
        row.append(td); rows.append(row)
      }
      controls()
    }
    const failure = (error: unknown): string => {
      const problem = error && typeof error === 'object' ? error as { status?: number } : {}
      return problem.status === 401 || problem.status === 403 ? 'denied' : 'failed'
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); note('reading', t('Reading hosted mail domains…'))
      try {
        const next = readMailQualityList(await request!('GET', '/api/server/mail-quality'))
        if (!admitted()) return
        list = next
        for (const domain of [...selected]) if (!next.domains.some(item => item.domain === domain)) selected.delete(domain)
        note(next.domains.length ? 'read' : 'empty', next.domains.length ? t('Hosted mail domains read. Select domains and run a check.') : t('There are no hosted mail domains to check.'))
      } catch (error) {
        if (admitted()) note('failed', failure(error) === 'denied' ? t('Authorization is no longer valid. Nothing was read.') : t('Hosted mail domains could not be read. Any rows shown are from the last successful read.'))
      } finally { busy = false; paint() }
    }
    const check = async (): Promise<void> => {
      if (busy || !admitted() || !list) return
      const domains = list.domains.map(item => item.domain).filter(domain => selected.has(domain))
      if (!domains.length) return
      if (domains.length > list.maxCheck) { show('refused', t('Select at most 50 domains for one check. Nothing was looked up.')); return }
      busy = true; controls(); show('reading', t('Checking live DNS…'))
      try {
        const next = readMailQualityResults(await request!('POST', '/api/server/mail-quality/check', { domains }), domains)
        if (!admitted()) return
        for (const item of next.results) results[item.domain] = { ...item, checkedAt: next.checkedAt }
        const problems = next.results.filter(item => checks.some(key => item[key].state === 'problem')).length, unavailable = next.results.filter(item => checks.some(key => item[key].state === 'unavailable')).length
        show(problems ? 'problem' : unavailable ? 'unavailable' : 'ok', t('Checked {n} domains: {problems} with problems, {unavailable} with unavailable checks. Nothing was changed.', { n: next.results.length, problems, unavailable })
          + (next.timedOut ? ' ' + t('The check reached its time limit; unfinished lookups are reported as timed out.') : ''))
      } catch (error) {
        if (admitted()) show(failure(error), failure(error) === 'denied' ? t('Authorization is no longer valid. Nothing was checked.') : t('The check could not be completed. Earlier results are kept unchanged.'))
      } finally { busy = false; paint() }
    }
    rows.addEventListener('change', event => {
      const box = event.target as HTMLInputElement, domain = box?.dataset?.whmMailQualitySelect
      if (!domain || busy || !admitted()) return
      if (box.checked) selected.add(domain); else selected.delete(domain)
      controls()
    })
    selectAll.addEventListener('change', () => {
      if (busy || !admitted() || !list) return
      for (const item of list.domains.slice(0, list.maxCheck)) { if (selectAll.checked) selected.add(item.domain); else selected.delete(item.domain) }
      controls()
    })
    run.addEventListener('click', () => { void check() })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { refresh.disabled = true; run.disabled = true; note('unavailable', t('Mail quality checks are unavailable here. Nothing was read or looked up.')); return }
    void load()
  })
}

export const WHM_MAIL_QUALITY_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readMailQualityList=${readMailQualityList.toString()};const readMailQualityResults=${readMailQualityResults.toString()};return ${bindWhmMailQuality.toString()};})()`
