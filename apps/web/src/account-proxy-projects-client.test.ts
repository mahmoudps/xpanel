// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_PROXY_PROJECTS_CLIENT_BINDING,
  parseProxyProjectsResponse,
  parseSiteProxyRulesResponse,
  proxyTargetDraftProblem,
} from './account-proxy-projects-client.ts'
import { renderV2ReverseProxyPage } from './themes/v2/pages/xpanel/domains/reverse-proxy.ts'
import { fixtureAccount, renderPanelRoute } from '../../../tests/fixtures/workspace-route-render.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const home = '/home/alice'
const domainId = '22222222-2222-4222-8222-222222222222'
const projectId = '33333333-3333-4333-8333-333333333333'
const ruleId = '44444444-4444-4444-8444-444444444444'
const rev1 = 'a'.repeat(64)
const rev2 = 'b'.repeat(64)

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

const pageHtml = (locale: 'en' | 'ar' = 'en', canManage = true) =>
  renderPanelRoute('/domains/reverse-proxy', { locale, account: fixtureAccount({ id: accountId, home }), canManage })

function mountClient(
  html: string,
  request?: (method: string, path: string, body?: unknown) => Promise<unknown>,
  confirm: unknown = async () => true,
) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  ;(new Function('return ' + ACCOUNT_PROXY_PROJECTS_CLIENT_BINDING)() as (ask: unknown) => void)(confirm)
}

