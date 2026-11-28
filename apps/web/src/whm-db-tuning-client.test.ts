// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDatabaseTuningView } from '../../agent/src/database-tuning.ts'
import type { DatabaseTuningStatus, DatabaseTuningVariables } from '../../agent/src/database-tuning.ts'
import { frameRequest } from './read-only-frame.ts'
import { renderV2WhmDatabasePage } from './themes/v2/pages/xwhm/databases/index.ts'
import { DB_TUNING_STATUS, DB_TUNING_VARIABLES, WHM_DB_TUNING_CLIENT_BINDING, bindWhmDbTuning, readDbTuningView } from './whm-db-tuning-client.ts'

const reply = (rollbackAvailable = false, content: string | null = null) => {
  const variables: DatabaseTuningVariables = {
    innodb_buffer_pool_size: 134_217_728,
    max_connections: 151,
    tmp_table_size: 16_777_216,
    max_heap_table_size: 16_777_216,
    table_open_cache: 2000,
    thread_cache_size: 151,
    slow_query_log: 'OFF',
    long_query_time: 0.5,
  }
  const status = Object.fromEntries(DB_TUNING_STATUS.map(name => [name, 12])) as DatabaseTuningStatus
  return buildDatabaseTuningView(
    { engine: 'mariadb', state: 'read', observedAt: '2026-10-27T03:00:00.000Z', version: '10.11.8-MariaDB', variables, status },
    { path: '/etc/mysql/mariadb.conf.d/90-xpanel-tuning.cnf', present: content !== null, revision: content ? 'b'.repeat(64) : 'a'.repeat(64), content, rollbackAvailable },
  )
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const root = (): HTMLElement => document.querySelector<HTMLElement>('[data-whm-database-tuning]')!
const readBtn = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-db-tuning-read]')!
const note = (): HTMLElement => document.querySelector<HTMLElement>('[data-db-tuning-status]')!
const actionNote = (): HTMLElement => document.querySelector<HTMLElement>('[data-db-tuning-action-status]')!

function mount(canRead = true, canManage = true, locale: 'en' | 'ar' = 'en'): HTMLElement {
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderV2WhmDatabasePage({ locale, activeRoute: '/whm/databases/tuning', dataAuthority: { canRead, canManage } })!
  return root()
}

afterEach(() => {
  document.documentElement.lang = 'en'
  document.documentElement.dir = 'ltr'
  document.body.replaceChildren()
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('WHM database tuning client', () => {
  it('reads observations, validates bounds and refuses forged views', async () => {
    const view = reply()
    expect(readDbTuningView(view).capabilities.apply).toBe(true)
    expect(() => readDbTuningView({ ...view, capabilities: { apply: false } })).toThrow()
    expect(() => readDbTuningView({ ...view, dropIn: { ...view.dropIn, revision: 'bad' } })).toThrow()

    const request = vi.fn(async () => view)
    bindWhmDbTuning(mount(), request, async () => true)
    await settle()
    expect(request).toHaveBeenCalledWith('GET', '/api/server/databases/tuning')
    expect(note().dataset.state).toBe('read')
    expect(document.querySelector('[data-db-tuning-fact="version"] bdi')?.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-db-tuning-fact="dropinPath"]')?.textContent).toBe('/etc/mysql/mariadb.conf.d/90-xpanel-tuning.cnf')
    expect(document.querySelector<HTMLButtonElement>('[data-db-tuning-rollback]')!.disabled).toBe(true)

    const maxConn = document.querySelector<HTMLInputElement>('[data-db-tuning-input="max_connections"]')!
    maxConn.value = '5'
    document.querySelector<HTMLButtonElement>('[data-db-tuning-preview]')!.click()
    await settle()
    expect(actionNote().dataset.state).toBe('failed')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('previews drop-in diff, confirms apply and rolls back via API', async () => {
    const initial = reply(false, null)
    const afterApply = reply(true, '[mysqld]\nmax_connections = 250\n')
    let applied = false
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return applied ? afterApply : initial
      if (path === '/api/server/databases/tuning/preview') {
        return {
          path: initial.dropIn.path,
          currentRevision: initial.dropIn.revision,
          currentContent: null,
          proposedContent: '[mysqld]\nmax_connections = 250\n',
          diff: '+ max_connections = 250',
          changed: true,
          rollbackAvailable: false,
        }
      }
      if (path === '/api/server/databases/tuning/apply') {
        applied = true
        return { applied: true, body }
      }
      if (path === '/api/server/databases/tuning/rollback') {
        applied = false
        return { rolledBack: true }
      }
      throw new Error('unexpected')
    })
    const ask = vi.fn(async () => true)
    bindWhmDbTuning(mount(), request, ask)
    await settle()

    const maxConn = document.querySelector<HTMLInputElement>('[data-db-tuning-input="max_connections"]')!
    maxConn.value = '250'
    document.querySelector<HTMLButtonElement>('[data-db-tuning-preview]')!.click()
    await settle()
    expect(document.querySelector('[data-db-tuning-diff]')!.textContent).toContain('+ max_connections = 250')

    document.querySelector<HTMLButtonElement>('[data-db-tuning-apply]')!.click()
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('POST', '/api/server/databases/tuning/apply', expect.objectContaining({ expectedRevision: initial.dropIn.revision }))
    expect(document.querySelector<HTMLButtonElement>('[data-db-tuning-rollback]')!.disabled).toBe(false)

    document.querySelector<HTMLButtonElement>('[data-db-tuning-rollback]')!.click()
    await settle()
    expect(ask).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith('POST', '/api/server/databases/tuning/rollback', { expectedRevision: afterApply.dropIn.revision })
    expect(document.querySelector<HTMLButtonElement>('[data-db-tuning-rollback]')!.disabled).toBe(true)
  })

  it('stays read-only without manage authority or inside a read-only frame and executes serialized binding in Arabic', async () => {
    const request = vi.fn(async () => reply())
    bindWhmDbTuning(mount(true, false), request)
    await settle()
    expect(document.querySelector<HTMLButtonElement>('[data-db-tuning-apply]')!.disabled).toBe(true)

    mount(true, true, 'ar')
    root().setAttribute('data-capability-unavailable', 'true')
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    bindWhmDbTuning(root(), frameRequest(root()))
    await settle()
    expect(readBtn().disabled).toBe(true)

    mount(true, true, 'ar')
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = async () => reply()
    ;(new Function('return ' + WHM_DB_TUNING_CLIENT_BINDING)() as () => void)()
    await settle()
    expect(note().dataset.state).toBe('read')
    expect(WHM_DB_TUNING_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_DB_TUNING_CLIENT_BINDING).not.toMatch(/Not read|Not observed/)
  })
})
