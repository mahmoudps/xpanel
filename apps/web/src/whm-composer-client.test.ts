// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmComposerWorkspace } from './board-port/whm-composer-workspace.ts'
import { readComposerWorkspaceView, WHM_COMPOSER_CLIENT_BINDING } from './whm-composer-client.ts'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const view = (selected = false) => ({ scope: 'saved-site-document-roots', observedAt: '2026-10-27T00:00:00.000Z', binary: { state: 'read', executable: '/usr/bin/composer', version: '2.8.12' }, projects: [{ selector: 'internal-routing-only', domain: 'example.test', account: 'alpha', directory: '/home/alpha/public_html', phpVersion: '8.3' }], selected: selected ? { selector: 'internal-routing-only', state: 'read', reason: null, manifest: 'present', lock: 'present', vendor: 'present', lockMatch: 'matches', lockFreshness: 'not-verified', packages: [{ name: 'vendor/package', requirement: '^1.0', locked: '1.2.0', installed: '1.2.0', development: false }] } : null, actions: { install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' } })
const boot = (request?: (method: string, path: string) => Promise<unknown>) => { if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + WHM_COMPOSER_CLIENT_BINDING)()(undefined) }
beforeEach(() => { document.body.innerHTML = renderWhmComposerWorkspace({ locale: 'en', canRead: true }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
describe('Composer observed dependency workspace', () => {
  it('keeps every execution control visible and disabled in both locales', () => {
    for (const locale of ['en', 'ar'] as const) {
      document.body.innerHTML = renderWhmComposerWorkspace({ locale, canRead: true })
      expect(document.querySelector<HTMLElement>('[data-whm-composer]')!.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      for (const id of ['composer-action', 'composer-php-binary', 'composer-mirror']) expect(document.querySelector<HTMLInputElement>('#' + id)!.disabled).toBe(true)
      expect(document.querySelector('[data-composer-live-log]')!.textContent).not.toBe(''); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    }
  })
  it('does not call transport without admission and keeps the full unavailable workspace', async () => {
    document.querySelector<HTMLElement>('[data-whm-composer]')!.dataset.composerCanRead = 'false'
    const send = vi.fn(); boot(send); await tick(); expect(send).not.toHaveBeenCalled(); expect(document.querySelector('[data-composer-status]')!.textContent).toContain('unavailable'); expect(document.querySelector('#composer-action')).not.toBeNull()
  })
  it('loads real targets then only the selected saved site with readable labels and isolated values', async () => {
    const send = vi.fn(async (_method: string, path: string) => view(path.includes('?'))); boot(send); await tick()
    const target = document.querySelector<HTMLSelectElement>('[data-composer-target]')!; expect(target.disabled).toBe(false); expect(target.textContent).toContain('example.test'); expect(document.body.textContent).not.toContain('internal-routing-only')
    target.value = 'internal-routing-only'; target.dispatchEvent(new Event('change')); await tick()
    expect(send.mock.calls.map(call => call[1])).toEqual(['/api/server/composer', '/api/server/composer?domainId=internal-routing-only'])
    expect(document.querySelector('[data-composer-packages]')!.textContent).toContain('vendor/package'); expect(document.querySelector('[data-composer-directory]')!.textContent).toBe('/home/alpha/public_html'); expect(document.querySelector('[data-composer-directory]')!.tagName).toBe('BDI')
    expect(document.querySelector<HTMLSelectElement>('#composer-action')!.disabled).toBe(true); expect(document.querySelector('[data-composer-status]')!.getAttribute('data-state')).toBe('read')
  })
  it('clears retained package data after a failed observation and never echoes raw errors', async () => {
    let fail = false; const send = vi.fn(async (_method: string, path: string) => { if (fail) throw new Error('private-log'); return view(path.includes('?')) }); boot(send); await tick()
    const target = document.querySelector<HTMLSelectElement>('[data-composer-target]')!; target.value = 'internal-routing-only'; target.dispatchEvent(new Event('change')); await tick(); fail = true
    document.querySelector<HTMLButtonElement>('[data-composer-refresh]')!.click(); await tick()
    expect(document.querySelector('[data-composer-packages]')!.textContent).not.toContain('vendor/package'); expect(document.body.textContent).not.toContain('private-log'); expect(document.querySelector('[data-composer-status]')!.getAttribute('data-state')).toBe('failed')
  })
  it('rejects credential URLs, false successful states and duplicate package names', () => {
    const response = view(true); response.selected!.packages[0]!.requirement = 'https://user:private@host/'
    expect(() => readComposerWorkspaceView(response)).toThrow()
    const duplicate = view(true); duplicate.selected!.packages.push(duplicate.selected!.packages[0]!)
    expect(() => readComposerWorkspaceView(duplicate)).toThrow()
    expect(WHM_COMPOSER_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('refuses mismatched selected-project responses rather than painting another site', async () => {
    const send = vi.fn(async () => view(true)); boot(send); await tick()
    expect(document.querySelector('[data-composer-packages]')!.textContent).not.toContain('vendor/package'); expect(document.querySelector('[data-composer-status]')!.getAttribute('data-state')).toBe('failed')
  })
})

describe('readable date closure Composer', () => {
  for (const locale of ['en', 'ar'] as const) it('formats observed metadata without changing target or package data in ' + locale, async () => {
    const source = view(); source.observedAt = '2026-10-27T09:01:02.123Z'; const before = JSON.stringify(source), send = vi.fn(async () => source)
    document.body.innerHTML = renderWhmComposerWorkspace({ locale, canRead: true }); boot(send); await tick()
    const observed = document.querySelector('[data-composer-observed]')!
    expect(observed.textContent).toBe('2026-10-27 09:01 UTC'); expect(observed.getAttribute('dir')).toBe('ltr')
    expect(document.querySelector('[data-composer-version]')?.textContent).toBe('2.8.12')
    expect(document.querySelector<HTMLSelectElement>('[data-composer-target]')!.options[1]!.value).toBe('internal-routing-only')
    expect(document.querySelector<HTMLSelectElement>('#composer-action')!.disabled).toBe(true)
    expect(JSON.stringify(source)).toBe(before); expect(readComposerWorkspaceView(source).observedAt).toBe('2026-10-27T09:01:02.123Z')
    expect(send.mock.calls).toEqual([['GET', '/api/server/composer']]); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})