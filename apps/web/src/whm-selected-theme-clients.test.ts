// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { renderWhmJobsWorkspace } from './board-port/whm-jobs-workspace.ts'
import { renderWhmMailQueueWorkspace } from './board-port/whm-mail-queue-workspace.ts'
import { renderV2WhmJobs } from './themes/v2/pages/xwhm/activity/jobs.ts'
import { renderV2WhmPanelData } from './themes/v2/pages/xwhm/panel/data.ts'
import { renderV2WhmMailPage } from './themes/v2/pages/xwhm/mail/index.ts'
import { classicWhmClientTemplates } from './themes/classic/whm-client-templates.ts'
import { v2WhmClientTemplates } from './themes/v2/whm-client-templates.ts'
import { WHM_CLIENT_TEMPLATE_BINDING } from './whm-client-templates.ts'
import { WHM_PANEL_DATA_CLIENT_BINDING } from './whm-panel-data-client.ts'
import { WHM_JOBS_CLIENT_BINDING } from './whm-jobs-client.ts'
import { WHM_MAIL_QUEUE_CLIENT_BINDING } from './whm-mail-queue-client.ts'

type Theme = 'classic' | 'v2'
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type TestDom = { window: Window & typeof globalThis }
let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test/whm', runScripts: 'outside-only' } })
})
const mount = (html: string): TestDom => {
  document.documentElement.lang = 'en'
  document.body.innerHTML = html
  return { window }
}
const tick = async () => { for (let step = 0; step < 8; step++) await new Promise(resolve => setTimeout(resolve, 0)) }
const node = <T extends Element = HTMLElement>(dom: TestDom, selector: string): T => {
  const result = dom.window.document.querySelector<T>(selector)
  if (!result) throw new Error(`Missing ${selector}`)
  return result
}
function boot(html: string, binding: string, send: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true): TestDom {
  const dom = mount(html)
  Object.assign(dom.window, { xpT: translator('en'), xpanelSessionRequest: send })
  dom.window.eval(binding)(ask)
  return dom
}
afterEach(async () => {
  try {
    document.body.replaceChildren()
    delete (window as Window & { xpT?: unknown }).xpT
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    vi.restoreAllMocks()
  } finally { await testDom?.teardown(globalThis); testDom = undefined }
})

const at = '2026-10-29T12:00:00.000Z', id = '0f3c2a64-8b1d-4c2e-9a7f-5d6e7f8a9b0c'
const job = { id, referenceCode: 'XP-JOB-2026-000123', kind: 'system.packages.upgrade', status: 'running', progress: 50, summary: 'Upgrade 2 packages', actor: 'root', accountId: null,
  createdAt: at, startedAt: at, finishedAt: null, steps: [{ id: 'refresh', title: 'Refresh package lists', state: 'succeeded', exitCode: 0 }],
  error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 4 }

