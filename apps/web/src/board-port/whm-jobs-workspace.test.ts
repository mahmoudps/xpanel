import { describe, expect, it } from 'vitest'
import { renderWhmJobsWorkspace } from './whm-jobs-workspace.ts'

describe('WHM jobs workspace renderer', () => {
  it('renders the complete English page with truthful unread states', () => {
    const html = renderWhmJobsWorkspace({ locale: 'en', canRead: true })
    expect(html).toContain('data-whm-detail-route="/whm/jobs"')
    expect(html).toContain('data-jobs-can-read="true"')
    expect(html).toContain('data-capability-state="authorized"')
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('<h1>Jobs</h1>')
    expect(html).toContain('Job history has not been read. No job status or completion is assumed.')
    for (const marker of ['data-whm-jobs-filters', 'data-whm-jobs-status-filter', 'data-whm-jobs-kind-filter', 'data-whm-jobs-refresh', 'data-whm-jobs-rows', 'data-whm-jobs-loading', 'data-whm-jobs-empty',
      'data-whm-jobs-detail', 'data-whm-jobs-steps', 'data-whm-jobs-verification', 'data-whm-jobs-log', 'data-whm-jobs-log-more', 'data-whm-jobs-cancel', 'data-whm-jobs-outcome']) expect(html).toContain(marker)
    for (const header of ['Reference', 'Kind', 'Summary', 'Status', 'Progress', 'Created (UTC)', 'Started (UTC)', 'Finished (UTC)', 'Actor', 'Exit code']) expect(html).toContain(`>${header}</th>`)
    expect(html).toContain('data-whm-jobs-field="reference"')
    expect(html).toContain('colspan="9"')
    expect(html).toMatch(/<button type="button" class="xp-btn xp-btn--danger" data-whm-jobs-cancel disabled>/)
    expect(html).toContain('<pre class="xp-whm-jobs__log" dir="ltr"')
    expect(html).toContain('A running step is never interrupted')
  })

  it('renders Arabic RTL copy with ASCII digits only and technical values isolated', () => {
    const html = renderWhmJobsWorkspace({ locale: 'ar', canRead: true })
    expect(html).toContain('lang="ar" dir="rtl"')
    expect(html).toContain('<h1>المهام</h1>')
    expect(html).toContain('لم يُقرأ سجل المهام')
    expect(html).toContain('<bdi dir="ltr">system.packages</bdi>')
    expect(html).toContain('5 ثوانٍ')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/\b(?:Jobs|Job history|Cancel job)\b/)
  })

  it('keeps the full layout but disables reading when the capability is unavailable', () => {
    const html = renderWhmJobsWorkspace({ locale: 'en', canRead: false })
    expect(html).toContain('data-jobs-can-read="false"')
    expect(html).toContain('data-capability-state="unavailable"')
    expect(html).toMatch(/data-whm-jobs-refresh disabled/)
    expect(html).toMatch(/data-whm-jobs-status-filter disabled/)
    expect(html).toContain('data-whm-jobs-rows')
  })
})
