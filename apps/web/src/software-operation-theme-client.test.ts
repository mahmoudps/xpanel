// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import type { Account } from '@xpanel/core'
import { translator } from './i18n.ts'
import { renderSwDeploymentsWorkspace } from './board-port/sw-deployments-workspace.ts'
import { renderWhmComposerWorkspace } from './board-port/whm-composer-workspace.ts'
import { renderSwOptimizeWorkspace } from './board-port/sw-optimize-workspace.ts'
import { renderSwAppProjectsWorkspace } from './board-port/sw-app-projects-workspace.ts'
import { renderAcctConvertAddonWorkspace } from './board-port/acct-convert-addon.ts'
import { renderWhmAccountTemplatesWorkspace } from './board-port/acct-templates-workspace.ts'
import { renderV2WhmSoftwarePage } from './themes/v2/pages/xwhm/software/index.ts'
import { renderV2OptimizePage } from './themes/v2/pages/xpanel/software/optimize.ts'
import { renderV2WhmConvertAddonPage } from './themes/v2/pages/xwhm/recovery-tools/convert.ts'
import { renderV2WhmAccountTemplatesPage } from './themes/v2/pages/xwhm/account-tools/pages.ts'
import { SW_DEPLOYMENTS_CLIENT_BINDING } from './sw-deployments-client.ts'
import { WHM_COMPOSER_CLIENT_BINDING } from './whm-composer-client.ts'
import { SW_OPTIMIZE_CLIENT_BINDING } from './sw-optimize-client.ts'
import { SW_APP_PROJECTS_CLIENT_BINDING } from './sw-app-projects-client.ts'
import { ACCT_CONVERT_ADDON_CLIENT_BINDING } from './acct-convert-addon-client.ts'
import { WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING } from './acct-templates-client.ts'

