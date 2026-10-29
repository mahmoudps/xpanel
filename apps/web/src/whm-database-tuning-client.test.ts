// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DB_TUNING_STATUS, DB_TUNING_VARIABLES, WHM_DATABASE_TUNING_CLIENT_BINDING, bindWhmDatabaseTuning, readDatabaseTuningView } from './whm-database-tuning-client.ts'
import { renderWhmDatabaseTuningWorkspace } from './board-port/whm-database-tuning-workspace.ts'
import { buildDatabaseTuningView } from '../../agent/src/database-tuning.ts'
import type { DatabaseTuningStatus, DatabaseTuningVariables } from '../../agent/src/database-tuning.ts'

const reply = () => {
  const variables = Object.fromEntries(DB_TUNING_VARIABLES.map(name => [name, name === 'slow_query_log' ? 'OFF' : name === 'long_query_time' ? 0.5 : 128])) as DatabaseTuningVariables
  const status = Object.fromEntries(DB_TUNING_STATUS.map(name => [name, 12])) as DatabaseTuningStatus
  return buildDatabaseTuningView({ engine: 'mariadb', state: 'read', observedAt: '2026-10-27T03:00:00.000Z', version: '10.11.8-MariaDB', variables, status })
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const root = (): HTMLElement => document.querySelector<HTMLElement>('[data-whm-database-tuning]')!
const read = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-db-tuning-read]')!
const note = (): HTMLElement => document.querySelector<HTMLElement>('[data-db-tuning-status]')!
function mount(canRead = true, locale: 'en' | 'ar' = 'en'): HTMLElement { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = renderWhmDatabaseTuningWorkspace({ locale, canRead }); return root() }
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('database tuning workspace', () => {
  it('renders bilingual read-only sections, consistent spacing and no invented configuration controls', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmDatabaseTuningWorkspace({ locale, canRead: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).not.toContain('<form'); expect(html).not.toContain('<input'); expect(html).not.toContain('data-db-tuning-apply')
      expect(html).toContain('gap:32px'); expect(html).toContain('gap:24px'); expect(html).toContain('gap:16px'); expect(html).toContain('gap:8px')
    }
    expect(renderWhmDatabaseTuningWorkspace({ locale: 'ar', canRead: false })).toContain('data-db-tuning-read disabled')
  })

  it('reconstructs exact observed values and refuses malformed or unsupported claims', () => {
    expect(readDatabaseTuningView(reply()).variables?.long_query_time).toBe(0.5)
    const bad: unknown[] = []
    bad.push({ ...reply(), extra: 'secret' }, { ...reply(), state: 'ok' }, { ...reply(), capabilities: { apply: true } }, { ...reply(), observedAt: null })
    const negative = reply(); negative.status!.Uptime = -1; bad.push(negative)
    const zero = reply(); zero.variables!.max_connections = 0; bad.push(zero)
    const unknown = reply(); bad.push({ ...unknown, variables: { ...unknown.variables, path: '/private' } })
    const mismatch = reply(); mismatch.plan.checks[0]!.evidence[0]!.value = 999; bad.push(mismatch)
    const wrongId = reply(); wrongId.plan.checks[0]!.id = 'thread-cache'; bad.push(wrongId)
    const mixed = reply(); mixed.plan.checks[0]!.next = 'sample-thread-cache'; bad.push(mixed)
    for (const item of bad) expect(() => readDatabaseTuningView(clone(item))).toThrow('invalid_database_tuning_view')
  })

  it('reads on open and refreshes using only the fixed GET endpoint', async () => {
    const request = vi.fn(async (method: string, path: string) => { expect([method, path]).toEqual(['GET', '/api/server/databases/tuning']); return reply() })
    bindWhmDatabaseTuning(mount(), request); await settle()
    expect(request).toHaveBeenCalledTimes(1); expect(note().dataset.state).toBe('read')
    expect(document.querySelectorAll('[data-db-tuning-rows="variables"] tr')).toHaveLength(8)
    expect(document.querySelectorAll('[data-db-tuning-rows="status"] tr')).toHaveLength(17)
    expect(document.querySelectorAll('[data-db-tuning-plan] article')).toHaveLength(6)
    expect(document.querySelector('[data-db-tuning-fact="version"] bdi')?.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-db-tuning-fact="version"]')?.textContent).toBe('10.11.8-MariaDB')
    expect(root().textContent).toContain('No changes have been applied.')
    read().click(); await settle(); expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not fetch or revive controls for an unqualified page', async () => {
    const request = vi.fn(async () => reply())
    bindWhmDatabaseTuning(mount(false), request); await settle()
    expect(request).not.toHaveBeenCalled(); expect(read().disabled).toBe(true); expect(note().dataset.state).toBe('unavailable')
    mount(); root().setAttribute('data-capability-unavailable', 'true'); bindWhmDatabaseTuning(root(), request); await settle()
    expect(request).not.toHaveBeenCalled(); expect(read().disabled).toBe(true)
  })

  it('clears stale observations after an invalid refresh and exposes a retry', async () => {
    const request = vi.fn().mockResolvedValueOnce(reply()).mockResolvedValueOnce({ ...reply(), variables: { password: 'hidden' } })
    bindWhmDatabaseTuning(mount(), request); await settle(); read().click(); await settle()
    expect(note().dataset.state).toBe('failed'); expect(note().getAttribute('role')).toBe('alert'); expect(read().disabled).toBe(false)
    expect(document.querySelector('[data-db-tuning-fact="version"]')?.textContent).toBe('Not observed')
    expect(document.querySelectorAll('[data-db-tuning-plan] article')).toHaveLength(0); expect(root().textContent).not.toContain('hidden')
  })

  it('does not paint a reply after read authority is removed', async () => {
    let resolve!: (value: unknown) => void
    const request = vi.fn(() => new Promise<unknown>(done => { resolve = done }))
    bindWhmDatabaseTuning(mount(), request)
    root().dataset.canRead = 'false'; resolve(reply()); await settle()
    expect(document.querySelector('[data-db-tuning-fact="version"]')?.textContent).toBe('Not observed'); expect(read().disabled).toBe(true)
  })

  it('serializes all browser dependencies and preserves Arabic copy with LTR values', async () => {
    mount(true, 'ar')
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = async () => reply()
    ;(new Function('return ' + WHM_DATABASE_TUNING_CLIENT_BINDING)() as () => void)()
    await settle()
    expect(note().dataset.state).toBe('read'); expect(root().textContent).toContain('لم تتغير الإعدادات')
    expect(document.querySelector('[data-db-tuning-fact="version"] bdi')?.getAttribute('dir')).toBe('ltr')
    expect(root().textContent).not.toMatch(/[٠-٩۰-۹]/); expect(WHM_DATABASE_TUNING_CLIENT_BINDING).not.toContain('innerHTML')
  })
})

