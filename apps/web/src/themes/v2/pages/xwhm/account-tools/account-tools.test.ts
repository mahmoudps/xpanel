import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmAccountToolsPage, V2_WHM_ACCOUNT_TOOL_ROUTES } from './index.ts'

const admitted = { canRead: true, canManage: true, root: true } as const
const render = (activeRoute: string, authority = admitted) => renderV2WhmAccountToolsPage({ activeRoute, locale: 'en' }, authority)!

describe('V2 WHM account tools', () => {
  it.each(V2_WHM_ACCOUNT_TOOL_ROUTES)('mounts %s with the correct exact route and default-denied controls', activeRoute => {
    const html = renderV2WhmAccountToolsPage({ activeRoute, locale: 'en' })!
    expect(html).toContain(`data-whm-detail-route="${activeRoute}"`)
    const nodes = parseMarkup(html).filter(node => node.template < 0 && ['button', 'input', 'select', 'textarea'].includes(node.tag))
    expect(nodes.length).toBeGreaterThan(0)
    expect(nodes.every(node => node.attrs.has('disabled'))).toBe(true)
    expect(html).not.toContain('<form')
    expect(html).not.toMatch(/class="xp-|style=/)
  })

  it('does not swallow another family or a guessed descendant as an outage', () => {
    expect(renderV2WhmAccountToolsPage({ activeRoute: '/whm/accounts/health/guess' }, admitted)).toBeUndefined()
    expect(renderV2WhmAccountToolsPage({ activeRoute: '/whm/backups' }, admitted)).toBeUndefined()
  })

  it('does not present absent health evidence as a healthy zero or an authorized repair', () => {
    const html = render('/whm/accounts/health')
    for (const key of ['count-accounts', 'count-affected', 'count-problems', 'count-unavailable', 'observed-at']) expect(html).toContain(`data-whm-health-${key}>Not read</bdi>`)
    expect(html).toContain('Not verified means the evidence could not be read. It is never counted as healthy.')
    expect(html).toContain('data-whm-health-run>Run checks</button>')
    expect(html).not.toContain('data-whm-health-repair')
    expect(html).toContain('data-whm-health-recheck disabled')
    expect(html).toContain('<option value="unavailable">Not fully verified</option>')
  })

  it('preserves account health selection and filtering contracts in Arabic', () => {
    const html = renderV2WhmAccountToolsPage({ activeRoute: '/whm/accounts/health', locale: 'ar' }, { ...admitted, root: false })!
    expect(html).toContain('lang="ar" dir="rtl"')
    expect(html).toContain('data-health-root="false"')
    for (const marker of ['filter', 'search', 'select-all', 'selection', 'list', 'empty']) expect(html).toContain(`data-whm-health-${marker}`)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('retains all bandwidth sources and unmeasured state, separating plan enforcement from service availability', () => {
    const html = render('/whm/accounts/bandwidth')
    expect(html).toContain('data-whm-metering="bandwidth"')
    for (const key of ['month', 'since', 'updated', 'pending', 'web', 'mail', 'ftp']) expect(html).toContain(`data-whm-metering-fact="${key}">Not read`)
    expect(html).toContain('Mail, FTP and the panels keep working.')
    expect(html).toContain('data-whm-metering-rows="bandwidth" data-xp-columns="8"')
    expect(html).toContain('No bandwidth has been read.')
  })

  it('retains bilingual announcement authoring, named audience selectors and owner previews', () => {
    const html = render('/whm/accounts/announcements')
    const nodes = parseMarkup(html)
    for (const name of ['title-en', 'body-en', 'title-ar', 'body-ar', 'severity', 'audience', 'plan', 'reseller', 'usernames', 'starts', 'ends']) {
      expect(nodes.some(node => node.attrs.get('data-whm-announcements-input') === name), name).toBe(true)
    }
    expect(html).toContain('data-whm-announcements-preview="en" lang="en" dir="ltr"')
    expect(html).toContain('data-whm-announcements-preview="ar" lang="ar" dir="rtl"')
    expect(html.match(/data-whm-announcements-labels=/g)).toHaveLength(2)
    expect(html).toContain('maxlength="140"')
    expect(html).toContain('maxlength="2000"')
    expect(html).toContain('Nothing is emailed.')
    expect(html).toContain('data-whm-announcements-rows data-xp-columns="7"')
  })

  it('keeps announcements unread and forbids root-editor mutation when only read admission exists', () => {
    const html = renderV2WhmAccountToolsPage({ activeRoute: '/whm/accounts/announcements', locale: 'en' }, { canRead: true, canManage: false })!
    expect(html).toContain('data-announcements-can-manage="false"')
    expect(html).toContain('No announcement is assumed to be shown.')
    expect(html).not.toContain('<form')
    expect(html).toContain('data-whm-announcements-save disabled')
  })

  it('preserves template zone inputs, plans, previews and the saved-only publisher limitation', () => {
    const html = render('/whm/accounts/templates')
    for (const name of ['name', 'zone', 'defaultPage.title', 'defaultPage.body', 'suspendedPage.title', 'suspendedPage.body']) expect(html).toContain(`data-acct-templates-input="${name}"`)
    expect(html).toContain('data-acct-templates-plans')
    expect(html).toContain('data-acct-templates-preview data-xp-columns="5"')
    expect(html).toContain('The default and suspended page text is saved only.')
    expect(html).toContain('Existing accounts and zones do not change.')
    expect(html).toContain('%domain%, %ipv4%, %ipv6%, %mailhost%')
  })

  it.each(V2_WHM_ACCOUNT_TOOL_ROUTES)('demotes supplied authority when the host marks %s unavailable', activeRoute => {
    const html = renderV2WhmAccountToolsPage({ activeRoute, capabilityUnavailable: true }, admitted)!
    const nodes = parseMarkup(html).filter(node => node.template < 0 && ['button', 'input', 'select', 'textarea'].includes(node.tag))
    expect(nodes.every(node => node.attrs.has('disabled'))).toBe(true)
    expect(html).not.toContain('<form')
    expect(html).not.toContain('data-health-can-read="true"')
    expect(html).not.toContain('data-metering-can-read="true"')
  })
})
