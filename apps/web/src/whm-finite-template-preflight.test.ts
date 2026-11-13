// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { parseMarkup } from './html.ts'
import { assertWhmClientTemplates } from './whm-client-templates.ts'
import { classicWhmClientTemplates } from './board-port/whm-client-templates.ts'
import { v2WhmClientTemplates } from './themes/v2/whm-client-templates.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { renderWhmDeveloperWorkspace } from './board-port/whm-developer-workspace.ts'
import { renderWhmJobsWorkspace } from './board-port/whm-jobs-workspace.ts'
import { renderWhmMailServerWorkspace } from './board-port/whm-mail-server-workspace.ts'
import { renderWhmMailQueueWorkspace } from './board-port/whm-mail-queue-workspace.ts'
import { renderWhmMailQualityWorkspace } from './board-port/whm-mail-quality-workspace.ts'
import { renderWhmMailDelivery } from './board-port/whm-mail-log-workspace.ts'
import { renderWhmPanelNotificationsWorkspace } from './board-port/whm-panel-notifications-workspace.ts'
import { renderWhmPanelTokensWorkspace } from './board-port/whm-panel-tokens-workspace.ts'
import { renderWhmMailboxMaintenanceWorkspace } from './board-port/whm-mailbox-maintenance-workspace.ts'
import { renderWhmMonitoringProcesses } from './board-port/whm-monitoring-workspace.ts'
import { renderWhmSupportWorkspace } from './board-port/whm-support-workspace.ts'
import { renderV2WhmDeveloper } from './themes/v2/pages/xwhm/panel/integrations-developer.ts'
import { renderV2WhmJobs } from './themes/v2/pages/xwhm/activity/jobs.ts'
import { renderV2WhmMailServer, renderV2WhmMailQueue, renderV2WhmMailQuality, renderV2WhmMailLog, renderV2WhmMailboxMaintenance } from './themes/v2/pages/xwhm/mail/index.ts'
import { renderV2WhmNotifications } from './themes/v2/pages/xwhm/panel/notifications.ts'
import { renderV2WhmPanelData } from './themes/v2/pages/xwhm/panel/data.ts'
import { renderV2WhmPanelTokens } from './themes/v2/pages/xwhm/panel/tokens.ts'
import { renderV2WhmProcesses } from './themes/v2/pages/xwhm/monitoring/snapshots.ts'
import { renderV2WhmSupport } from './themes/v2/pages/xwhm/activity/support.ts'
import { WHM_DEVELOPER_CLIENT_BINDING } from './whm-developer-client.ts'
import { WHM_JOBS_CLIENT_BINDING } from './whm-jobs-client.ts'
import { WHM_MAIL_SERVER_CLIENT_BINDING } from './whm-mail-server-client.ts'
import { WHM_MAIL_QUEUE_CLIENT_BINDING } from './whm-mail-queue-client.ts'
import { WHM_MAIL_QUALITY_CLIENT_BINDING } from './whm-mail-quality-client.ts'
import { WHM_MAIL_LOG_CLIENT_BINDING } from './whm-mail-log-client.ts'
import { WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING } from './whm-panel-notifications-client.ts'
import { WHM_PANEL_DATA_CLIENT_BINDING } from './whm-panel-data-client.ts'
import { WHM_PANEL_TOKENS_CLIENT_BINDING } from './whm-panel-tokens-client.ts'
import { WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING } from './whm-mailbox-maintenance-client.ts'
import { WHM_MONITORING_CLIENT_BINDING } from './whm-monitoring-client.ts'
import { WHM_SUPPORT_CLIENT_BINDING } from './whm-support-client.ts'