type Theme = 'classic' | 'v2'
type Family = 'deployments' | 'composer' | 'optimize' | 'projects' | 'convert' | 'templates'
let environment: EnvironmentReturn | undefined
beforeEach(async () => {
  environment = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test/whm', runScripts: 'outside-only' } })
  vi.stubGlobal('xpT', translator('en'))
})
afterEach(async () => {
  try { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.unstubAllGlobals() }
  finally { await environment?.teardown(globalThis); environment = undefined }
})
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const id = (value: number) => 'bbbbbbbb-bbbb-4bbb-8bbb-' + String(value).padStart(12, '0')
const account: Account = { id: id(5), username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: id(4), ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const authority = { canRead: true, canManage: true }
function html(theme: Theme, family: Family): string {
  if (theme === 'v2') {
    if (family === 'convert') return renderV2WhmConvertAddonPage({}, authority)
    if (family === 'templates') return renderV2WhmAccountTemplatesPage({}, authority)
    if (family === 'optimize') return renderV2OptimizePage({ activeRoute: '/software/optimize', account }, authority)
    return renderV2WhmSoftwarePage({ activeRoute: '/whm/software/' + (family === 'projects' ? 'application-projects' : family), dataAuthority: authority })!
  }
  if (family === 'convert') return renderAcctConvertAddonWorkspace({ locale: 'en', canManage: true })
  if (family === 'templates') return renderWhmAccountTemplatesWorkspace({ locale: 'en', canManage: true })
  if (family === 'optimize') return renderSwOptimizeWorkspace({ lang: 'en', canRead: true })
  if (family === 'projects') return renderSwAppProjectsWorkspace({ locale: 'en', canRead: true })
  if (family === 'composer') return renderWhmComposerWorkspace({ locale: 'en', canRead: true })
  return renderSwDeploymentsWorkspace({ locale: 'en', canRead: true, canManage: true })
}
const bindings = { deployments: SW_DEPLOYMENTS_CLIENT_BINDING, composer: WHM_COMPOSER_CLIENT_BINDING, optimize: SW_OPTIMIZE_CLIENT_BINDING, projects: SW_APP_PROJECTS_CLIENT_BINDING, convert: ACCT_CONVERT_ADDON_CLIENT_BINDING, templates: WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING }
const template = { deployments: 'software-deployment-repository-row', composer: 'software-composer-package-row', optimize: 'software-optimize-domain-row', projects: 'software-project-runtime-row', convert: 'account-convert-domains-row', templates: 'account-template-row' }
const status = { deployments: '[data-sw-dep-status]', composer: '[data-composer-status]', optimize: '[data-sw-optimize-status]', projects: '[data-sw-projects-status]', convert: '[data-acct-convert-status]', templates: '[data-acct-templates-status]' }
const boot = (family: Family, send: (method: string, path: string, body?: unknown) => Promise<unknown>) => {
  Object.assign(window, { xpanelSessionRequest: send })
  new Function('return ' + bindings[family])()(async () => true)
}
const optimize = { context: { accountId: account.id, username: account.username }, state: 'read', reason: null, policy: { compression: 'on', types: ['text/html'], minLength: 1024, proxied: ['any'], cache: { configured: true, maxSize: '1024m' } }, domains: [{ name: 'alice.test', redirect: false, suspended: false }], actions: { siteCompression: false, siteCache: false, purge: false } }
const projects = { page: 'runtime', state: 'read', components: [{ id: 'golang', state: 'installed', installed: [{ name: 'golang-go', versions: ['1.22'] }] }] }
const templates = { state: 'saved', revision: 'a'.repeat(64), templates: [{ id: id(7), name: 'Saved template', records: [], zone: '', defaultPage: { title: 'Welcome', body: 'Soon.' }, suspendedPage: { title: 'Suspended', body: 'Unavailable.' }, planIds: [id(4)], updatedAt: '2026-10-27T10:00:00.000Z', updatedBy: 'root', preview: [] }], plans: [{ id: id(4), name: 'Saved plan' }], placeholders: ['%domain%'], sample: {}, application: { appliedToNewAccounts: true, defaultPagePublished: false, suspendedPagePublished: false } }
const conversion = { candidates: [{ domainId: id(1), domain: 'shop.alice.test', docRoot: '/home/alice/shop', account: { id: account.id, username: account.username, status: 'active' } }], plans: [{ id: id(4), name: 'Saved plan' }], capabilities: { preview: true, apply: false, reason: 'atomic-ownership-move-unavailable' } }
const reviewedConversion = { revision: 'c'.repeat(64), capabilities: conversion.capabilities, plan: { source: { accountId: account.id, username: account.username, domainId: id(1), domain: 'shop.alice.test', docRoot: '/home/alice/shop' }, target: { username: 'shop', planId: id(4), planName: 'Saved plan', home: '/home/shop', documentRoot: '/home/shop/public_html' }, domains: [{ id: id(1), name: 'shop.alice.test', kind: 'addon', docRoot: '/home/alice/shop' }], mail: { mailboxes: [], otherServiceUsers: [] }, dns: [], certificates: 0, conflicts: [] } }

describe.each(['classic', 'v2'] as const)('%s emitted software operation bindings', theme => {
  it.each(['optimize', 'projects', 'templates'] as const)('reads actual %s rows through the serialized closure', async family => {
    document.body.innerHTML = html(theme, family)
    const send = vi.fn(async () => family === 'optimize' ? optimize : family === 'projects' ? projects : templates)
    boot(family, send); await settle()
    const selector = family === 'optimize' ? '[data-sw-optimize-domains]' : family === 'projects' ? '[data-sw-projects-runtimes]' : '[data-acct-templates-rows]'
    const row = document.querySelector(selector + ' tr')!
    expect(row.textContent).toContain(family === 'optimize' ? 'alice.test' : family === 'projects' ? 'Go' : 'Saved template')
    expect(row.querySelectorAll('td')).toHaveLength(family === 'templates' ? 5 : 3)
    expect(row.querySelector('[data-xp-slot]')).not.toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toEqual(['GET', family === 'optimize' ? '/api/account/optimize' : family === 'projects' ? '/api/server/software-center?page=runtime' : '/api/server/account-templates'])
  })
  it('uses actual selected deployment rows without a captured SSR import', async () => {
    document.body.innerHTML = html(theme, 'deployments')
    const view = (selected: boolean) => ({ scope: 'account-git-deployments', filesAvailable: true, nativeAvailable: true, accounts: [{ username: 'alice', gitAllowed: true }], selected: selected ? { context: { accountId: account.id, username: 'alice' }, revision: 'f'.repeat(64), repositories: ['site'], selected: null, nativeAvailable: true, application: { op: 'list', state: 'read', verificationRequired: false } } : null })
    const send = vi.fn(async (_method: string, path: string) => view(path.includes('?')))
    boot('deployments', send); await settle()
    const select = document.querySelector<HTMLSelectElement>('[data-sw-dep-account]')!; select.value = 'alice'; select.dispatchEvent(new Event('change')); await settle()
    const row = document.querySelector('[data-sw-dep-repositories] tr')!
    expect(row.textContent).toContain('site'); expect(row.querySelectorAll('td')).toHaveLength(2)
    expect(row.querySelector('button')?.className).toBe(theme === 'v2' ? 'v2-btn' : 'xp-btn')
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it('keeps conversion unavailable after a real preview while rendering selected-theme rows', async () => {
    document.body.innerHTML = html(theme, 'convert')
    const send = vi.fn(async (method: string) => method === 'GET' ? conversion : reviewedConversion)
    boot('convert', send); await settle()
    document.querySelector<HTMLInputElement>('[data-acct-convert-input="username"]')!.value = 'shop'
    document.querySelector<HTMLFormElement>('[data-acct-convert-form]')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle()
    expect(document.querySelector('[data-acct-convert-rows="domains"]')?.textContent).toContain('shop.alice.test')
    expect(document.querySelector<HTMLButtonElement>('[data-acct-convert-apply]')!.disabled).toBe(true)
    expect(send.mock.calls.at(-1)).toEqual(['POST', '/api/transfers/convert-addon/preview', { domainId: id(1), username: 'shop', planId: id(4) }])
  })
  it('reads Composer package metadata without enabling an unqualified job', async () => {
    document.body.innerHTML = html(theme, 'composer')
    const send = vi.fn(async (_method: string, path: string) => ({ scope: 'saved-site-document-roots', observedAt: '2026-10-28T00:00:00.000Z', binary: { state: 'read', executable: '/usr/bin/composer', version: '2.8.12' }, projects: [{ selector: id(1), domain: 'alice.test', account: 'alice', directory: '/home/alice/public_html', phpVersion: '8.3' }],
      selected: path.includes('?') ? { selector: id(1), state: 'read', reason: null, manifest: 'present', lock: 'present', vendor: 'present', lockMatch: 'matches', lockFreshness: 'not-verified', packages: [{ name: 'vendor/package', requirement: '^1.0', locked: '1.2.0', installed: '1.2.0', development: false }] } : null,
      actions: { install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' } }))
    boot('composer', send); await settle()
    const select = document.querySelector<HTMLSelectElement>('[data-composer-target]')!; select.value = id(1); select.dispatchEvent(new Event('change')); await settle()
    const row = document.querySelector('[data-composer-packages] tr')!
    expect(row.textContent).toContain('vendor/package'); expect(row.querySelectorAll('td')).toHaveLength(5)
    expect(document.querySelector<HTMLButtonElement>('[data-composer-run]')!.disabled).toBe(true)
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it.each(['deployments', 'composer', 'optimize', 'projects', 'convert', 'templates'] as const)('rejects missing and duplicate %s templates before any request', async family => {
    for (const problem of ['missing', 'duplicate', 'missing-slot'] as const) {
      document.body.innerHTML = html(theme, family)
      const node = document.querySelector<HTMLTemplateElement>('template[data-xp-template="' + template[family] + '"]')!
      expect(node).not.toBeNull()
      if (problem === 'missing') node.remove()
      else if (problem === 'duplicate') node.after(node.cloneNode(true))
      else node.content.querySelector('[data-xp-slot]')!.removeAttribute('data-xp-slot')
      const send = vi.fn(async () => { throw new Error('must not reach transport') })
      boot(family, send); await settle()
      expect(send).not.toHaveBeenCalled()
      expect(document.querySelector<HTMLElement>(status[family])?.dataset.state).toBe('unavailable')
    }
  })
  it.each(['deployments', 'composer', 'optimize', 'projects', 'convert', 'templates'] as const)('keeps a denied %s workspace inert despite intact templates', async family => {
    document.body.innerHTML = '<div data-capability-unavailable="true">' + html(theme, family) + '</div>'
    const send = vi.fn(async () => { throw new Error('denied transport') })
    boot(family, send); await settle()
    document.querySelectorAll<HTMLButtonElement>('button').forEach(button => { if (!button.disabled) button.click() })
    await settle()
    expect(send).not.toHaveBeenCalled()
  })
})
