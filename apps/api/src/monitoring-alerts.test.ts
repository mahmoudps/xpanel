import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { evaluateServerHealth, SERVER_HEALTH_THRESHOLDS } from '../../agent/src/server-health.ts'
import type { ServerHealthReport, ServerHealthRouteContext } from '../../agent/src/server-health.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { sha256Hex } from './auth.ts'
import { ALERT_BOUNDS, ALERT_CHECK_IDS, DEFAULT_ALERT_RULES, evaluateAlertRules, handleMonitoringAlertsRoute, parseAlertRulesUpdate, readSavedAlertEvaluation, readSavedAlertRules, runScheduledAlertCycle } from './monitoring-alerts.ts'
import { readSavedDeliveryState } from './alert-delivery.ts'
import type { DeliveryChannels } from './alert-delivery.ts'
import type { AlertEvaluation, AlertResult, AlertRule, MonitoringAlertsHelpers } from './monitoring-alerts.ts'
import { projectServerHealth } from './server-health-workspace.ts'
import { MONITORING_ALERT_ROWS } from '../../web/src/board-port/whm-monitoring-alerts-workspace.ts'

const at = '2026-10-27T10:00:00.000Z', DAY = 86_400_000, HOUR = 3_600_000
const EMPTY = sha256Hex('null')
const ROUTE = '/api/server/monitoring-alerts', EVALUATE = ROUTE + '/evaluate'
// Same host fixture as apps/agent/src/server-health.test.ts, so the real evidence producer runs.
const DF = 'Filesystem Type 1B-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 960 40 96% /\ntmpfs tmpfs 100 100 0 100% /run\n/dev/sdb1 xfs 1000 100 900 10% /home\n'
const DF_INODES = 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 100 90 10 90% /\ntmpfs 10 1 9 10% /run\n/dev/sdb1 0 0 0 - /home\n'
const FILES: Record<string, string> = {
  '/proc/loadavg': '1.00 3.00 0.50 1/100 1234\n',
  '/proc/cpuinfo': 'processor\t: 0\nmodel name\t: Test CPU\n\nprocessor\t: 1\nmodel name\t: Test CPU\n',
  '/proc/meminfo': 'MemTotal:        1000000 kB\nMemFree:          50000 kB\nMemAvailable:     100000 kB\nSwapTotal:          1000 kB\nSwapFree:            100 kB\n',
  '/run/reboot-required': '*** System restart required ***\n',
}
type Executor = NonNullable<ServerHealthRouteContext['executor']>
const host = (files: Record<string, string> = FILES): Executor => ({
  readFile: async (path: string) => files[path] ?? null,
  runCommand: async (argv: string[]) => argv[0] === '/usr/bin/df' ? { ok: true, code: 0, stdout: argv.includes('-i') ? DF_INODES : DF, stderr: '' }
    : argv[0] === '/usr/bin/systemctl' ? { ok: true, code: 0, stdout: argv.at(-1) === 'nginx.service' ? 'loaded\nfailed\n' : 'loaded\nactive\n', stderr: '' } : { ok: false, code: 1, stdout: '', stderr: 'unexpected' },
}) as unknown as Executor
const cert = (name: string, days: number) => ({ names: [name], notAfter: new Date(Date.parse(at) + days * DAY).toISOString(), autoRenew: true, source: 'acme' as const })
const drift = async () => ({ hasDrift: true, manifestMissing: false, generationId: 7, items: [{ path: '/etc/nginx/nginx.conf', reason: 'content_mismatch' as const }] })
const agentReport = (executor: Executor | null = host(), now = at) => evaluateServerHealth({ executor, family: executor ? 'debian' : null, readDrift: executor ? drift : null,
  saved: { certificates: [cert('ok.example.test', 60), cert('soon.example.test', 5), cert('old.example.test', -1)], accounts: [], plans: [] }, now: () => new Date(now) })