describe.each(['classic', 'v2'] as const)('selected WHM %s controller templates', theme => {
  it('updates named generation slots and the visible current label through a verified rollback', async () => {
    const principal = { kind: 'root' as const, id: 'fixture-root', username: 'operator' }
    const props = { locale: 'en' as const, activeRoute: '/whm/panel/data', generationId: 9, principal }
    const html = theme === 'classic' ? renderWhmSurface(props) : renderV2WhmPanelData(translator('en'), props, { canRead: true, canManage: true })
    const active = { id: 9, createdAt: at, status: 'active', checksum: 'a'.repeat(64) }, target = { id: 7, createdAt: at, status: 'superseded', checksum: 'b'.repeat(64) }
    const restored = { id: 10, createdAt: at, status: 'active', checksum: target.checksum }
    let wrote = false
    const send = vi.fn<Send>(async method => {
      if (method === 'POST') { wrote = true; return { status: 'applied', rollbackTargetGenerationId: 7, rollbackTargetChecksum: target.checksum, generation: restored } }
      return { generations: wrote ? [restored, { ...active, status: 'superseded' }, target] : [active, target], currentGeneration: wrote ? restored : active,
        desiredState: { revision: wrote ? 21 : 20, checksum: (wrote ? 'd' : 'c').repeat(64), pending: false }, canRollback: true, rollbackEligibleGenerationIds: wrote ? [9, 7] : [7] }
    })
    const dom = boot(html, WHM_PANEL_DATA_CLIENT_BINDING, send, async () => '7'); await tick()
    const rows = dom.window.document.querySelectorAll('[data-generation-row]')
    expect(rows).toHaveLength(2)
    expect(node(dom, '[data-generation-row="7"] [data-xp-slot="generation"]').textContent).toBe('#7')
    expect(node(dom, '[data-generations-current-label]').textContent).toBe('Generation 9')
    node<HTMLButtonElement>(dom, '[data-action="rollback-generation"][data-generation-id="7"]').click(); await tick()
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/generations'], ['GET', '/api/generations'], ['POST', '/api/generations/7/rollback'], ['GET', '/api/generations']])
    expect(node(dom, '[data-generations-current-label]').textContent).toBe('Generation 10')
    expect(node(dom, '[data-generations-status]').getAttribute('data-state')).toBe('restored')
    if (theme === 'v2') expect(node(dom, '[data-generation-row="10"]').querySelector('[class*="xp-"]')).toBeNull()
  })

  it('keeps job list, selected details and log readable without cancellation authority', async () => {
    for (const missing of [false, true]) {
      const html = theme === 'classic' ? renderWhmJobsWorkspace({ locale: 'en', canRead: true, canManage: false })
        : renderV2WhmJobs({ locale: 'en', observationAuthority: { canRead: true, canManage: false } })
      const send = vi.fn<Send>(async (_method, path) => path.startsWith('/api/jobs?') ? { jobs: [job] } : path.includes('/log')
        ? { id, available: true, offset: 0, nextOffset: 4, total: 4, truncated: false, text: 'read' } : { job })
      const ask = vi.fn(async () => true)
      const dom = boot(html, WHM_JOBS_CLIENT_BINDING, send, ask)
      if (missing) node(dom, '[data-whm-jobs-workspace]').removeAttribute('data-jobs-can-manage')
      await tick(); node<HTMLButtonElement>(dom, `[data-whm-jobs-select="${id}"]`).click(); await tick()
      expect(node(dom, '[data-whm-jobs-log]').textContent).toBe('read')
      expect(node(dom, '[data-whm-jobs-field="reference"]').textContent).toBe('XP-JOB-2026-000123')
      expect(node(dom, '[data-whm-jobs-field="progress"] [role="progressbar"]').getAttribute('aria-valuenow')).toBe('50')
      const cancel = node<HTMLButtonElement>(dom, '[data-whm-jobs-cancel]')
      expect(cancel.disabled).toBe(true)
      cancel.disabled = false; cancel.click(); await tick()
      expect(ask).not.toHaveBeenCalled()
      expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
      expect(node(dom, '#whm-jobs-detail')).toBeTruthy()
      if (theme === 'v2') expect(node(dom, '[data-whm-jobs-field="status"]').querySelector('[class*="xp-"]')).toBeNull()
    }
  })

  it('clears a stale server-rendered generation label when a fresh read has no active generation', async () => {
    const props = { locale: 'en' as const, activeRoute: '/whm/panel/data', generationId: 9, principal: { kind: 'root' as const, id: 'fixture-root', username: 'operator' } }
    const html = theme === 'classic' ? renderWhmSurface(props) : renderV2WhmPanelData(translator('en'), props, { canRead: true, canManage: true })
    const send = vi.fn<Send>(async () => ({ generations: [], currentGeneration: null, desiredState: null, canRollback: false, rollbackEligibleGenerationIds: [] }))
    const dom = boot(html, WHM_PANEL_DATA_CLIENT_BINDING, send); await tick()
    expect(node(dom, '[data-generations-current-label]').textContent).toBe('No configuration generation is active')
    expect(node(dom, '[data-generations-current] [data-state="none"]').matches('.xp-badge--ok,.v2-pill--ok')).toBe(false)
    expect(node(dom, '[data-generation-rows]').textContent).toContain('The generation read returned no records.')
    expect(send.mock.calls).toEqual([['GET', '/api/generations']])
  })

  it('clones queue cells and action controls without altering fresh revision guards', async () => {
    const html = theme === 'classic' ? `<section data-capability-state="authorized">${renderWhmMailQueueWorkspace({ locale: 'en', canRead: true, canManage: false })}</section>`
      : renderV2WhmMailPage({ locale: 'en', activeRoute: '/whm/email/queue', mailAuthority: { canRead: true, canManage: false } })!
    const message = { queueId: '4F2A1B3C9D', queue: 'deferred', arrivalTime: at, sizeBytes: 2048, sender: 'sender@example.test', recipients: [{ address: 'recipient@example.test', delayReason: 'Not connected' }], recipientCount: 1, forcedExpire: false }
    const send = vi.fn<Send>(async () => ({ state: 'read', observedAt: at, revision: 'c'.repeat(64), truncated: false, counts: { maildrop: 0, incoming: 0, active: 0, deferred: 1, hold: 0 }, messages: [message] }))
    const dom = boot(html, WHM_MAIL_QUEUE_CLIENT_BINDING, send); await tick()
    const row = node(dom, '[data-whm-mail-queue-rows] tr')
    expect(row.querySelectorAll('td')).toHaveLength(10)
    expect(row.querySelector('[data-xp-slot="reference"]')!.textContent).toBe(message.queueId)
    expect(row.querySelector('[data-xp-slot="sender"]')!.textContent).toBe(message.sender)
    const buttons = row.querySelectorAll<HTMLButtonElement>('[data-whm-mail-queue-row-action]')
    expect(buttons).toHaveLength(4)
    expect([...buttons].every(button => button.disabled)).toBe(true)
    expect(send.mock.calls).toEqual([['GET', '/api/server/mail-queue']])
    if (theme === 'v2') expect(row.querySelector('[class*="xp-"]')).toBeNull()
  })

  it('rejects missing or ambiguous workspace templates rather than using another theme', () => {
    const renderTemplates = theme === 'classic' ? classicWhmClientTemplates : v2WhmClientTemplates
    const dom = mount(`<div id="owner">${renderTemplates('mail-server')}</div><div id="other">${renderTemplates('mail-server')}</div>`)
    const clone = dom.window.eval(`(()=>{${WHM_CLIENT_TEMPLATE_BINDING}return root=>whmClientNode(root,'whm-mail-route-select','select');})()`)
    const owner = node(dom, '#owner'), other = node(dom, '#other')
    expect(clone(owner).tagName).toBe('SELECT')
    owner.replaceChildren()
    expect(() => clone(owner)).toThrow('client_template_unavailable')
    owner.append(other.firstElementChild!.cloneNode(true), other.firstElementChild!.cloneNode(true))
    expect(() => clone(owner)).toThrow('client_template_unavailable')
  })
})
