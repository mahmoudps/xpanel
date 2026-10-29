/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export type AlertBoundView = { unit: 'per-processor' | 'percent' | 'days'; direction: 'above' | 'below'; min: number; max: number; decimals: 0 | 1; default: number }
export type AlertRuleView = { id: string; enabled: boolean; threshold: number | null }
export type AlertHealthView = 'ok' | 'warning' | 'problem' | 'unavailable'
export type AlertResultView = {
  id: string; enabled: boolean; threshold: number | null; state: 'firing' | 'ok' | 'unavailable' | 'disabled'; severity: 'critical' | 'warning' | null
  health: AlertHealthView; value: number | null; matches: string[]; evidence: string; firstFiredAt: string | null
}
export type AlertEvaluationView = { evaluatedAt: string; observedAt: string; host: 'read' | 'unavailable'; rulesRevision: string; quiet: boolean; results: AlertResultView[] }
export type AlertDeliveryLogView = {
  at: string; noticeId: string; kind: 'firing' | 'resolved' | 'test'; ruleId: string | null; channel: 'email' | 'webhook' | null; result: 'sent' | 'failed' | 'gave_up' | 'no_channel'
  attempt: number; error: 'unreachable' | 'timed_out' | 'refused' | 'rejected_status' | 'address_not_public' | 'no_signing_key' | null; status: number | null
}
export type AlertDeliveryView = {
  scheduler: { everyMinutes: number; lastRun: { at: string; result: 'evaluated' | 'host_unavailable' | 'rules_invalid' } | null }; state: 'none' | 'read' | 'invalid'
  channels: { alerts: boolean; email: number; webhook: boolean; active: ('email' | 'webhook')[] }
  pending: { noticeId: string; kind: 'firing' | 'resolved' | 'test'; ruleId: string | null; channel: 'email' | 'webhook'; attempts: number; nextAt: string }[]; log: AlertDeliveryLogView[]
}
export type MonitoringAlertsView = {
  state: 'default' | 'saved' | 'invalid'; rules: AlertRuleView[]; quiet: { start: string; end: string } | null; updatedAt: string | null; updatedBy: string | null
  revision: string; bounds: Record<string, AlertBoundView | null>; delivery: AlertDeliveryView
  evaluationState: 'none' | 'read' | 'invalid'; evaluation: AlertEvaluationView | null
}