afterEach(() => {
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('account proxy projects and path-scoped rules client', () => {
  it('validates target drafts and rejects unsafe responses in parsers', () => {
    expect(proxyTargetDraftProblem('http://127.0.0.1:3000')).toBeNull()
    expect(proxyTargetDraftProblem('https://203.0.113.20:9443')).toBeNull()
    expect(proxyTargetDraftProblem('ftp://203.0.113.20')).toBe('invalid')
    expect(proxyTargetDraftProblem('http://203.0.113.20/path')).toBe('invalid')

    expect(() => parseSiteProxyRulesResponse({
      state: 'saved',
      revision: rev1,
      limit: 64,
      domains: [{ id: domainId, name: '<script>x</script>', kind: 'primary', siteType: 'php', blocked: null }],
      rules: [],
    })).toThrow()

    expect(() => parseProxyProjectsResponse({
      state: 'saved',
      revision: rev1,
      limit: 32,
      projects: [{ id: projectId, accountId, name: '<img src=x>', domains: ['a.example'], note: '', ssl: { enabled: false, certificateId: null }, cache: true, gzip: true, rules: [] }],
    })).toThrow()

    expect(ACCOUNT_PROXY_PROJECTS_CLIENT_BINDING).not.toContain('innerHTML')
  })

  it('adds and removes path-scoped site proxy rules and maps SSRF refusals cleanly', async () => {
    let rulesState = {
      state: 'default',
      revision: rev1,
      limit: 64,
      runtimePorts: [3000],
      domains: [{ id: domainId, name: 'alice.example.test', kind: 'primary', siteType: 'php', blocked: null }],
      rules: [] as unknown[],
    }
    const projectsState = { state: 'default', revision: rev1, limit: 32, runtimePorts: [3000], projects: [] }
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path.startsWith('/api/account/proxy-projects')) return projectsState
      if (method === 'GET') return rulesState
      if (method === 'POST') {
        const payload = body as { path: string; target: string }
        if (payload.target === 'http://10.0.0.5:9000') {
          throw Object.assign(new Error('refused'), { status: 400, details: { stateChanged: false, reason: 'INVALID_TARGET', fields: [{ field: 'target', code: 'private_address' }] } })
        }
        rulesState = {
          ...rulesState,
          state: 'saved',
          revision: rev2,
          rules: [{ domainId, domain: 'alice.example.test', path: payload.path, target: payload.target, websocket: true, hostHeader: 'client', refusal: null }],
        }
        return rulesState
      }
      rulesState = { ...rulesState, revision: rev1, rules: [] }
      return rulesState
    })

    mountClient(pageHtml(), send)
    await tick()

    expect($('[data-spr-status]').getAttribute('data-state')).toBe('read')
    $<HTMLInputElement>('[data-spr-path]').value = '/api/'
    $<HTMLInputElement>('[data-spr-target]').value = 'http://10.0.0.5:9000'
    $<HTMLButtonElement>('[data-spr-add]').click()
    await tick()
    expect($('[data-spr-status]').getAttribute('data-state')).toBe('fields')
    expect($('[data-spr-error]').textContent).toContain('Private network IP addresses')

    $<HTMLInputElement>('[data-spr-target]').value = 'http://127.0.0.1:3000'
    $<HTMLButtonElement>('[data-spr-add]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/domains/proxy-rules', {
      expectedRevision: rev1,
      domainId,
      path: '/api',
      target: 'http://127.0.0.1:3000',
      hostHeader: 'client',
      websocket: true,
    })
    expect($('[data-spr-rows]').textContent).toContain('/api')
    expect($('[data-spr-rows]').textContent).toContain('http://127.0.0.1:3000')

    $<HTMLButtonElement>('[data-spr-rows] button').click()
    await tick()
    expect(send).toHaveBeenCalledWith('DELETE', '/api/account/domains/proxy-rules', {
      expectedRevision: rev2,
      domain: 'alice.example.test',
      path: '/api',
    })
    expect($('[data-spr-rows]').textContent).toContain('No path-scoped proxy rules saved.')
  })

  it('creates a proxy project, surfaces LAST_PROXY_RULE on last rule deletion, and deletes the project', async () => {
    const project = {
      id: projectId,
      accountId,
      name: 'Gateway',
      domains: ['gw.example.test'],
      note: 'App gateway',
      ssl: { enabled: true, certificateId: null },
      cache: true,
      gzip: true,
      rules: [{ id: ruleId, path: '/', target: 'http://127.0.0.1:3000', websocket: true, hostHeader: 'client' as const }],
    }
    let projectsState = { state: 'default', revision: rev1, limit: 32, runtimePorts: [3000], projects: [] as typeof project[] }
    const rulesState = { state: 'default', revision: rev1, limit: 64, runtimePorts: [3000], domains: [], rules: [] }
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => {
      if (path.startsWith('/api/account/domains/proxy-rules')) return rulesState
      if (method === 'GET') return projectsState
      if (method === 'POST' && path === '/api/account/proxy-projects') {
        projectsState = { ...projectsState, state: 'saved', revision: rev2, projects: [project] }
        return { ...projectsState, project }
      }
      if (method === 'DELETE' && path.endsWith('/rules')) {
        throw Object.assign(new Error('last rule'), { status: 409, details: { stateChanged: false, reason: 'LAST_PROXY_RULE', fields: [{ field: 'path', code: 'last_proxy_rule' }] } })
      }
      projectsState = { ...projectsState, revision: rev1, projects: [] }
      return projectsState
    })

    mountClient(pageHtml(), send)
    await tick()

    $<HTMLInputElement>('[data-pp-name]').value = 'Gateway'
    $<HTMLInputElement>('[data-pp-domains]').value = 'gw.example.test'
    $<HTMLInputElement>('[data-pp-path]').value = '/'
    $<HTMLInputElement>('[data-pp-target]').value = 'http://127.0.0.1:3000'
    $<HTMLInputElement>('[data-pp-note]').value = 'App gateway'
    $<HTMLInputElement>('[data-pp-ssl]').checked = true
    $<HTMLButtonElement>('[data-pp-save]').click()
    await tick()

    expect($('[data-pp-rows]').textContent).toContain('Gateway')
    expect($('[data-pp-rule-rows]').textContent).toContain('http://127.0.0.1:3000')

    $<HTMLButtonElement>('[data-pp-rule-rows] button').click()
    await tick()
    expect($('[data-pp-error]').textContent).toContain('keep at least one proxy rule')

    $<HTMLButtonElement>('[data-pp-rows] [data-xp-slot="remove"]').click()
    await tick()
    expect($('[data-pp-rows]').textContent).toContain('No standalone proxy projects created.')
  })

  it('keeps controls disabled and sends no requests when read-only or unmanaged', async () => {
    const send = vi.fn(async () => ({}))
    mountClient(renderV2ReverseProxyPage({ locale: 'en', account: fixtureAccount({ id: accountId, home }) }, { canRead: true, canManage: false }), send)
    await tick()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-spr-status]').getAttribute('data-state')).toBe('unavailable')
    expect($('[data-pp-status]').getAttribute('data-state')).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')].every(el => el.disabled)).toBe(true)
  })
})
