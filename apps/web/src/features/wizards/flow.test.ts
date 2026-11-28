import { describe, expect, it } from 'vitest'
import { renderGuidedWizard, renderStepLinkList, renderWizardStepCounter } from './flow.ts'
import { renderV2SitePublisherPage } from '../../themes/v2/pages/xpanel/domains/publisher.ts'
import { renderV2CertificateIssuePage } from '../../themes/v2/pages/xpanel/security/certificates.ts'
import { renderV2WhmTlsInstallPage } from '../../themes/v2/pages/xwhm/tls/install.ts'

describe('guided wizard helper', () => {
  it('renders single active step, preflight badge, change diff, and custom finish label', () => {
    const html = renderGuidedWizard({
      id: 'sample-wizard',
      activeStepIndex: 0,
      submitLabel: 'Apply now',
      submitTarget: '[data-apply-target]',
      preflightState: { tone: 'ok', message: 'Ready' },
      changePlan: [{ label: 'Plan', before: 'Basic', after: 'Pro' }],
      steps: [
        { id: 'one', label: 'First', bodyHtml: '<p>Step one</p>' },
        { id: 'two', label: 'Second', bodyHtml: '<p>Step two</p>' },
      ],
    })
    expect(html).toContain('data-ds-wizard')
    expect(html).toContain('data-ds-wizard-step="one" data-ds-wizard-panel-state="active">')
    expect(html).toContain('data-ds-wizard-step="two" data-ds-wizard-panel-state="inactive">')
    const collapsed = renderGuidedWizard({
      id: 'collapsed-wizard',
      activeStepIndex: 0,
      disabled: true,
      revealAllPanels: false,
      steps: [
        { id: 'one', label: 'First', bodyHtml: '<p>Step one</p>' },
        { id: 'two', label: 'Second', bodyHtml: '<p>Step two</p>' },
      ],
    })
    expect(collapsed).toContain('data-ds-wizard-step="two" hidden>')
    expect(collapsed).toContain('data-ds-wizard-next disabled>')
    expect(html).toContain('data-ds-wizard-preflight')
    expect(html).toContain('data-ds-wizard-diff')
    expect(html).toContain('data-ds-wizard-custom-submit="true" data-ds-wizard-submit-target="[data-apply-target]">Apply now</button>')
    expect(renderWizardStepCounter(1, 3)).toContain('Step 1 of 3')
    expect(renderStepLinkList([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], 1)).toContain('data-step-state="done"')

    const noSubmit = renderGuidedWizard({
      id: 'no-submit-wizard',
      activeStepIndex: 0,
      hideSubmit: true,
      submitLabel: 'Ignored',
      steps: [
        { id: 'a', label: 'A', bodyHtml: '<p>One</p>' },
        { id: 'b', label: 'B', bodyHtml: '<p>Two</p>' },
      ],
    })
    expect(noSubmit).not.toContain('data-ds-wizard-submit')
    expect(noSubmit).toContain('data-ds-wizard-prev')
    expect(noSubmit).toContain('data-ds-wizard-next')
  })

  it('keeps shared wizard feedback outside hidden panels and avoids duplicate certificate submit buttons', () => {
    const tlsHtml = renderV2WhmTlsInstallPage({ locale: 'en', accounts: [] }, { canRead: true, canManage: true })
    expect(tlsHtml.indexOf('data-ssl-install-status')).toBeGreaterThan(-1)
    expect(tlsHtml.indexOf('data-ssl-install-status')).toBeLessThan(tlsHtml.indexOf('data-ds-wizard-step="domain-names"'))

    const pubHtml = renderV2SitePublisherPage(
      { locale: 'en', domains: [{ id: 'd1', accountId: 'a1', name: 'a.test', kind: 'primary', parentId: null, docRoot: '/home/a/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }] } as never,
      { canRead: true, canManage: true, sitePublisher: true, account: { id: 'a1', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'a.test', planId: 'p1', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-01-01T00:00:00Z' } } as never,
    )
    expect(pubHtml.indexOf('data-sitepub-status')).toBeGreaterThan(-1)
    expect(pubHtml.indexOf('data-sitepub-status')).toBeLessThan(pubHtml.indexOf('data-ds-wizard-step="site"'))

    const certHtml = renderV2CertificateIssuePage({ locale: 'en' } as never, { canRead: true, canManage: true, editable: true } as never)
    expect(certHtml.match(/type="submit"/g) ?? []).toHaveLength(1)
    expect(certHtml).not.toContain('data-ds-wizard-submit')
  })
})