/** Strict reader for /api/server/monitoring-alerts views: fixed rule order, thresholds inside the served bounds, and a delivery log of known results only. */
export function readMonitoringAlertsView(value: unknown): MonitoringAlertsView {
  const IDS = ['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'certificates', 'reboot']
  const bad = (): never => { throw new Error('invalid_monitoring_alerts') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const iso = (item: unknown): string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item)) ? item : bad()
  const hex = (item: unknown): string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item) ? item : bad()
  const text = (item: unknown, max: number): string => typeof item === 'string' && item.length <= max && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(item) ? item : bad()
  const oneOf = <T extends string>(item: unknown, allowed: readonly T[]): T => allowed.includes(item as T) ? item as T : bad()
  const finite = (item: unknown): number => typeof item === 'number' && Number.isFinite(item) ? item : bad()
  const list = (item: unknown): unknown[] => Array.isArray(item) && item.length === IDS.length ? item : bad()
  const time = (item: unknown): string => typeof item === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item) ? item : bad()
  if (!object(value) || !object(value.bounds) || Object.keys(value.bounds).length !== IDS.length || !object(value.delivery)) return bad()
  const KINDS = ['firing', 'resolved', 'test'] as const, CHANNELS = ['email', 'webhook'] as const
  const ruleRef = (item: unknown, kind: string): string | null => kind === 'test' ? (item === null ? null : bad()) : IDS.includes(item as string) ? item as string : bad()
  const count = (item: unknown, max: number): number => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= max ? item as number : bad()
  const notice = (item: unknown): string => typeof item === 'string' && /^aln_[0-9a-f]{24}$/.test(item) ? item : bad()
  const rawDelivery = value.delivery, scheduler = object(rawDelivery.scheduler) ? rawDelivery.scheduler : bad(), channels = object(rawDelivery.channels) ? rawDelivery.channels : bad()
  const delivery: AlertDeliveryView = {
    scheduler: { everyMinutes: count(scheduler.everyMinutes, 1440) || bad(), lastRun: scheduler.lastRun === null ? null : object(scheduler.lastRun)
      ? { at: iso(scheduler.lastRun.at), result: oneOf(scheduler.lastRun.result, ['evaluated', 'host_unavailable', 'rules_invalid'] as const) } : bad() },
    state: oneOf(rawDelivery.state, ['none', 'read', 'invalid'] as const),
    channels: { alerts: typeof channels.alerts === 'boolean' ? channels.alerts : bad(), email: count(channels.email, 10), webhook: typeof channels.webhook === 'boolean' ? channels.webhook : bad(),
      active: Array.isArray(channels.active) && channels.active.length <= 2 ? channels.active.map(item => oneOf(item, CHANNELS)) : bad() },
    pending: Array.isArray(rawDelivery.pending) && rawDelivery.pending.length <= 50 ? rawDelivery.pending.map(item => {
      if (!object(item)) return bad()
      const kind = oneOf(item.kind, KINDS)
      return { noticeId: notice(item.noticeId), kind, ruleId: ruleRef(item.ruleId, kind), channel: oneOf(item.channel, CHANNELS), attempts: count(item.attempts, 10), nextAt: iso(item.nextAt) }
    }) : bad(),
    log: Array.isArray(rawDelivery.log) && rawDelivery.log.length <= 200 ? rawDelivery.log.map((item): AlertDeliveryLogView => {
      if (!object(item)) return bad()
      const kind = oneOf(item.kind, KINDS)
      return { at: iso(item.at), noticeId: notice(item.noticeId), kind, ruleId: ruleRef(item.ruleId, kind), channel: item.channel === null ? null : oneOf(item.channel, CHANNELS),
        result: oneOf(item.result, ['sent', 'failed', 'gave_up', 'no_channel'] as const), attempt: count(item.attempt, 10),
        error: item.error === null ? null : oneOf(item.error, ['unreachable', 'timed_out', 'refused', 'rejected_status', 'address_not_public', 'no_signing_key'] as const), status: item.status === null ? null : count(item.status, 999) }
    }) : bad(),
  }
  const bounds: Record<string, AlertBoundView | null> = {}
  for (const id of IDS) {
    const raw = value.bounds[id]
    if (raw === null) { bounds[id] = null; continue }
    if (!object(raw)) return bad()
    const bound: AlertBoundView = { unit: oneOf(raw.unit, ['per-processor', 'percent', 'days'] as const), direction: oneOf(raw.direction, ['above', 'below'] as const), min: finite(raw.min), max: finite(raw.max), decimals: raw.decimals === 1 ? 1 : raw.decimals === 0 ? 0 : bad(), default: finite(raw.default) }
    if (!(bound.min <= bound.default && bound.default <= bound.max)) return bad()
    bounds[id] = bound
  }
  const threshold = (id: string, item: unknown): number | null => {
    const bound = bounds[id]
    if (!bound) return item === null ? null : bad()
    return typeof item === 'number' && item >= bound.min && item <= bound.max && Number(item.toFixed(bound.decimals)) === item ? item : bad()
  }
  const rules = list(value.rules).map((raw, index): AlertRuleView => object(raw) && raw.id === IDS[index] && typeof raw.enabled === 'boolean' ? { id: IDS[index]!, enabled: raw.enabled, threshold: threshold(IDS[index]!, raw.threshold) } : bad())
  const quiet = value.quiet === null ? null : object(value.quiet) ? { start: time(value.quiet.start), end: time(value.quiet.end) } : bad()
  if (quiet && quiet.start === quiet.end) return bad()
  const state = oneOf(value.state, ['default', 'saved', 'invalid'] as const), evaluationState = oneOf(value.evaluationState, ['none', 'read', 'invalid'] as const)
  if ((state === 'saved') !== (value.updatedAt !== null) || (state === 'saved') !== (value.updatedBy !== null) || (evaluationState === 'read') !== (value.evaluation !== null)) return bad()
  const updatedBy = value.updatedBy === null ? null : /^[A-Za-z0-9_.@-]{1,64}$/.test(text(value.updatedBy, 64)) ? value.updatedBy as string : bad()
  let evaluation: AlertEvaluationView | null = null
  if (value.evaluation !== null) {
    const raw = object(value.evaluation) ? value.evaluation : bad()
    const evaluatedAt = iso(raw.evaluatedAt)
    const results = list(raw.results).map((item, index): AlertResultView => {
      const id = IDS[index]!
      if (!object(item) || item.id !== id || typeof item.enabled !== 'boolean') return bad()
      const result: AlertResultView = { id, enabled: item.enabled, threshold: threshold(id, item.threshold), state: oneOf(item.state, ['firing', 'ok', 'unavailable', 'disabled'] as const),
        severity: item.severity === null ? null : oneOf(item.severity, ['critical', 'warning'] as const), health: oneOf(item.health, ['ok', 'warning', 'problem', 'unavailable'] as const),
        value: item.value === null ? null : finite(item.value), matches: Array.isArray(item.matches) && item.matches.length <= 25 ? item.matches.map(name => text(name, 512)) : bad(),
        evidence: text(item.evidence, 1024), firstFiredAt: item.firstFiredAt === null ? null : iso(item.firstFiredAt) }
      const firing = result.state === 'firing'
      if ((result.state === 'disabled') === result.enabled || firing !== (result.severity !== null) || firing !== (result.firstFiredAt !== null)
        || firing && (result.severity !== (result.health === 'problem' ? 'critical' : 'warning') || result.firstFiredAt! > evaluatedAt)) return bad()
      return result
    })
    evaluation = { evaluatedAt, observedAt: iso(raw.observedAt), host: oneOf(raw.host, ['read', 'unavailable'] as const), rulesRevision: hex(raw.rulesRevision), quiet: typeof raw.quiet === 'boolean' ? raw.quiet : bad(), results }
  }
  return { state, rules, quiet, updatedAt: value.updatedAt === null ? null : iso(value.updatedAt), updatedBy, revision: hex(value.revision), bounds, delivery, evaluationState, evaluation }
}