const observe = async (executor: Executor | null = host()): Promise<ServerHealthReport> => projectServerHealth(JSON.parse(JSON.stringify(await agentReport(executor))))
const rules = (patch: Partial<Record<string, Partial<AlertRule>>> = {}): AlertRule[] => DEFAULT_ALERT_RULES.map(rule => ({ ...rule, ...patch[rule.id] }))
const byId = (record: AlertEvaluation): Record<string, AlertResult> => Object.fromEntries(record.results.map(entry => [entry.id, entry]))
const evaluate = (report: ServerHealthReport, patch: Parameters<typeof rules>[0] = {}, quiet: { start: string; end: string } | null = null, when = at) =>
  evaluateAlertRules(report, { rules: rules(patch), quiet }, null, new Date(when), EMPTY)

describe('alert rule grammar', () => {
  it('keeps defaults at the health warning levels and the renderer rows in step', () => {
    const levels = SERVER_HEALTH_THRESHOLDS
    expect([ALERT_BOUNDS.load!.default, ALERT_BOUNDS.memory!.default, ALERT_BOUNDS.swap!.default, ALERT_BOUNDS['disk-space']!.default, ALERT_BOUNDS['disk-inodes']!.default])
      .toEqual([levels.loadPerCore.warning, levels.memoryAvailablePercent.warning, levels.swapUsedPercent.warning, levels.diskUsedPercent.warning, levels.inodeUsedPercent.warning])
    expect(ALERT_BOUNDS.certificates).toMatchObject({ max: levels.certificateExpiryDays, default: levels.certificateExpiryDays })
    expect(MONITORING_ALERT_ROWS.map(row => row.id)).toEqual([...ALERT_CHECK_IDS])
    expect(MONITORING_ALERT_ROWS.filter(row => row.unit).map(row => row.id)).toEqual(ALERT_CHECK_IDS.filter(id => ALERT_BOUNDS[id]))
  })

  it('accepts thresholds only within the documented bounds', () => {
    const body = (patch: Parameters<typeof rules>[0], quiet: unknown = null) => ({ rules: rules(patch), quiet, expectedRevision: EMPTY })
    for (const patch of [{ 'disk-space': { threshold: 50 } }, { 'disk-space': { threshold: 99 } }, { load: { threshold: 0.5 } }, { load: { threshold: 2.5 } }, { load: { threshold: 10 } }, { certificates: { threshold: 1 } }, { services: { enabled: false } }])
      expect(parseAlertRulesUpdate(body(patch)).rules).toEqual(rules(patch))
    expect(parseAlertRulesUpdate(body({}, { start: '22:00', end: '06:00' })).quiet).toEqual({ start: '22:00', end: '06:00' })
    const reversed = rules().reverse()
    for (const bad of [body({ 'disk-space': { threshold: 49 } }), body({ 'disk-space': { threshold: 100 } }), body({ 'disk-space': { threshold: 85.5 } }), body({ load: { threshold: 0.4 } }), body({ load: { threshold: 1.25 } }),
      body({ memory: { threshold: 0 } }), body({ certificates: { threshold: 15 } }), body({ services: { threshold: 1 } }), body({ load: { threshold: null } }), body({ swap: { enabled: 'yes' as unknown as boolean } }),
      { rules: rules().slice(1), quiet: null, expectedRevision: EMPTY }, { rules: reversed, quiet: null, expectedRevision: EMPTY }, { rules: rules().map(rule => ({ ...rule, severity: 'critical' })), quiet: null, expectedRevision: EMPTY },
      body({}, { start: '22:00', end: '22:00' }), body({}, { start: '24:00', end: '06:00' }), body({}, { start: '22:00' }), { rules: rules(), expectedRevision: EMPTY },
      { ...body({}), channel: 'sms' }, { ...body({}), expectedRevision: 'abc' }]) expect(() => parseAlertRulesUpdate(bad), JSON.stringify(bad).slice(0, 120)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('reads saved files strictly and reports anything else as unverified', () => {
    const good = { rules: rules({ swap: { threshold: 70 } }), quiet: null, updatedAt: at, updatedBy: 'root' }
    expect(readSavedAlertRules(good)).toEqual(good)
    for (const bad of [{ ...good, extra: 1 }, { ...good, rules: rules({ swap: { threshold: 5 } }) }, { ...good, updatedAt: 'yesterday' }, [], null]) expect(readSavedAlertRules(bad)).toBeNull()
    expect(readSavedAlertEvaluation({ evaluatedAt: at })).toBeNull()
  })
})

describe('alert evaluation mapping', () => {
  it('fires each default rule that the observed health grades, with severity, values and affected names', async () => {
    const record = evaluate(await observe()), result = byId(record)
    expect(record).toMatchObject({ evaluatedAt: at, observedAt: at, host: 'read', rulesRevision: EMPTY, quiet: false })
    expect(Object.values(result).every(entry => entry.state === 'firing' && entry.firstFiredAt === at)).toBe(true)
    expect(result.load).toMatchObject({ severity: 'warning', health: 'warning', value: 1.5, threshold: 1 })
    expect(result.memory).toMatchObject({ severity: 'warning', value: 10 })
    expect(result.swap).toMatchObject({ severity: 'critical', value: 90 })
    expect(result['disk-space']).toMatchObject({ severity: 'critical', value: 96, matches: ['/'] })
    expect(result['disk-inodes']).toMatchObject({ severity: 'warning', value: 90, matches: ['/'] })
    expect(result.services).toMatchObject({ severity: 'critical', value: null, matches: ['nginx'] })
    expect(result.drift).toMatchObject({ severity: 'critical', matches: ['/etc/nginx/nginx.conf'] })
    expect(result.certificates).toMatchObject({ severity: 'critical', value: -1, matches: ['old.example.test', 'soon.example.test'] })
    expect(result.reboot).toMatchObject({ severity: 'warning', health: 'warning' })
    expect(result['disk-space']!.evidence).toContain('filesystems graded')
    expect(readSavedAlertEvaluation(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('applies threshold overrides and disabled rules', async () => {
    const result = byId(evaluate(await observe(), { load: { threshold: 2 }, memory: { threshold: 5 }, swap: { threshold: 95 }, 'disk-space': { threshold: 99 }, 'disk-inodes': { threshold: 50 }, certificates: { threshold: 3 }, services: { enabled: false } }))
    expect(result.load).toMatchObject({ state: 'ok', severity: null, value: 1.5, firstFiredAt: null })
    expect(result.memory).toMatchObject({ state: 'ok', value: 10 })
    expect(result.swap).toMatchObject({ state: 'ok', value: 90 })
    expect(result['disk-space']).toMatchObject({ state: 'ok', value: 96, matches: [] })
    expect(result['disk-inodes']).toMatchObject({ state: 'firing', matches: ['/'] })
    expect(result.certificates).toMatchObject({ state: 'firing', severity: 'critical', matches: ['old.example.test'] })
    expect(result.services).toMatchObject({ state: 'disabled', enabled: false, severity: null, value: null, matches: [], health: 'problem' })
    const low = byId(evaluate(await observe(), { 'disk-space': { threshold: 50 }, load: { threshold: 0.5 } }))
    expect(low['disk-space']).toMatchObject({ state: 'firing', matches: ['/'] })
    expect(low.load).toMatchObject({ state: 'firing', severity: 'warning' })
  })

  it('reports unread checks and unreadable values as not verified, never as ok', async () => {
    const offline = byId(evaluate(await observe(null)))
    for (const id of ['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'reboot']) expect(offline[id], id).toMatchObject({ state: 'unavailable', health: 'unavailable', severity: null, value: null, firstFiredAt: null })
    expect(offline.certificates).toMatchObject({ state: 'firing' })
    const report = await observe()
    const tampered = (id: string, patch: Record<string, unknown>): ServerHealthReport => ({ ...report, checks: report.checks.map(entry => entry.id === id ? { ...entry, ...patch } : entry) })
    expect(byId(evaluate(tampered('load', { evidence: 'load average could not be parsed' }))).load).toMatchObject({ state: 'unavailable', health: 'warning' })
    const disk = report.checks.find(entry => entry.id === 'disk-space')!
    expect(byId(evaluate(tampered('disk-space', { omitted: 3 }), { 'disk-space': { threshold: 99 } }))['disk-space']).toMatchObject({ state: 'unavailable', value: 96 })
    expect(byId(evaluate(tampered('disk-space', { omitted: 3 })))['disk-space']).toMatchObject({ state: 'firing', matches: ['/'] })
    expect(byId(evaluate(tampered('disk-space', { items: disk.items!.map(item => ({ ...item, evidence: item.evidence.slice(0, 20) + '...' })) })))['disk-space']).toMatchObject({ state: 'unavailable', value: null })
    const noSwap = byId(evaluate(await observe(host({ ...FILES, '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 900 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' }))))
    expect(noSwap.swap).toMatchObject({ state: 'ok', value: null })
    expect(noSwap.memory).toMatchObject({ state: 'ok', value: 90 })
  })

  it('marks the quiet window, including one that crosses midnight', async () => {
    const report = await observe(), night = { start: '22:00', end: '06:00' }
    expect(['2026-10-27T23:30:00.000Z', '2026-10-27T05:59:00.000Z'].map(when => evaluate(report, {}, night, when).quiet)).toEqual([true, true])
    expect(['2026-10-27T06:00:00.000Z', at].map(when => evaluate(report, {}, night, when).quiet)).toEqual([false, false])
    expect(evaluate(report, {}, { start: '09:00', end: '17:00' }).quiet).toBe(true)
    expect(evaluate(report).quiet).toBe(false)
  })
})

const CHANNELS: DeliveryChannels = { alerts: true, recipients: ['ops@example.com'], webhook: { url: 'https://hooks.example.com/xpanel', key: 'whsec_' + 'k'.repeat(43) } }
const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'res1' }, sessionId: 's2', apiTokenId: null } as unknown as AuthenticatedCaller
const clone = <T>(value: T): T => value === null || value === undefined ? value : JSON.parse(JSON.stringify(value))
const setup = (overrides: Partial<MonitoringAlertsHelpers> = {}, initial: { rules?: unknown; state?: unknown; channels?: DeliveryChannels | null } = {}) => {
  const files: { rules: unknown; state: unknown; delivery: unknown } = { rules: initial.rules ?? null, state: initial.state ?? null, delivery: null }
  const audits: Record<string, unknown>[] = [], clock = { now: at }, mail: { subject: string }[] = [], hooks: { headers: Record<string, string>; body: string }[] = []
  const helpers: MonitoringAlertsHelpers = {
    readDelivery: vi.fn(async () => clone(files.delivery)), writeDelivery: vi.fn(async (value: unknown) => { files.delivery = clone(value); return value }),
    readChannels: vi.fn(async () => initial.channels === undefined ? CHANNELS : initial.channels),
    transports: { serverName: 'srv1.example.test', email: vi.fn(async message => { mail.push(message) }), webhook: vi.fn(async request => { hooks.push(request); return { status: 200 } }) },
    requireCaller: vi.fn(async () => root),
    assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    readRules: vi.fn(async () => clone(files.rules)), writeRules: vi.fn(async (value: unknown) => { files.rules = clone(value); return value }),
    readState: vi.fn(async () => clone(files.state)), writeState: vi.fn(async (value: unknown) => { files.state = clone(value); return value }),
    readHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => { expect(path).toBe('/host/server-health'); return clone(await agentReport(host(), clock.now)) }),
    now: () => new Date(clock.now),
    ...overrides,
  }
  return { helpers, files, audits, clock, mail, hooks }
}
type View = { state: string; revision: string; rules: AlertRule[]; evaluationState: string; evaluation: AlertEvaluation | null; delivery: { log: { kind: string; ruleId: string | null; channel: string | null; result: string }[]; pending: unknown[]; scheduler: unknown; channels: unknown; state: string }; bounds: unknown; quiet: unknown }
const call = async (method: string, h: MonitoringAlertsHelpers, body?: unknown, path = ROUTE, type = 'application/json') => {
  const url = new URL('http://localhost' + path)
  return handleMonitoringAlertsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': type } }) }), url, method, h)
}
const read = async (response: Response | null): Promise<View> => { expect(response!.status).toBe(200); return await response!.json() as View }
const put = (h: MonitoringAlertsHelpers, revision: string, patch: Parameters<typeof rules>[0] = {}, quiet: unknown = null) => call('PUT', h, { rules: rules(patch), quiet, expectedRevision: revision })

describe('monitoring alerts route', () => {
  it('leaves unrelated routes untouched', async () => {
    const { helpers: h } = setup()
    for (const path of [ROUTE + '/history', '/api/server/server-health', ROUTE + 's']) expect(await call('GET', h, undefined, path)).toBeNull()
    expect(h.requireCaller).not.toHaveBeenCalled()
  })

  it('reads defaults with the delivery schedule, channel counts and no-store', async () => {
    const { helpers: h } = setup()
    const response = (await call('GET', h))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await read(response)
    expect(body).toEqual({ state: 'default', rules: [...DEFAULT_ALERT_RULES], quiet: null, updatedAt: null, updatedBy: null, revision: EMPTY, bounds: ALERT_BOUNDS,
      delivery: { scheduler: { everyMinutes: 5, lastRun: null }, state: 'none', channels: { alerts: true, email: 1, webhook: true, active: ['email', 'webhook'] }, pending: [], log: [] }, evaluationState: 'none', evaluation: null })
    expect(JSON.stringify(body)).not.toContain(CHANNELS.webhook!.key!)
  })

  it('delivers each firing episode once by email and webhook, then its resolution, and shows it in the log', async () => {
    const { helpers: h, clock, mail, hooks, files } = setup()
    const first = await read(await call('POST', h, undefined, EVALUATE))
    const firing = first.evaluation!.results.filter(entry => entry.state === 'firing').length
    expect(mail).toHaveLength(firing)
    expect(hooks).toHaveLength(firing)
    expect(mail.map(message => message.subject)).toContain('[xPanel] Critical: Disk space per filesystem on srv1.example.test')
    expect(first.delivery.log.filter(entry => entry.result === 'sent')).toHaveLength(2 * firing)
    clock.now = new Date(Date.parse(at) + HOUR).toISOString()
    await call('POST', h, undefined, EVALUATE)
    expect(mail).toHaveLength(firing)
    const view = await read(await call('GET', h))
    await put(h, view.revision, { 'disk-space': { threshold: 99 } })
    clock.now = new Date(Date.parse(at) + 2 * HOUR).toISOString()
    const resolved = await read(await call('POST', h, undefined, EVALUATE))
    expect(mail).toHaveLength(firing + 1)
    expect(mail.at(-1)!.subject).toBe('[xPanel] Resolved: Disk space per filesystem on srv1.example.test')
    expect(JSON.parse(hooks.at(-1)!.body)).toMatchObject({ event: 'monitoring.alert.resolved', alert: { rule: 'disk-space', firstFiredAt: at } })
    expect(resolved.delivery.log[0]).toMatchObject({ kind: 'resolved', ruleId: 'disk-space', result: 'sent' })
    expect(readSavedDeliveryState(files.delivery)!.told['disk-space']).toBeUndefined()
  })

  it('holds delivery inside the quiet window and sends once it ends', async () => {
    const { helpers: h, clock, mail } = setup()
    await put(h, EMPTY, {}, { start: '09:00', end: '11:00' })
    await call('POST', h, undefined, EVALUATE)
    expect(mail).toHaveLength(0)
    clock.now = '2026-10-27T11:05:00.000Z'
    const after = await read(await call('POST', h, undefined, EVALUATE))
    expect(mail).toHaveLength(after.evaluation!.results.filter(entry => entry.state === 'firing').length)
  })

  it('logs no_channel when alerts are not selected, and never sends', async () => {
    const { helpers: h, mail, hooks } = setup({}, { channels: { ...CHANNELS, alerts: false } })
    const view = await read(await call('POST', h, undefined, EVALUATE))
    expect([mail.length, hooks.length]).toEqual([0, 0])
    expect(view.delivery.log.every(entry => entry.result === 'no_channel' && entry.channel === null)).toBe(true)
    expect(view.delivery.channels).toEqual({ alerts: false, email: 1, webhook: true, active: [] })
  })

  it('runs the scheduled cycle as evaluation plus delivery, and records why a cycle could not evaluate', async () => {
    const { helpers: h, files, mail } = setup()
    const readHost = vi.fn(async () => clone(await agentReport(host(), at)))
    expect(await runScheduledAlertCycle({ ...h, readHost })).toBe('evaluated')
    expect(readSavedAlertEvaluation(files.state)!.evaluatedAt).toBe(at)
    expect(mail.length).toBeGreaterThan(0)
    expect(readSavedDeliveryState(files.delivery)!.lastRun).toEqual({ at, result: 'evaluated' })
    expect(await runScheduledAlertCycle({ ...h, readHost: vi.fn(async () => { throw new Error('agent down') }) })).toBe('host_unavailable')
    expect(readSavedDeliveryState(files.delivery)!.lastRun).toEqual({ at, result: 'host_unavailable' })
    files.rules = { rules: 'all' }
    expect(await runScheduledAlertCycle({ ...h, readHost })).toBe('rules_invalid')
    expect(readSavedDeliveryState(files.delivery)!.lastRun!.result).toBe('rules_invalid')
    expect(readHost).toHaveBeenCalledTimes(1)
  })

  it('saves rules under the observed revision, re-reads and audits; a stale revision is a 409 conflict', async () => {
    const { helpers: h, files, audits } = setup()
    const view = await read(await put(h, EMPTY, { 'disk-space': { threshold: 90 }, reboot: { enabled: false } }, { start: '22:00', end: '06:00' }))
    expect(view).toMatchObject({ state: 'saved', quiet: { start: '22:00', end: '06:00' }, updatedBy: 'root', revision: sha256Hex(JSON.stringify(files.rules)) })
    expect(view.rules.find(rule => rule.id === 'disk-space')!.threshold).toBe(90)
    expect(audits).toEqual([expect.objectContaining({ action: 'server.alerts.updated', target: 'monitoring:alerts', outcome: 'ok',
      detail: expect.objectContaining({ enabled: ALERT_CHECK_IDS.filter(id => id !== 'reboot'), quiet: { start: '22:00', end: '06:00' }, thresholds: expect.objectContaining({ 'disk-space': 90, load: 1 }) }) })])
    await expect(put(h, EMPTY)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(h.writeRules).toHaveBeenCalledTimes(1)
  })

  it('refuses resellers with 403 and malformed requests with 400 before any read or write', async () => {
    const denied = setup({ requireCaller: vi.fn(async () => reseller) })
    await expect(call('GET', denied.helpers)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(put(denied.helpers, EMPTY)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('POST', denied.helpers, undefined, EVALUATE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied.helpers.readRules).not.toHaveBeenCalled()
    expect(denied.helpers.readHost).not.toHaveBeenCalled()
    const { helpers: h } = setup()
    await expect(call('GET', h, undefined, ROUTE + '?refresh=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, undefined, EVALUATE + '?now=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('PUT', h, '{')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('PUT', h, { rules: rules(), quiet: null, expectedRevision: EMPTY }, ROUTE, 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(put(h, EMPTY, { 'disk-space': { threshold: 100 } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('POST', h, {}, EVALUATE)).rejects.toMatchObject({ code: 'VALIDATION' })
    const remove = (await call('DELETE', h))!, getEvaluate = (await call('GET', h, undefined, EVALUATE))!
    expect([remove.status, remove.headers.get('allow'), getEvaluate.status, getEvaluate.headers.get('allow')]).toEqual([405, 'GET, PUT', 405, 'POST'])
    expect(h.writeRules).not.toHaveBeenCalled()
    expect(h.writeState).not.toHaveBeenCalled()
    expect(h.readHost).not.toHaveBeenCalled()
  })

  it('re-checks fresh root authority before saving rules and before recording an evaluation', async () => {
    const changed = { ...root, sessionId: 'other' } as unknown as AuthenticatedCaller
    for (const send of [(h: MonitoringAlertsHelpers) => put(h, EMPTY), (h: MonitoringAlertsHelpers) => call('POST', h, undefined, EVALUATE)]) {
      const { helpers: h } = setup({ requireCaller: vi.fn<MonitoringAlertsHelpers['requireCaller']>().mockResolvedValueOnce(root).mockResolvedValue(changed) })
      await expect(send(h)).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
      expect(h.writeRules).not.toHaveBeenCalled()
      expect(h.writeState).not.toHaveBeenCalled()
    }
  })

  it('evaluates on demand and keeps firing-since until an alert clears or its threshold changes', async () => {
    const { helpers: h, clock } = setup()
    const first = await read(await call('POST', h, undefined, EVALUATE))
    expect(first.evaluationState).toBe('read')
    expect(first.evaluation).toMatchObject({ evaluatedAt: at, rulesRevision: first.revision })
    expect(byId(first.evaluation!)['disk-space']).toMatchObject({ state: 'firing', firstFiredAt: at })
    clock.now = new Date(Date.parse(at) + 2 * HOUR).toISOString()
    const second = byId((await read(await call('POST', h, undefined, EVALUATE))).evaluation!)
    expect([second['disk-space']!.firstFiredAt, second.reboot!.firstFiredAt]).toEqual([at, at])
    const raised = await read(await put(h, first.revision, { 'disk-space': { threshold: 99 } }))
    clock.now = new Date(Date.parse(at) + 3 * HOUR).toISOString()
    const third = await read(await call('POST', h, undefined, EVALUATE))
    expect(byId(third.evaluation!)['disk-space']).toMatchObject({ state: 'ok', firstFiredAt: null, value: 96 })
    expect(byId(third.evaluation!).reboot!.firstFiredAt).toBe(at)
    await put(h, raised.revision, { 'disk-space': { threshold: 85 } })
    clock.now = new Date(Date.parse(at) + 4 * HOUR).toISOString()
    const fourth = await read(await call('POST', h, undefined, EVALUATE))
    expect(byId(fourth.evaluation!)['disk-space']!.firstFiredAt).toBe(clock.now)
    expect(await read(await call('GET', h))).toMatchObject({ evaluationState: 'read', evaluation: fourth.evaluation })
  })

  it('refuses evaluation without an agent, with unverifiable saved rules or an unverifiable health report, recording nothing', async () => {
    const { readHost: _readHost, ...offline } = setup().helpers
    await expect(call('POST', offline, undefined, EVALUATE)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const broken = setup({}, { rules: { rules: 'all' } })
    expect(await read(await call('GET', broken.helpers))).toMatchObject({ state: 'invalid', rules: [...DEFAULT_ALERT_RULES] })
    await expect(call('POST', broken.helpers, undefined, EVALUATE)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(broken.helpers.readHost).not.toHaveBeenCalled()
    const tampered = setup({ readHost: vi.fn(async () => ({ ...(await agentReport()), counts: { ok: 9, warning: 0, problem: 0, unavailable: 0 } })) })
    await expect(call('POST', tampered.helpers, undefined, EVALUATE)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    for (const { helpers } of [broken, tampered]) expect(helpers.writeState).not.toHaveBeenCalled()
  })

  it('reports an unverifiable last evaluation as invalid and does not carry it forward', async () => {
    const stale = evaluate(await observe(), {}, null, '2026-10-26T10:00:00.000Z')
    const { helpers: h } = setup({}, { state: { ...stale, results: stale.results.slice(1) } })
    expect(await read(await call('GET', h))).toMatchObject({ evaluationState: 'invalid', evaluation: null })
    expect(byId((await read(await call('POST', h, undefined, EVALUATE))).evaluation!)['disk-space']!.firstFiredAt).toBe(at)
    const carried = setup({}, { state: stale })
    expect(byId((await read(await call('POST', carried.helpers, undefined, EVALUATE))).evaluation!)['disk-space']!.firstFiredAt).toBe('2026-10-26T10:00:00.000Z')
  })

  it('reports writes that do not read back, or a failed audit, as requiring verification', async () => {
    const verify = { code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } }
    await expect(put(setup({ writeRules: vi.fn(async () => undefined) }).helpers, EMPTY)).rejects.toMatchObject(verify)
    await expect(put(setup({ emitAudit: vi.fn(async () => { throw new Error('down') }) }).helpers, EMPTY)).rejects.toMatchObject(verify)
    await expect(call('POST', setup({ writeState: vi.fn(async () => undefined) }).helpers, undefined, EVALUATE)).rejects.toMatchObject(verify)
  })
})
