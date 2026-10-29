// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmComposerWorkspace } from './board-port/whm-composer-workspace.ts'
import { WHM_COMPOSER_CLIENT_BINDING } from './whm-composer-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const domainId = '11111111-2222-4333-8444-555555555555', jobId = '99999999-2222-4333-8444-555555555555', H = (c: string) => c.repeat(64)
const view = (runnable: boolean, selected = true) => ({ scope: 'saved-site-document-roots', observedAt: '2026-10-28T00:00:00.000Z', binary: { state: 'read', executable: '/usr/bin/composer', version: '2.8.12' }, projects: [{ selector: domainId, domain: 'example.test', account: 'alpha', directory: '/home/alpha/public_html', phpVersion: '8.3' }],
  selected: selected ? { selector: domainId, state: 'read', reason: null, manifest: 'present', lock: 'present', vendor: 'present', lockMatch: 'matches', lockFreshness: 'not-verified', packages: [] } : null,
  actions: runnable ? { install: true, update: true, mirror: false, reason: null } : { install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' } })
const review = { review: { state: 'ready', action: 'install', domainId, domain: 'example.test', account: 'alpha', phpVersion: '8.3', expectedRevision: H('a'), reviewFingerprint: H('b'), graphDigest: H('c'), lockDigest: H('d'), packages: [{ name: 'vendor/package', version: '1.2.0', development: false }] } }
const boot = async (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: () => Promise<boolean>) => {
  (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_COMPOSER_CLIENT_BINDING)()(ask); await tick()
  const target = document.querySelector<HTMLSelectElement>('[data-composer-target]')!; target.value = domainId; target.dispatchEvent(new Event('change')); await tick()
}
beforeEach(() => { document.body.innerHTML = renderWhmComposerWorkspace({ locale: 'en', canRead: true }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('Composer job binding', () => {
  it('keeps job controls disabled while the agent reports no qualified provider', async () => {
    await boot(vi.fn(async (_m: string, path: string) => view(false, path.includes('?'))), async () => true)
    for (const selector of ['[data-composer-run-action]', '[data-composer-review]', '[data-composer-run]']) expect(document.querySelector<HTMLButtonElement>(selector)!.disabled).toBe(true)
    expect(document.querySelector('[data-composer-run-help]')!.textContent).toContain('unavailable')
  })
  it('reviews, confirms and submits exactly the reviewed graph once, then locks', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? view(true, path.includes('?')) : path.endsWith('/preview') ? review : { job: { id: jobId, kind: 'composer.dependencies.install' } }), ask = vi.fn(async () => true)
    await boot(send, ask)
    const reviewButton = document.querySelector<HTMLButtonElement>('[data-composer-review]')!, run = document.querySelector<HTMLButtonElement>('[data-composer-run]')!
    expect(reviewButton.disabled).toBe(false); expect(run.disabled).toBe(true)
    reviewButton.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/composer/jobs/preview', { action: 'install', domainId })
    expect(document.querySelector('[data-composer-review-packages]')!.textContent).toContain('vendor/package'); expect(document.querySelector<HTMLElement>('[data-composer-review-region]')!.hidden).toBe(false)
    expect(run.disabled).toBe(false); run.click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/composer/jobs/apply', { action: 'install', domainId, expectedRevision: H('a'), reviewFingerprint: H('b') })
    expect(document.querySelector<HTMLAnchorElement>('[data-composer-job-link]')!.getAttribute('href')).toBe('/whm/jobs?job=' + jobId)
    expect(run.disabled).toBe(true); expect(reviewButton.disabled).toBe(true)
  })
  it('reports an unavailable provider truthfully and never fakes a review', async () => {
    const send = vi.fn(async (method: string, path: string) => { if (method === 'GET') return view(true, path.includes('?')); throw { status: 412, details: { stateChanged: false } } })
    await boot(send, async () => true)
    document.querySelector<HTMLButtonElement>('[data-composer-review]')!.click(); await tick()
    expect(document.querySelector('[data-composer-status]')!.textContent).toContain('provider is unavailable'); expect(document.querySelector<HTMLButtonElement>('[data-composer-run]')!.disabled).toBe(true)
  })
  it('locks job controls after an unknown submission outcome', async () => {
    const send = vi.fn(async (method: string, path: string) => { if (method === 'GET') return view(true, path.includes('?')); if (path.endsWith('/preview')) return review; throw { status: 503, details: { stateChanged: true, unknownOutcome: true } } })
    await boot(send, async () => true)
    document.querySelector<HTMLButtonElement>('[data-composer-review]')!.click(); await tick()
    document.querySelector<HTMLButtonElement>('[data-composer-run]')!.click(); await tick()
    expect(document.querySelector('[data-composer-status]')!.getAttribute('data-state')).toBe('uncertain'); expect(document.querySelector<HTMLButtonElement>('[data-composer-review]')!.disabled).toBe(true)
  })
})
