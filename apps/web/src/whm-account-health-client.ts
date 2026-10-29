/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export type HealthStateView = 'ok' | 'problem' | 'unavailable'
export type HealthItemView = { name: string; state: HealthStateView; reason: string; evidence: string }
export type HealthCheckView = { id: string; state: HealthStateView; reason: string; evidence: string; items?: HealthItemView[]; omitted?: number }
export type AccountHealthView = { username: string; primaryDomain: string; status: 'active' | 'suspended' | 'terminating'; problems: number; unavailable: number; checks: HealthCheckView[] }
export type AccountHealthReportView = { observedAt: string; host: 'read' | 'unavailable'; accounts: AccountHealthView[]; pending: string[]; truncated: boolean }

/** Strict contract: every reason belongs to its check and implies its state; a domain check's state is its worst item. */
export function readAccountHealthReport(value: unknown, requested?: readonly string[]): AccountHealthReportView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max && item.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(item)
  const count = (item: unknown, max: number): item is number => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= max
  const username = /^[a-z][a-z0-9]{0,15}$/, host = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/
  const CHECKS: Record<string, Record<string, HealthStateView>> = {
    status: { active: 'ok', suspended: 'problem', terminating: 'problem' },
    plan: { plan_ok: 'ok', plan_missing: 'problem', feature_list_missing: 'problem' },
    disk: { within_quota: 'ok', unlimited_plan: 'ok', over_quota: 'problem', quota_mismatch: 'problem', quota_unread: 'unavailable', host_unavailable: 'unavailable', plan_missing: 'unavailable' },
    'system-user': { user_ok: 'ok', user_missing: 'problem', user_mismatch: 'problem', user_unread: 'unavailable', host_unavailable: 'unavailable' },
    home: { home_ok: 'ok', home_missing: 'problem', home_not_directory: 'problem', home_wrong_owner: 'problem', home_world_writable: 'problem', home_unread: 'unavailable', host_unavailable: 'unavailable' },
    mailboxes: { within_limit: 'ok', over_limit: 'problem', plan_missing: 'unavailable' },
    certificates: { domains_ok: 'ok', domains_problem: 'problem', domains_unavailable: 'unavailable', no_domains: 'unavailable' },
    dns: { domains_ok: 'ok', domains_problem: 'problem', domains_unavailable: 'unavailable', no_domains: 'unavailable' },
    php: { domains_ok: 'ok', domains_problem: 'problem', domains_unavailable: 'unavailable', no_php_sites: 'ok' },
  }
  const ITEMS: Record<string, Record<string, HealthStateView>> = {
    certificates: { cert_valid: 'ok', cert_missing: 'problem', cert_not_covering: 'problem', cert_expired: 'problem', cert_expiring: 'problem', cert_unread: 'unavailable' },
    dns: { zone_present: 'ok', zone_missing: 'problem' },
    php: { php_ok: 'ok', php_unsupported_version: 'problem', php_handler_unavailable: 'problem', php_engine_unread: 'unavailable' },
  }
  const rank: Record<string, number> = { problem: 0, unavailable: 1, ok: 2 }
  if (!object(value) || typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))
    || (value.host !== 'read' && value.host !== 'unavailable') || !Array.isArray(value.accounts) || value.accounts.length > 50 || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.pending) || value.pending.length > 5000 || new Set(value.pending).size !== value.pending.length || !value.pending.every(name => typeof name === 'string' && username.test(name))) throw new Error('invalid_account_health_report')
  const seen = new Set<string>()
  const accounts = value.accounts.map(raw => {
    if (!object(raw) || typeof raw.username !== 'string' || !username.test(raw.username) || seen.has(raw.username) || requested && !requested.includes(raw.username)
      || typeof raw.primaryDomain !== 'string' || !host.test(raw.primaryDomain) || !['active', 'suspended', 'terminating'].includes(String(raw.status)) || !Array.isArray(raw.checks)) throw new Error('invalid_account_health')
    seen.add(raw.username)
    const ids = new Set<string>()
    const checks = raw.checks.map(check => {
      if (!object(check) || typeof check.id !== 'string' || !Object.hasOwn(CHECKS, check.id) || ids.has(check.id) || typeof check.reason !== 'string' || !Object.hasOwn(CHECKS[check.id]!, check.reason)
        || CHECKS[check.id]![check.reason] !== check.state || !text(check.evidence, 512)) throw new Error('invalid_account_health_check')
      ids.add(check.id)
      const view: HealthCheckView = { id: check.id, state: check.state as HealthStateView, reason: check.reason, evidence: check.evidence }
      const reasons = ITEMS[check.id]
      if (!reasons) { if (check.items !== undefined || check.omitted !== undefined) throw new Error('invalid_account_health_check'); return view }
      if (!Array.isArray(check.items) || check.items.length > 25 || !count(check.omitted, 100000) || (check.omitted > 0 && check.items.length !== 25)) throw new Error('invalid_account_health_check')
      const items = check.items.map(entry => {
        if (!object(entry) || typeof entry.name !== 'string' || !host.test(entry.name) || typeof entry.reason !== 'string' || !Object.hasOwn(reasons, entry.reason) || reasons[entry.reason] !== entry.state || !text(entry.evidence, 256)) throw new Error('invalid_account_health_item')
        return { name: entry.name, state: entry.state as HealthStateView, reason: entry.reason, evidence: entry.evidence }
      })
      const worst = items.reduce<HealthStateView | null>((current, entry) => current === null || rank[entry.state]! < rank[current]! ? entry.state : current, null)
      if (items.length ? worst !== view.state || !view.reason.startsWith('domains_') : view.reason.startsWith('domains_') || check.omitted !== 0) throw new Error('invalid_account_health_check')
      return { ...view, items, omitted: check.omitted }
    })
    if (ids.size !== Object.keys(CHECKS).length || raw.problems !== checks.filter(check => check.state === 'problem').length || raw.unavailable !== checks.filter(check => check.state === 'unavailable').length) throw new Error('invalid_account_health')
    return { username: raw.username, primaryDomain: raw.primaryDomain, status: raw.status as AccountHealthView['status'], problems: raw.problems as number, unavailable: raw.unavailable as number, checks }
  })
  return { observedAt: value.observedAt, host: value.host, accounts, pending: value.pending as string[], truncated: value.truncated }
}