describe('readable date closure database tuning', () => {
  for (const locale of ['en', 'ar'] as const) it('formats observed metadata without changing numeric counters or version in ' + locale, async () => {
    const source = reply(); source.observedAt = '2026-10-27T09:01:02.000Z'; const before = JSON.stringify(source), send = vi.fn(async () => source)
    mount(true, locale); Object.assign(window, { xpanelSessionRequest: send }); new Function('return ' + WHM_DATABASE_TUNING_CLIENT_BINDING)()(); await settle()
    const observed = document.querySelector('[data-db-tuning-fact="observedAt"] bdi')!
    expect(observed.textContent).toBe('2026-10-27 09:01 UTC'); expect(observed.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-db-tuning-fact="version"]')?.textContent).toBe('10.11.8-MariaDB')
    for (const name of ['Uptime', 'Uptime_since_flush_status']) expect(document.querySelector('[data-db-tuning-fact="' + name + '"]')?.textContent).toBe('12')
    expect(document.querySelector('[data-db-tuning-rows="variables"]')?.textContent).toContain('0.5')
    expect(JSON.stringify(source)).toBe(before); expect(readDatabaseTuningView(source).observedAt).toBe('2026-10-27T09:01:02.000Z')
    expect(send.mock.calls).toEqual([['GET', '/api/server/databases/tuning']]); expect(root().textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})