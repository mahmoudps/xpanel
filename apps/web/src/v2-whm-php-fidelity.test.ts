// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tools } from '@xpanel/catalog'
import { renderV2WhmPhp, WHM_PHP_CSS } from './themes/v2/pages/xwhm/host/php.ts'
import { PRESENTATION_TABS_CLIENT_BINDING } from './presentation-tabs-client.ts'
import { WHM_PHP_CLIENT_BINDING } from './whm-php-client.ts'
import { translator } from './i18n.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const principal = { kind: 'root' as const, id: 'php-view-root', username: 'operator' }
beforeEach(() => { document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('approved V2 PHP composition', () => {
  it.each(['en', 'ar'] as const)('retains the %s six-column inventory, one native control set and both editor modes', locale => {
    const html = renderV2WhmPhp({ principal, catalog, locale })
    document.body.innerHTML = html
    const versions = document.querySelector('[data-whm-php-version-entries]')!
    expect(versions.tagName).toBe('TBODY'); expect(versions.closest('table')!.tHead!.rows[0]!.cells).toHaveLength(6)
    const prototype = document.querySelector<HTMLTemplateElement>('template[data-xp-template="whm-php-version-entry"]')!
    expect(prototype.content.firstElementChild!.tagName).toBe('TR'); expect(prototype.content.firstElementChild!.children).toHaveLength(6)
    for (const name of ['php-selected-version', 'php-extension-version', 'php-version', 'php-install-request', 'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'php-ini']) expect(document.querySelectorAll('[name="' + name + '"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-php-version-panel]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-presentation-tabs="panels"]')).toHaveLength(1)
    expect(document.querySelector('[data-whm-php-handler-rows]')).not.toBeNull()
    expect(document.querySelector('[data-whm-php-installable]')).not.toBeNull()
    const previewHeading = document.getElementById('v2-host-php-ini-preview-heading')!
    const previewCard = previewHeading.closest('section')!
    const preview = previewCard.querySelector<HTMLElement>('[role="region"]')!
    expect(preview).not.toBeNull(); expect(preview.tabIndex).toBe(0)
    expect(preview.getAttribute('aria-label')).toBe(previewHeading.textContent)
    expect(preview.textContent?.trim()).toBe(translator(locale)('Not read'))
    expect(previewCard.querySelector<HTMLButtonElement>('[data-php-ini-copy]')!.disabled).toBe(true)
    expect(document.querySelector('[data-php-action="grant-exception"]')!.closest('aside')).not.toBeNull()
    expect(document.querySelector('[data-php-action="add-exception"]')).not.toBeNull()
    expect(document.querySelector('[data-whm-detail-section="php-functions"] table')!.querySelectorAll('thead th')).toHaveLength(5)
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id); expect(new Set(ids).size).toBe(ids.length)
    expect(html).not.toMatch(/class="[^"\n]*\bxp-|<style\b|<script\b/)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(html).not.toContain('/usr/bin/php8.3'); expect(html).not.toContain('Until 2027-12-31')
    expect(WHM_PHP_CSS).toContain('[data-whm-detail-route="/whm/software/php"]')
    expect(WHM_PHP_CSS).not.toContain('\n.v2-host ')
  })

  it.each(['en', 'ar'] as const)('keeps %s presentation modes usable while native reads and every mutation stay unavailable', locale => {
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = renderV2WhmPhp({ principal, catalog, locale, capabilityUnavailable: true })
    const send = vi.fn(); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + PRESENTATION_TABS_CLIENT_BINDING)()()
    new Function('return ' + WHM_PHP_CLIENT_BINDING)()()
    const common = document.querySelector<HTMLButtonElement>('[data-presentation-tab="common"]')!, file = document.querySelector<HTMLButtonElement>('[data-presentation-tab="file"]')!
    common.focus(); common.dispatchEvent(new KeyboardEvent('keydown', { key: locale === 'ar' ? 'ArrowLeft' : 'ArrowRight', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(file); expect(file.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector<HTMLTextAreaElement>('[name="php-ini"]')!.closest<HTMLElement>('[role="tabpanel"]')!.hidden).toBe(false)
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) expect(control.disabled).toBe(true)
    expect(common.disabled).toBe(false); expect(file.disabled).toBe(false); expect(send).not.toHaveBeenCalled()
    file.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); expect(document.activeElement).toBe(common)
    expect(document.querySelector<HTMLTextAreaElement>('[name="php-ini"]')!.closest<HTMLElement>('[role="tabpanel"]')!.hidden).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})