function bindWhmAccountHealth(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-health-workspace]').forEach(root => {
    if (root.dataset.healthBound === 'true') return
    root.dataset.healthBound = 'true'
    const find = <T extends HTMLElement>(name: string): T | null => root.querySelector<T>('[data-whm-health-' + name + ']')
    const run = find<HTMLButtonElement>('run'), status = find('status'), list = find('list'), filter = find<HTMLSelectElement>('filter'), search = find<HTMLInputElement>('search')
    const selectAll = find<HTMLInputElement>('select-all'), recheck = find<HTMLButtonElement>('recheck'), selection = find('selection')
    if (!run || !status || !list || !filter || !search || !selectAll || !recheck || !selection) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.healthCanRead === 'true' && !root.closest(denied)
    const isRoot = root.dataset.healthRoot === 'true'
    const rows = new Map<string, AccountHealthView>()
    let busy = false, observedAt = '', hostUnread = false, truncated = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const TITLES: Record<string, string> = {
      status: msgid('Account status'), plan: msgid('Plan assignment'), disk: msgid('Disk usage and quota'),
      'system-user': msgid('System user'), home: msgid('Home directory'), mailboxes: msgid('Mailboxes'),
      certificates: msgid('Certificates'), dns: msgid('DNS zones'), php: msgid('PHP version and handler'),
    }
    const CAUSES: Record<string, string> = {
      active: msgid('The account is active.'),
      suspended: msgid('The account is suspended, so its sites and mail are offline.'),
      terminating: msgid('The account is being removed.'),
      plan_ok: msgid('The assigned plan and its feature list exist.'),
      plan_missing: msgid('The assigned plan no longer exists, so limits and features cannot be applied.'),
      feature_list_missing: msgid('The plan points to a feature list that no longer exists.'),
      within_quota: msgid('Disk usage is below the plan quota, and the server enforces that quota.'),
      unlimited_plan: msgid('The plan has no disk quota, and none is set on the server.'),
      over_quota: msgid('Disk usage has reached the plan quota, so new files can fail to save.'),
      quota_mismatch: msgid('The disk quota on the server does not match the plan.'),
      quota_unread: msgid('The disk quota report could not be read for this account.'),
      host_unavailable: msgid('This server could not be observed, so this check was not run.'),
      user_ok: msgid('The system user exists with the saved user ID, group and home.'),
      user_missing: msgid('The system user does not exist, so the account cannot run its processes in isolation.'),
      user_mismatch: msgid('The system user differs from the saved user ID, group or home.'),
      user_unread: msgid('The system user could not be read.'),
      home_ok: msgid('The home directory exists, belongs to the account and is not writable by others.'),
      home_missing: msgid('The home directory does not exist.'),
      home_not_directory: msgid('The home path is not a real directory.'),
      home_wrong_owner: msgid('The home directory belongs to another user.'),
      home_world_writable: msgid('Any user on the server can write to the home directory.'),
      home_unread: msgid('The home directory could not be read.'),
      within_limit: msgid('The mailbox count is within the plan limit.'),
      over_limit: msgid('The account has more mailboxes than its plan allows.'),
      domains_ok: msgid('Every domain passed this check.'),
      domains_problem: msgid('At least one domain has a problem.'),
      domains_unavailable: msgid('No problem was found, but at least one domain could not be verified.'),
      no_domains: msgid('No domains are saved for this account.'),
      no_php_sites: msgid('No domain of this account runs PHP.'),
      cert_valid: msgid('A covering certificate is valid for more than 14 days.'),
      cert_missing: msgid('No certificate is assigned, so visitors get a security warning over HTTPS.'),
      cert_not_covering: msgid('The assigned certificate does not cover this name.'),
      cert_expired: msgid('The certificate has expired.'),
      cert_expiring: msgid('The certificate expires within 14 days and has not been replaced.'),
      cert_unread: msgid('The certificate expiry date could not be read.'),
      zone_present: msgid('A saved DNS zone covers this name.'),
      zone_missing: msgid('No saved DNS zone covers this name, so it may not resolve.'),
      php_ok: msgid('The PHP version is supported and the handler works with the web server.'),
      php_unsupported_version: msgid('This PHP version is not supported on this server.'),
      php_handler_unavailable: msgid('The PHP handler cannot run with the saved web server engine.'),
      php_engine_unread: msgid('The web server settings are not saved, so the handler could not be checked.'),
    }
    const FIXES: Record<string, [string, string, boolean]> = {
      suspended: ['/whm/accounts', msgid('Review the suspension in Accounts'), false],
      terminating: ['/whm/accounts', msgid('Open Accounts'), false],
      plan_missing: ['/whm/plans', msgid('Assign or restore a plan'), false],
      feature_list_missing: ['/whm/plans/features', msgid('Review feature lists'), false],
      over_quota: ['/whm/plans', msgid('Review the plan quota'), false],
      quota_mismatch: ['/whm/monitoring/repair', msgid('Check configuration drift in the repair center'), true],
      user_missing: ['/whm/monitoring/repair', msgid('Check configuration drift in the repair center'), true],
      user_mismatch: ['/whm/monitoring/repair', msgid('Check configuration drift in the repair center'), true],
      home_missing: ['/whm/monitoring/repair', msgid('Check configuration drift in the repair center'), true],
      home_not_directory: ['/whm/monitoring/repair', msgid('Check configuration drift in the repair center'), true],
      home_wrong_owner: ['/whm/monitoring/repair', msgid('Check configuration drift in the repair center'), true],
      home_world_writable: ['/whm/monitoring/repair', msgid('Check configuration drift in the repair center'), true],
      over_limit: ['/whm/plans', msgid('Review the plan mailbox limit'), false],
      certificates: ['/whm/ssl', msgid('Manage certificates'), false],
      dns: ['/whm/dns', msgid('Manage DNS zones'), false],
      php: ['/whm/software/php', msgid('Review PHP versions and handlers'), true],
    }
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node }
    const technical = (value: string): HTMLElement => { const node = element('bdi', value); node.dir = 'ltr'; return node }
    const cause = (reason: string): string => { const known = CAUSES[reason]; return known ? t(known) : reason }
    const badge = (state: string, label?: string): HTMLElement => element('span', label ?? (state === 'ok' ? t('No problem found') : state === 'problem' ? t('Problem found') : t('Not verified')), 'xp-badge ' + (state === 'ok' ? 'xp-badge--ok' : state === 'problem' ? 'xp-badge--critical' : 'xp-badge--warn'))
    const evidence = (value: string): HTMLElement => { const details = element('details'), pre = element('pre', value, 'xp-whm-health__evidence'); pre.dir = 'ltr'; pre.tabIndex = 0; details.append(element('summary', t('Evidence')), pre); return details }
    const picks = (): HTMLInputElement[] => [...list.querySelectorAll<HTMLInputElement>('[data-whm-health-pick]')]
    const selected = (): string[] => picks().filter(input => input.checked && !input.closest<HTMLElement>('[data-whm-health-account]')?.hidden).map(input => input.value)
    const lock = (): void => {
      const open = admitted()
      run.disabled = busy || !open; filter.disabled = !open; search.disabled = !open; selectAll.disabled = busy || !open || !rows.size
      picks().forEach(input => { input.disabled = busy || !open })
      const chosen = selected().length
      recheck.disabled = busy || !open || !chosen
      selection.textContent = chosen ? t('{count} selected', { count: chosen }) : t('No accounts selected.')
      root.setAttribute('aria-busy', String(busy))
    }
    const applyFilter = (): void => {
      const wanted = filter.value, needle = search.value.trim().toLowerCase()
      let shown = 0
      list.querySelectorAll<HTMLElement>('[data-whm-health-account]').forEach(row => {
        const match = (wanted === 'all' || row.dataset.state === wanted) && (!needle || (row.dataset.search ?? '').includes(needle))
        row.hidden = !match; if (match) shown++
      })
      const empty = list.querySelector<HTMLElement>('[data-whm-health-empty]')
      if (empty) { empty.hidden = rows.size > 0 && shown > 0; empty.textContent = rows.size ? t('No checked account matches this filter.') : t('No accounts have been checked.') }
      lock()
    }
    const paintSummary = (): void => {
      const all = [...rows.values()]
      const set = (name: string, value: string): void => { const node = find(name); if (node) node.textContent = value }
      set('count-accounts', String(all.length)); set('count-affected', String(all.filter(entry => entry.problems > 0).length))
      set('count-problems', String(all.reduce((sum, entry) => sum + entry.problems, 0))); set('count-unavailable', String(all.reduce((sum, entry) => sum + entry.unavailable, 0)))
      set('observed-at', observedAt ? formatDisplayDateTime(observedAt) : t('Not read'))
    }
    const renderRow = (account: AccountHealthView, checked: boolean): HTMLElement => {
      const row = element('article', undefined, 'xp-whm-health__account')
      row.dataset.whmHealthAccount = account.username
      row.dataset.state = account.problems ? 'problem' : account.unavailable ? 'unavailable' : 'ok'
      row.dataset.search = (account.username + ' ' + account.primaryDomain + ' ' + account.checks.flatMap(check => (check.items ?? []).map(entry => entry.name)).join(' ')).toLowerCase()
      const pick = element('input'); pick.type = 'checkbox'; pick.value = account.username; pick.checked = checked; pick.dataset.whmHealthPick = ''
      pick.setAttribute('aria-label', t('Select {name}', { name: account.username })); pick.addEventListener('change', lock)
      const holder = element('div', undefined, 'xp-whm-health__pick'); holder.append(pick)
      const details = element('details'), summary = element('summary'), headline = element('span', undefined, 'xp-whm-health__headline')
      const statusText = account.status === 'active' ? t('Active') : account.status === 'suspended' ? t(msgctxt('whm-account-health-client', 'Suspended')) : t('Being removed')
      headline.append(technical(account.username), technical(account.primaryDomain), element('span', statusText),
        account.problems ? badge('problem', t('{count} problems', { count: account.problems })) : account.unavailable ? badge('unavailable', t('{count} not verified', { count: account.unavailable })) : badge('ok', t('No problems found')))
      summary.append(headline); details.append(summary)
      const checks = element('ul', undefined, 'xp-whm-health__checks')
      for (const check of account.checks) {
        const card = element('li', undefined, 'xp-whm-health__check'), head = element('div', undefined, 'xp-whm-health__check-head'), title = TITLES[check.id]
        card.dataset.whmHealthCheck = check.id; card.dataset.state = check.state
        head.append(element('h4', title ? t(title) : check.id), badge(check.state)); card.append(head, element('p', cause(check.reason)))
        const fix = check.state === 'problem' ? FIXES[check.reason] ?? FIXES[check.id] : undefined
        if (fix && (isRoot || !fix[2])) { const link = element('a', t(fix[1]), 'xp-btn'); link.href = fix[0]; link.dataset.whmHealthFix = check.id; const actions = element('div', undefined, 'xp-whm-detail-actions'); actions.append(link); card.append(actions) }
        else if (fix) card.append(element('p', t('Ask the server administrator to repair this.'), 'xp-help'))
        if (check.evidence) card.append(evidence(check.evidence))
        if (check.items?.length) {
          const items = element('ul', undefined, 'xp-whm-health__items')
          for (const entry of check.items) {
            const line = element('li'), label = element('div', undefined, 'xp-whm-health__check-head')
            line.dataset.state = entry.state; label.append(technical(entry.name), badge(entry.state)); line.append(label, element('p', cause(entry.reason)))
            if (entry.evidence) line.append(evidence(entry.evidence))
            items.append(line)
          }
          card.append(items)
          if (check.omitted) card.append(element('p', t('{count} more domains are not listed. The worst results are shown first.', { count: check.omitted }), 'xp-help'))
        }
        checks.append(card)
      }
      details.append(checks); row.append(holder, details)
      return row
    }
    const paintRows = (accounts: readonly AccountHealthView[]): void => {
      const checked = new Set(selected())
      for (const account of accounts) {
        rows.set(account.username, account)
        const next = renderRow(account, checked.has(account.username)), current = list.querySelector<HTMLElement>('[data-whm-health-account="' + account.username + '"]')
        if (current) current.replaceWith(next); else list.append(next)
      }
      paintSummary(); applyFilter()
    }
    const outcome = (): void => {
      const all = [...rows.values()], problems = all.some(entry => entry.problems > 0), unknown = all.some(entry => entry.unavailable > 0)
      const extra = (hostUnread ? ' ' + t('This server could not be observed, so disk, system user and home checks were not run.') : '')
        + (truncated ? ' ' + t('Only the first 5050 accounts were checked.') : '')
      if (!all.length) note('read', t('There are no accounts to check.'))
      else note(problems ? 'problem' : unknown ? 'partial' : 'read', (problems ? t('Checks found problems. Open an account to see each problem and the page that fixes it.') : unknown ? t('No problem was found, but some checks could not be verified.') : t('No problems were found.')) + extra)
    }
    const read = async (names?: readonly string[]): Promise<AccountHealthReportView> => {
      const query = names ? '?' + names.map(name => 'username=' + encodeURIComponent(name)).join('&') : ''
      const value = readAccountHealthReport(await transport!('GET', '/api/accounts/health' + query), names)
      observedAt = value.observedAt; if (value.host === 'unavailable' && value.accounts.length) hostUnread = true
      return value
    }
    const failed = (): void => note('failed', rows.size ? t('Some checks could not be read. The results shown are from earlier reads. Nothing was changed.') : t('Checks could not be read. Nothing was changed.'))
    const runAll = async (): Promise<void> => {
      if (busy || !admitted() || !transport) return
      busy = true; hostUnread = false; lock(); note('reading', t('Running read-only checks…'))
      try {
        const first = await read()
        if (!admitted()) throw new Error('not_admitted')
        rows.clear(); list.querySelectorAll('[data-whm-health-account]').forEach(row => row.remove()); truncated = first.truncated
        paintRows(first.accounts)
        for (let index = 0; index < first.pending.length && admitted(); index += 50) {
          note('reading', t('Checked {done} of {total} accounts…', { done: rows.size, total: first.accounts.length + first.pending.length }))
          paintRows((await read(first.pending.slice(index, index + 50))).accounts)
        }
        run.textContent = t('Check again'); outcome()
      } catch { failed() }
      busy = false; lock()
    }
    const recheckSelected = async (): Promise<void> => {
      const names = selected()
      if (busy || !admitted() || !transport || !names.length) return
      busy = true; lock(); note('reading', t('Rechecking the selected accounts…'))
      try {
        for (let index = 0; index < names.length && admitted(); index += 50) {
          const chunk = names.slice(index, index + 50), value = await read(chunk)
          for (const name of chunk) if (!value.accounts.some(entry => entry.username === name)) { rows.delete(name); list.querySelector('[data-whm-health-account="' + name + '"]')?.remove() }
          paintRows(value.accounts)
        }
        outcome()
      } catch { failed() }
      busy = false; lock()
    }
    if (!admitted()) {
      run.disabled = true; filter.disabled = true; search.disabled = true; selectAll.disabled = true; recheck.disabled = true
      note('unavailable', t('Account health is unavailable here. Nothing was read or changed.'))
      return
    }
    run.addEventListener('click', () => { void runAll() })
    recheck.addEventListener('click', () => { if (!recheck.disabled) void recheckSelected() })
    filter.addEventListener('change', applyFilter); search.addEventListener('input', applyFilter)
    selectAll.addEventListener('change', () => { picks().forEach(input => { if (!input.closest<HTMLElement>('[data-whm-health-account]')?.hidden) input.checked = selectAll.checked }); lock() })
    lock()
  })
}

export const WHM_ACCOUNT_HEALTH_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readAccountHealthReport=${readAccountHealthReport.toString()};return ${bindWhmAccountHealth.toString()};})()`