function bindWhmMonitoringAlerts(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-monitoring-alerts-workspace]').forEach(root => {
    if (root.dataset.alertsBound === 'true') return
    root.dataset.alertsBound = 'true'
    const one = <T extends HTMLElement = HTMLElement>(name: string): T | null => root.querySelector<T>('[data-whm-alerts-' + name + ']')
    const status = one('status'), evalStatus = one('eval-status'), saveStatus = one('save-status'), form = one('form'), results = one('results'), log = one('log')
    const evaluate = one<HTMLButtonElement>('evaluate'), save = one<HTMLButtonElement>('save'), reload = one<HTMLButtonElement>('reload')
    const quietOn = one<HTMLInputElement>('quiet'), quietStart = one<HTMLInputElement>('quiet-start'), quietEnd = one<HTMLInputElement>('quiet-end')
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-whm-alerts-rule]'))
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !evalStatus || !saveStatus || !form || !results || !log || !evaluate || !save || !reload || !quietOn || !quietStart || !quietEnd || rows.length !== 9) return
    const cell = <T extends HTMLElement>(row: HTMLElement, name: string): T | null => row.querySelector<T>('[data-whm-alerts-' + name + ']')
    const inputs = (): HTMLInputElement[] => rows.flatMap(row => [cell<HTMLInputElement>(row, 'enabled'), cell<HTMLInputElement>(row, 'threshold')]).filter((item): item is HTMLInputElement => !!item)
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.alertsCanManage === 'true' && !root.closest(denied) && form.tagName === 'FORM' && typeof request === 'function'
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (className) node.className = className; return node }
    const technical = (content: string): HTMLElement => { const node = element('bdi', content); node.dir = 'ltr'; return node }
    // One whole message split at its {placeholders}, each replaced by its node.
    const parts = (message: string, nodes: Record<string, string | Node>): (string | Node)[] => message.split(/(\{\w+\})/).filter(Boolean).map(part => nodes[part] ?? part)
    const fact = (key: string, content: string | Node): void => { const target = root.querySelector<HTMLElement>('[data-whm-alerts-fact="' + key + '"]'); if (target) target.replaceChildren(content) }
    const span = (from: string, to: string): string => {
      const minutes = Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 60000)), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60
      return minutes < 1 ? t('under 1 min') : days ? t('{days} d {hours} h', { days, hours }) : hours ? t('{hours} h {minutes} min', { hours, minutes: rest }) : t('{minutes} min', { minutes: rest })
    }
    let view: MonitoringAlertsView | null = null, busy = false
    const sync = (): void => {
      const open = admitted() && !busy && !!view
      for (const input of inputs()) input.disabled = !open || input.hasAttribute('data-whm-alerts-threshold') && !view?.bounds[input.closest<HTMLElement>('[data-whm-alerts-rule]')!.dataset.whmAlertsRule ?? '']
      quietOn.disabled = !open; quietStart.disabled = quietEnd.disabled = !open || !quietOn.checked
      save.disabled = !open; reload.disabled = !admitted() || busy; evaluate.disabled = !open || view?.state === 'invalid'
      root.setAttribute('aria-busy', String(busy))
    }
    const titleOf = (id: string): string => rows.find(row => row.dataset.whmAlertsRule === id)?.querySelector('[data-whm-alerts-title]')?.textContent ?? id
    const unitOf = (id: string): string => rows.find(row => row.dataset.whmAlertsRule === id)?.querySelector('[data-whm-alerts-unit]')?.textContent ?? ''
    const condition = (id: string, threshold: number | null): string => {
      const bound = view?.bounds[id]
      return !bound || threshold === null ? t('Fires when the health check reports a warning or a problem.')
        : bound.direction === 'above' ? t('Fires at or above {threshold} {unit}.', { threshold, unit: unitOf(id) }) : t('Fires below {threshold} {unit}.', { threshold, unit: unitOf(id) })
    }
    const paintRules = (next: MonitoringAlertsView): void => {
      for (const row of rows) {
        const id = row.dataset.whmAlertsRule ?? '', rule = next.rules.find(entry => entry.id === id), bound = next.bounds[id]
        const enabled = cell<HTMLInputElement>(row, 'enabled'), input = cell<HTMLInputElement>(row, 'threshold'), range = cell<HTMLElement>(row, 'range')
        if (enabled) enabled.checked = !!rule?.enabled
        if (input && bound) { input.min = String(bound.min); input.max = String(bound.max); input.step = bound.decimals ? '0.1' : '1'; input.value = rule?.threshold === null || rule === undefined ? '' : String(rule.threshold); input.removeAttribute('aria-invalid') }
        if (range && bound) range.replaceChildren(condition(id, rule?.threshold ?? null) + ' ', ...parts(t('Allowed: {range}. Default: {defaultValue}.'), { '{range}': technical(bound.min + ' - ' + bound.max), '{defaultValue}': technical(String(bound.default)) }))
      }
      quietOn.checked = !!next.quiet; quietStart.value = next.quiet?.start ?? ''; quietEnd.value = next.quiet?.end ?? ''
      fact('updated', next.updatedAt ? technical(formatDisplayDateTime(next.updatedAt)) : t('Never saved')); fact('updated-by', next.updatedBy ? technical(next.updatedBy) : t('Nobody'))
      note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'saved' ? t('Saved rules read.')
        : next.state === 'default' ? t('No rules have been saved. The default rules below follow the server health warning levels.')
          : t('The saved rules file could not be verified, so the defaults are shown and evaluation is unavailable. Saving here replaces it.'))
    }
    const channelName = (channel: string | null): string => channel === 'email' ? t('Email') : channel === 'webhook' ? t('Webhook') : t('No channel')
    const kindName = (kind: string): string => kind === 'firing' ? t('Firing') : kind === 'resolved' ? t('Resolved') : t('Test')
    const resultText = (entry: AlertDeliveryLogView): string => {
      const reason = entry.error === 'rejected_status' ? t('the receiver answered with status {status}', { status: entry.status ?? '-' })
        : entry.error === 'refused' ? (entry.status === null ? t('the mail server refused the message') : t('the mail server refused the message ({status})', { status: entry.status }))
          : entry.error === 'timed_out' ? t('no answer in time') : entry.error === 'address_not_public' ? t('the address is not a public HTTPS address')
            : entry.error === 'no_signing_key' ? t('no signing key exists') : t('the receiver could not be reached')
      return entry.result === 'sent' ? t('Sent') : entry.result === 'no_channel' ? t('Not sent: no channel is selected for alerts')
        : entry.result === 'gave_up' ? t('Not sent: gave up after {attempts} attempts, {reason}', { attempts: entry.attempt, reason }) : t('Not sent: {reason}; retrying', { reason })
    }
    const paintDelivery = (next: MonitoringAlertsView): void => {
      const delivery = next.delivery, channels = delivery.channels
      fact('notifications', !channels.alerts ? t('Not sent. Monitoring alerts are not selected on the notifications page.')
        : !channels.active.length ? t('Not sent. No recipient or enabled webhook is saved on the notifications page.')
          : channels.email && channels.webhook ? t('{count, plural, one {Sent by email to one recipient and to the webhook.} other {Sent by email to {count} recipients and to the webhook.}}', { count: channels.email })
            : channels.email ? t('{count, plural, one {Sent by email to one recipient.} other {Sent by email to {count} recipients.}}', { count: channels.email }) : t('Sent to the webhook.'))
      const lastRun = delivery.scheduler.lastRun
      const schedule = element('span')
      schedule.append(...(lastRun ? parts(t('Every {minutes} minutes. Last check {at}: {result}.'), { '{minutes}': technical(String(delivery.scheduler.everyMinutes)), '{at}': technical(formatDisplayDateTime(lastRun.at)),
        '{result}': lastRun.result === 'evaluated' ? t('evaluated') : lastRun.result === 'host_unavailable' ? t('the host could not be read') : t('the saved rules could not be verified') })
        : parts(t('Every {minutes} minutes. No scheduled check has run yet.'), { '{minutes}': technical(String(delivery.scheduler.everyMinutes)) })))
      fact('scheduler', schedule)
      fact('pending', technical(String(delivery.pending.length)))
      log.replaceChildren(...(delivery.log.length ? delivery.log.map(entry => {
        const row = element('tr'), time = element('td')
        row.dataset.result = entry.result; time.append(technical(formatDisplayDateTime(entry.at)))
        row.append(time, element('td', entry.ruleId ? titleOf(entry.ruleId) : t('Test message')), element('td', kindName(entry.kind)), element('td', channelName(entry.channel)), element('td', resultText(entry)))
        return row
      }) : [(() => { const row = element('tr'), cell = element('td', delivery.state === 'invalid' ? t('The delivery record could not be verified. The next evaluation starts a new one.') : t('No message has been sent or attempted.'), 'xp-help'); cell.colSpan = 5; row.append(cell); return row })()]))
    }
    const BADGES: Record<string, readonly [string, string]> = { critical: [msgid('Critical'), 'xp-badge xp-badge--critical'], warning: [msgid('Warning'), 'xp-badge xp-badge--warn'], ok: [msgid('Not firing'), 'xp-badge xp-badge--ok'], unavailable: [msgid('Not verified'), 'xp-badge'], disabled: [msgctxt('whm-monitoring-alerts', 'Disabled'), 'xp-badge'] }
    const badge = (key: string): HTMLElement => element('span', t(BADGES[key]![0]), BADGES[key]![1])
    const paintEvaluation = (next: MonitoringAlertsView): void => {
      const record = next.evaluation
      if (!record) {
        for (const key of ['evaluated-at', 'observed-at', 'firing', 'unavailable', 'quiet']) fact(key, t('Not evaluated'))
        results.replaceChildren(element('li', t('No results have been recorded.'), 'xp-help'))
        note(evalStatus, next.evaluationState === 'invalid' ? 'failed' : 'read', next.evaluationState === 'invalid' ? t('The last evaluation record could not be verified, so it is not shown. Evaluating again replaces it.')
          : t('No evaluation has been recorded yet. The schedule evaluates the rules, or select Evaluate now.'))
        return
      }
      const firing = record.results.filter(entry => entry.state === 'firing'), unverified = record.results.filter(entry => entry.state === 'unavailable')
      fact('evaluated-at', technical(formatDisplayDateTime(record.evaluatedAt))); fact('observed-at', technical(formatDisplayDateTime(record.observedAt))); fact('firing', technical(String(firing.length))); fact('unavailable', technical(String(unverified.length)))
      fact('quiet', !next.quiet ? t(msgctxt('whm-monitoring-alerts-client', 'Not set')) : record.quiet ? t('Active at the last evaluation') : t('Not active at the last evaluation'))
      results.replaceChildren(...record.results.map(result => {
        const item = element('li', undefined, 'xp-whm-alerts__result'), head = element('div', undefined, 'xp-whm-alerts__head'), badges = element('span', undefined, 'xp-whm-alerts__badges')
        item.dataset.whmAlertsResult = result.id; item.dataset.state = result.state; if (result.severity) item.dataset.severity = result.severity
        badges.append(badge(result.severity ?? result.state)); if (result.state === 'firing' && record.quiet) badges.append(element('span', t('Quiet window'), 'xp-badge'))
        head.append(element('h3', titleOf(result.id)), badges); item.append(head)
        if (result.state === 'disabled') { item.append(element('p', t('This rule is disabled, so it was not evaluated.'))); return item }
        const measured = element('p')
        if (view?.bounds[result.id]) measured.append(...(result.value === null ? [t('Measured: not read.')] : result.id === 'certificates' && result.value <= 0 ? [t('Measured: expired.')] : parts(t('Measured: {value} {unit}.'), { '{value}': technical(String(result.value)), '{unit}': unitOf(result.id) })), ' ')
        measured.append(condition(result.id, result.threshold))
        item.append(measured)
        if (result.state === 'unavailable') item.append(element('p', result.health === 'unavailable' ? t('The health check could not be read, so this rule could not be verified.')
          : t('The value could not be read from the health observation, or some entries are not listed, so this rule could not be verified.')))
        if (result.firstFiredAt) { const since = element('p'); since.append(...parts(t('Firing since {since}, for {duration} as of the last evaluation.'), { '{since}': technical(formatDisplayDateTime(result.firstFiredAt)), '{duration}': technical(span(result.firstFiredAt, record.evaluatedAt)) })); item.append(since) }
        if (result.matches.length) { const affected = element('p'), names = document.createDocumentFragment(); result.matches.forEach((name, index) => { if (index) names.append(', '); names.append(technical(name)) }); affected.append(...parts(t('Affected: {items}'), { '{items}': names })); item.append(affected) }
        const latest = next.delivery.log.find(entry => entry.ruleId === result.id)
        const last = element('p')
        if (latest) {
          const sameNotice = next.delivery.log.filter(entry => entry.noticeId === latest.noticeId), seen = new Set<string | null>()
          const summary = sameNotice.filter(entry => !seen.has(entry.channel) && seen.add(entry.channel)).map(entry => channelName(entry.channel) + ': ' + resultText(entry)).join('; ')
          last.append(...parts(t('Last message ({kind}) {at}: {summary}.'), { '{kind}': kindName(latest.kind), '{at}': technical(formatDisplayDateTime(latest.at)), '{summary}': summary }))
        } else last.append(t('No message has been sent for this alert.'))
        item.append(last)
        if (result.evidence) { const details = element('details'), pre = element('pre', result.evidence, 'xp-whm-alerts__evidence'); pre.dir = 'ltr'; pre.tabIndex = 0; details.append(element('summary', t('Health evidence')), pre); item.append(details) }
        return item
      }))
      note(evalStatus, firing.some(entry => entry.severity === 'critical') ? 'problem' : firing.length ? 'warning' : unverified.length ? 'partial' : 'read',
        (firing.length ? t('{count, plural, one {One alert is firing.} other {{count} alerts are firing.}}', { count: firing.length }) : unverified.length ? t('No alert is firing, but some rules could not be verified.') : t('No alert is firing.'))
        + (record.host === 'unavailable' ? ' ' + t('This server could not be observed natively, so host checks were not read.') : '')
        + (record.rulesRevision !== next.revision ? ' ' + t('The rules changed after this evaluation.') : '')
        + (record.quiet && firing.length ? ' ' + t('The quiet window was active, so nothing was sent.') : ''))
    }
    const paint = (next: MonitoringAlertsView): void => { view = next; paintRules(next); paintEvaluation(next); paintDelivery(next) }
    const failText = (error: unknown, fallback: string): string => {
      const failed = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean } }
      return failed?.details?.verificationRequired || failed?.details?.stateChanged ? t('The change could not be verified. Reload before trying again.')
        : failed?.status === 409 ? t('The rules changed since they were read. Reload them before saving.')
          : failed?.status === 403 ? t('Root authorization is required for alerts.')
            : failed?.status === 412 ? t('Evaluation is unavailable: the host agent is not connected, or the saved rules or the health observation could not be verified. Nothing was recorded.')
              : failed?.status === 400 || failed?.status === 422 ? t('The server refused these values. Check the thresholds and the quiet window.') : fallback
    }
    const run = async (target: HTMLElement, reading: string, task: () => Promise<void>, fallback: string): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; sync(); note(target, 'reading', reading)
      try { await task() } catch (error) { note(target, 'failed', failText(error, fallback)) } finally { busy = false; sync() }
    }
    const load = (): Promise<void> => run(status, t('Reading alert rules…'), async () => { const next = readMonitoringAlertsView(await request!('GET', '/api/server/monitoring-alerts')); if (admitted()) paint(next) },
      t('Alert rules could not be read or verified. Nothing was changed.'))
    if (!admitted()) {
      for (const control of [evaluate, save, reload, quietOn, quietStart, quietEnd, ...inputs()]) control.disabled = true
      note(status, 'unavailable', t('Alert rules are unavailable here. Nothing was read or changed.'))
      note(evalStatus, 'unavailable', t('Evaluation is unavailable here. Nothing was read or recorded.'))
      return
    }
    quietOn.addEventListener('change', sync)
    reload.addEventListener('click', () => { saveStatus.hidden = true; void load() })
    evaluate.addEventListener('click', () => { void run(evalStatus, t('Reading server health and evaluating the rules…'),
      async () => { const next = readMonitoringAlertsView(await request!('POST', '/api/server/monitoring-alerts/evaluate')); if (admitted()) paint(next) }, t('The evaluation could not be completed. Nothing new was recorded.')) })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || !view || !admitted()) return
      const current = view
      let wrong: HTMLInputElement | null = null
      const rules = rows.map(row => {
        const id = row.dataset.whmAlertsRule ?? '', bound = current.bounds[id], input = cell<HTMLInputElement>(row, 'threshold')
        const value = bound && input ? Number(input.value) : null
        const fits = value === null || input!.value.trim() !== '' && Number.isFinite(value) && value >= bound!.min && value <= bound!.max && Number(value.toFixed(bound!.decimals)) === value
        if (input && fits) input.removeAttribute('aria-invalid'); else if (input) input.setAttribute('aria-invalid', 'true')
        if (!fits && !wrong) wrong = input
        return { id, enabled: !!cell<HTMLInputElement>(row, 'enabled')?.checked, threshold: value }
      })
      quietStart.removeAttribute('aria-invalid'); quietEnd.removeAttribute('aria-invalid')
      if (wrong) { note(saveStatus, 'failed', t('Enter each threshold inside its allowed range.')); (wrong as HTMLInputElement).focus(); return }
      const pattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
      if (quietOn.checked && (!pattern.test(quietStart.value) || !pattern.test(quietEnd.value) || quietStart.value === quietEnd.value)) {
        quietStart.setAttribute('aria-invalid', 'true'); quietEnd.setAttribute('aria-invalid', 'true')
        note(saveStatus, 'failed', t('Enter different start and end times for the quiet window.')); quietStart.focus(); return
      }
      void run(saveStatus, t('Saving alert rules…'), async () => {
        const next = readMonitoringAlertsView(await request!('PUT', '/api/server/monitoring-alerts', { rules, quiet: quietOn.checked ? { start: quietStart.value, end: quietEnd.value } : null, expectedRevision: current.revision }))
        if (next.state !== 'saved') throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(next)
        note(saveStatus, 'read', t('Rules saved. They apply from the next evaluation.'))
      }, t('The rules were not saved.'))
    })
    void load()
  })
}

export const WHM_MONITORING_ALERTS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readMonitoringAlertsView=${readMonitoringAlertsView.toString()};return ${bindWhmMonitoringAlerts.toString()};})()`