type Theme = 'classic' | 'v2'
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Fault = 'missing' | 'duplicate' | 'wrong-root' | 'missing-slot' | 'wrong-slot-tag'
interface Workspace {
  readonly name: string
  readonly family: string
  readonly selector: string
  readonly binding: string
  readonly render: (theme: Theme) => string
}
let environment: EnvironmentReturn | undefined
const renderedWorkspaceHtml = new Map<string, string>()
const mountedHolders = new Map<string, HTMLDivElement>()
const compiledBindings = new Map<string, (ask: (options: Record<string, unknown>) => Promise<unknown>) => void>()
beforeAll(async () => {
  environment = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test/whm', runScripts: 'outside-only' } })
})
afterAll(async () => {
  mountedHolders.clear()
  compiledBindings.clear()
  await environment?.teardown(globalThis)
  environment = undefined
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  document.body.replaceChildren()
  delete (window as Window & { xpT?: unknown }).xpT
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const settle = async () => { for (let step = 0; step < 24; step++) await Promise.resolve() }
const t = translator('en')
const authority = { canRead: true, canManage: true }
const operatorProps = { locale: 'en' as const, principal: { kind: 'root' as const, id: 'fixture-root', username: 'operator' } }
const rawWorkspaces: readonly Workspace[] = [
  { name: 'developer', family: 'developer', selector: "[data-developer-workspace]", binding: WHM_DEVELOPER_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmDeveloperWorkspace({ locale: 'en', canRead: true, surface: 'administrator' }) : renderV2WhmDeveloper(t, operatorProps, authority) },
  { name: 'jobs', family: 'jobs', selector: "[data-whm-jobs-workspace]", binding: WHM_JOBS_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmJobsWorkspace({ locale: 'en', canRead: true, canManage: true }) : renderV2WhmJobs({ ...operatorProps, observationAuthority: authority }) },
  { name: 'mail-server', family: 'mail-server', selector: "[data-whm-mail-server-workspace]", binding: WHM_MAIL_SERVER_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmMailServerWorkspace({ locale: 'en', page: 'routing', canRead: true, canManage: true }) : renderV2WhmMailServer({ ...operatorProps, mailAuthority: authority }, 'routing') },
  { name: 'mail-queue', family: 'mail-queue', selector: "[data-whm-mail-queue-workspace]", binding: WHM_MAIL_QUEUE_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmMailQueueWorkspace({ locale: 'en', canRead: true, canManage: true }) : renderV2WhmMailQueue({ ...operatorProps, mailAuthority: authority }) },
  { name: 'mail-quality', family: 'mail-quality', selector: "[data-whm-mail-quality-workspace]", binding: WHM_MAIL_QUALITY_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmMailQualityWorkspace({ locale: 'en', canRead: true }) : renderV2WhmMailQuality({ ...operatorProps, mailAuthority: authority }) },
  { name: 'mail-log', family: 'mail-log', selector: "[data-whm-mail-log]", binding: WHM_MAIL_LOG_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmMailDelivery({ locale: 'en', canRead: true }) : renderV2WhmMailLog({ ...operatorProps, mailAuthority: authority }, 'delivery') },
  { name: 'panel-notifications', family: 'notifications', selector: "[data-whm-panel-notifications-workspace]", binding: WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmPanelNotificationsWorkspace({ locale: 'en', canManage: true }) : renderV2WhmNotifications(t, operatorProps, authority) },
  { name: 'panel-data', family: 'panel-data', selector: "[data-whm-generations]", binding: WHM_PANEL_DATA_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmSurface({ ...operatorProps, activeRoute: '/whm/panel/data', generationId: 9 }) : renderV2WhmPanelData(t, { ...operatorProps, activeRoute: '/whm/panel/data', generationId: 9 }, authority) },
  { name: 'panel-tokens', family: 'tokens', selector: "[data-whm-panel-tokens-workspace]", binding: WHM_PANEL_TOKENS_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmPanelTokensWorkspace({ locale: 'en', canManage: true }) : renderV2WhmPanelTokens(t, operatorProps, authority) },
  { name: 'mailbox-maintenance', family: 'mailbox-maintenance', selector: "[data-whm-mailbox-maintenance-workspace]", binding: WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmMailboxMaintenanceWorkspace({ locale: 'en', canRead: true, canManage: true }) : renderV2WhmMailboxMaintenance({ ...operatorProps, mailAuthority: authority }) },
  { name: 'monitoring', family: 'processes', selector: "[data-whm-monitoring]", binding: WHM_MONITORING_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmMonitoringProcesses({ locale: 'en', canRead: true, canSignal: true }) : renderV2WhmProcesses({ ...operatorProps, observationAuthority: authority }) },
  { name: 'support', family: 'support', selector: "[data-whm-support-workspace]", binding: WHM_SUPPORT_CLIENT_BINDING, render: theme => theme === 'classic' ? renderWhmSupportWorkspace({ locale: 'en', canRead: true }) : renderV2WhmSupport({ ...operatorProps, observationAuthority: authority }) },
]
const workspaces: readonly Workspace[] = rawWorkspaces.map(entry => ({
  ...entry,
  render: (theme: Theme): string => {
    const key = `${entry.name}:${theme}`
    let html = renderedWorkspaceHtml.get(key)
    if (html === undefined) {
      html = entry.render(theme)
      renderedWorkspaceHtml.set(key, html)
    }
    return html
  },
}))
const templates = (theme: Theme, family: string): string => (theme === 'classic' ? classicWhmClientTemplates : v2WhmClientTemplates)(family)
const names = (theme: Theme, family: string): string[] => parseMarkup(templates(theme, family))
  .filter(node => node.tag === 'template').map(node => node.attrs.get('data-xp-template')!)
const mount = (entry: Workspace, html: string): HTMLElement => {
  document.documentElement.lang = 'en'
  let holder = mountedHolders.get(html)
  if (!holder) {
    holder = document.createElement('div')
    holder.innerHTML = '<section data-capability-state="authorized">' + html + '</section>'
    mountedHolders.set(html, holder)
  }
  document.body.replaceChildren(...Array.from(holder.childNodes, node => node.cloneNode(true)))
  const root = document.querySelector<HTMLElement>(entry.selector)
  expect(root).not.toBeNull()
  return root!
}
const boot = (entry: Workspace, request: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true): void => {
  Object.assign(window, { xpT: t, xpanelSessionRequest: request })
  let invoke = compiledBindings.get(entry.name)
  if (!invoke) {
    invoke = (window as unknown as { Function: FunctionConstructor }).Function('return ' + entry.binding)() as (ask: (options: Record<string, unknown>) => Promise<unknown>) => void
    compiledBindings.set(entry.name, invoke)
  }
  invoke(ask)
}
const damage = (root: HTMLElement, name: string, fault: Fault): void => {
  const template = root.querySelector<HTMLTemplateElement>('template[data-xp-template="' + name + '"]')
  expect(template).not.toBeNull()
  const element = template!.content.firstElementChild as HTMLElement
  if (fault === 'missing') { template!.remove(); return }
  if (fault === 'duplicate') { template!.after(template!.cloneNode(true)); return }
  if (fault === 'wrong-root') {
    const wrong = document.createElement(element.tagName === 'DIV' ? 'section' : 'div')
    wrong.replaceChildren(...element.childNodes)
    template!.content.replaceChildren(wrong)
    return
  }
  const slot = template!.content.querySelector<HTMLElement>('[data-xp-slot]')
  expect(slot).not.toBeNull()
  if (fault === 'missing-slot') { slot!.removeAttribute('data-xp-slot'); return }
  const wrong = document.createElement('em')
  wrong.setAttribute('data-xp-slot', slot!.getAttribute('data-xp-slot')!)
  if (slot === element) { slot!.removeAttribute('data-xp-slot'); slot!.append(wrong) }
  else { wrong.replaceChildren(...slot!.childNodes); slot!.replaceWith(wrong) }
}

describe('finite selected-theme WHM preflight', { tags: ['feature'] }, () => {
  describe.each(['classic', 'v2'] as const)('%s finite WHM template contracts', theme => {
    const detachedCases = [
      ['developer', [['whm-developer-field', 'div', { label: 'dt', value: 'dd' }]]],
      ['panel-data', [['whm-generation-empty', 'tr', { content: 'td' }]]],
      ['jobs', [['whm-jobs-progress-other', 'div', { track: 'div', fill: 'span', content: 'bdi' }]]],
    ] as const
    it.each(detachedCases)('validates %s mixed slot types without editing live controls', (family, contract) => {
      const root = document.createElement('section')
      root.innerHTML = templates(theme, family)
      const original = root.innerHTML
      assertWhmClientTemplates(root, contract)
      expect(root.innerHTML).toBe(original)
    })
    it('rejects empty, repeated and undeclared contracts without weakening slot validation', () => {
      const root = document.createElement('section')
      root.innerHTML = templates(theme, 'developer')
      const contract = ['whm-developer-field', 'div', { label: 'dt', value: 'dd' }] as const
      expect(() => assertWhmClientTemplates(root, [])).toThrow()
      expect(() => assertWhmClientTemplates(root, [contract, contract])).toThrow()
      const template = root.querySelector('template')!
      const extra = document.createElement('span')
      extra.setAttribute('data-xp-slot', 'unreviewed')
      template.content.firstElementChild!.append(extra)
      expect(() => assertWhmClientTemplates(root, [contract])).toThrow()
    })

    it('revalidates the complete generation contract after confirmation and before a new effect', async () => {
      const entry = workspaces.find(item => item.name === 'panel-data')!
      const root = mount(entry, entry.render(theme))
      const at = '2026-10-29T12:00:00.000Z'
      const active = { id: 9, createdAt: at, status: 'active', checksum: 'a'.repeat(64) }
      const target = { id: 7, createdAt: at, status: 'superseded', checksum: 'b'.repeat(64) }
      const request = vi.fn<Send>(async () => ({
        generations: [active, target], currentGeneration: active,
        desiredState: { revision: 20, checksum: 'c'.repeat(64), pending: false },
        canRollback: true, rollbackEligibleGenerationIds: [7],
      }))
      const ask = vi.fn(async () => '7')
      boot(entry, request, ask)
      await settle()
      const rollback = root.querySelector<HTMLButtonElement>('[data-action="rollback-generation"][data-generation-id="7"]')
      expect(rollback).not.toBeNull()
      expect(rollback!.disabled).toBe(false)
      damage(root, 'whm-generation-current-none', 'missing')
      rollback!.click()
      await settle()
      expect(ask).toHaveBeenCalledOnce()
      expect(request.mock.calls).toEqual([['GET', '/api/generations']])
      expect(rollback!.disabled).toBe(true)
      rollback!.disabled = false
      rollback!.click()
      await settle()
      expect(ask).toHaveBeenCalledOnce()
      expect(request.mock.calls).toEqual([['GET', '/api/generations']])
    })

    for (const entry of workspaces) {
      it.each(names(theme, entry.family))('rejects malformed ' + entry.name + ' %s before any transport', name => {
        const html = entry.render(theme)
        const validRequest = vi.fn<Send>(() => new Promise<never>(() => {}))
        mount(entry, html); boot(entry, validRequest)
        expect(validRequest.mock.calls.some(([method]) => method === 'GET')).toBe(true)
        for (const fault of ['missing', 'duplicate', 'wrong-root', 'missing-slot', 'wrong-slot-tag'] as const) {
          const root = mount(entry, html)
          damage(root, name, fault)
          const request = vi.fn<Send>(() => new Promise<never>(() => {}))
          expect(() => boot(entry, request)).not.toThrow()
          expect(request, fault).not.toHaveBeenCalled()
          expect([...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')].every(control => control.disabled), fault).toBe(true)
        }
      })
      it('fails closed if ' + entry.name + ' loses a template while its read is pending', async () => {
        const html = entry.render(theme), root = mount(entry, html)
        let complete!: (value: unknown) => void
        const request = vi.fn<Send>(() => new Promise(resolve => { complete = resolve }))
        boot(entry, request)
        expect(request.mock.calls.some(([method]) => method === 'GET')).toBe(true)
        damage(root, names(theme, entry.family)[0]!, 'missing')
        complete({})
        await settle()
        expect([...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')].every(control => control.disabled)).toBe(true)
        expect(request.mock.calls.some(([method]) => method !== 'GET')).toBe(false)
        expect(request.mock.calls).toHaveLength(1)
      })
    }
  })
})
