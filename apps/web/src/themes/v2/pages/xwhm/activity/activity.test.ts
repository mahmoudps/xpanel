import { describe, expect, it } from 'vitest'
import { renderV2WhmActivityPage } from './index.ts'
import { WHM_ACTIVITY_CSS } from './style.ts'
import type { WhmObservationInput } from '../monitoring/common.ts'

const admitted: WhmObservationInput = { observationAuthority: { canRead: true, canManage: true } }
const render = (activeRoute: string, props: WhmObservationInput = admitted): string => renderV2WhmActivityPage({ ...props, activeRoute })!
const entry = (id: string, outcome: string) => ({ id, at: '2026-10-29T12:00:00.000Z', actor: 'root', action: 'auth.login', target: 'account:alice', outcome })

describe('v2 WHM activity board regions', () => {
  it('puts the audit page exports in the page header only for an admitted read', () => {
    const html = render('/whm/audit', { ...admitted, auditEntries: [] })
    const header = html.slice(0, html.indexOf('<section class="v2-card"'))
    expect(header).toContain('data-audit-export')
    expect(header.match(/<a class="v2-btn" download="xpanel-audit-page\.(?:csv|json)"/g)).toHaveLength(2)
    expect(html.match(/data-audit-export/g)).toHaveLength(1)
    expect(render('/whm/audit', { observationAuthority: { canRead: false, canManage: false }, auditEntries: [] })).not.toContain('data-audit-export')
  })

  it('tones each audit outcome from the recorded outcome and never from its label', () => {
    const html = render('/whm/audit', { ...admitted, auditEntries: [entry('a', 'ok'), entry('b', 'denied'), entry('c', 'failed'), entry('d', 'other')] as WhmObservationInput['auditEntries'] })
    const tones = [...html.matchAll(/<tr data-audit-id="([a-d])">.*?<span class="v2-pill v2-pill--(\w+)">/gs)].map(match => `${match[1]}:${match[2]}`)
    expect(tones).toEqual(['a:ok', 'b:warn', 'c:bad', 'd:neutral'])
  })

  it('shows a designed empty state for an empty page and a not-read state without a read', () => {
    const empty = render('/whm/audit', { ...admitted, auditEntries: [] })
    expect(empty).toMatch(/<td colspan="7"><div class="v2-state v2-state--empty">.*?<h3>No audit entries yet<\/h3>/s)
    const unread = render('/whm/audit')
    expect(unread).toMatch(/<td colspan="7"><div class="v2-state v2-state--empty">.*?<h3>Not read<\/h3><\/div>/s)
    expect(unread).not.toContain('No audit entries yet')
  })

  it('renders audit sequence numbers, client IP column and SHA-256 hash-chain status', () => {
    const html = render('/whm/audit', {
      ...admitted,
      auditChain: { status: 'verified', entriesVerified: 2, totalEntries: 2, lastSeq: 12, brokenAtSeq: null },
      auditEntries: [
        { ...entry('a', 'ok'), seq: 12, ip: '203.0.113.10', entryHash: 'b'.repeat(64) },
        { ...entry('b', 'ok'), seq: 11, ip: null },
      ] as WhmObservationInput['auditEntries'],
    })
    expect(html).toContain('data-audit-chain data-chain-status="verified"')
    expect(html).toContain('SHA-256 hash chain verified (2 entries)')
    expect(html).toContain('#12')
    expect(html).toContain('203.0.113.10')
    expect(html).toContain('<td data-audit-ip>—</td>')
  })

  it('renders generation step timeline on /whm/jobs when generations are supplied', () => {
    const html = render('/whm/jobs', {
      ...admitted,
      generations: [{
        generationId: 7,
        at: '2026-10-29T12:00:00.000Z',
        actor: 'root',
        summary: '+2 / ~1 / -0 files',
        stateChecksum: 'd'.repeat(64),
        filesCount: 3,
        durationMs: 420,
        status: 'active',
        testedAt: '2026-10-29T12:00:00.180Z',
        activatedAt: '2026-10-29T12:00:00.420Z',
        steps: [
          { step: 'built', status: 'done', at: '2026-10-29T12:00:00.000Z', durationMs: 40 },
          { step: 'tested', status: 'done', at: '2026-10-29T12:00:00.180Z', durationMs: 180 },
          { step: 'activated', status: 'done', at: '2026-10-29T12:00:00.420Z', durationMs: 240 },
        ],
      }],
    })
    expect(html).toContain('data-whm-generation-timeline')
    expect(html).toContain('data-generation-timeline-row="7"')
    expect(html).toContain('data-generation-step="built"')
    expect(html).toContain('data-generation-step="tested"')
    expect(html).toContain('data-generation-step="activated"')
    expect(html).toContain('(180 ms)')
    expect(html).toContain('(240 ms)')
  })

  it('marks only the active generation as good', () => {
    const generations = [['1', 'active'], ['2', 'rolled-back'], ['3', 'superseded']].map(([generationId, status]) => ({ generationId, at: '2026-10-29T12:00:00.000Z', actor: 'root', summary: 'sample', stateChecksum: 'c'.repeat(64), filesCount: 1, durationMs: 1500, status })) as unknown as WhmObservationInput['generations']
    const html = render('/whm/audit', { ...admitted, generations })
    const section = html.slice(html.indexOf('id="v2-observation-audit-generations"'))
    expect([...section.matchAll(/<span class="v2-pill v2-pill--(\w+)/g)].map(match => match[1])).toEqual(['ok', 'warn', 'neutral'])
    // Actor, duration and the file-set checksum come from the generation rows; the full checksum stays in the title.
    expect(section).toContain(`<td><bdi dir="ltr" class="v2-mono">root</bdi></td><td><bdi dir="ltr" class="v2-mono">1.5 s</bdi></td><td><span title="${'c'.repeat(64)}"><bdi dir="ltr" class="v2-mono">cccccccccccc</bdi></span></td>`)
    expect(render('/whm/audit')).toContain('<td colspan="8">Not read</td>')
  })

  it('counts the entries of the supplied page and stays silent without a read', () => {
    const page = (ids: string[]): string => render('/whm/audit', { ...admitted, auditEntries: ids.map(id => entry(id, 'ok')) as WhmObservationInput['auditEntries'] })
    expect(page(['a', 'b'])).toContain('<p class="v2-muted" data-audit-count>2 entries on this page</p>')
    expect(page(['a'])).toContain('data-audit-count>1 entry on this page</p>')
    expect(render('/whm/audit')).not.toContain('data-audit-count')
  })

  it.each([['/whm/jobs', 'en', '--v2-col-2:&#39;Kind&#39;'], ['/whm/audit', 'ar', '--v2-col-5:'], ['/whm/support', 'en', '--v2-col-3:&#39;State&#39;']] as const)('ships the phone row labels of %s on its tables in its locale and the rules in the registered stylesheet', (route, locale, label) => {
    const html = render(route, { ...admitted, locale })
    expect(html).not.toContain('<style')
    expect(html).toContain(label)
    expect(html.match(/style="--v2-col-1:[^"]*"/g)!.join('')).not.toMatch(/[٠-٩۰-۹]/)
    if (locale === 'ar') expect(html).toMatch(/--v2-col-1:&#39;\p{Script=Arabic}/u)
    expect(WHM_ACTIVITY_CSS).toContain('@media(max-width:600px)')
    expect(WHM_ACTIVITY_CSS).toContain('--c9:var(--v2-col-9)')
  })

  it('keeps the jobs empty and failure blocks hidden until the controller reveals them', () => {
    const html = render('/whm/jobs')
    expect(html).toContain('<div class="v2-state v2-state--empty" data-whm-jobs-empty hidden>')
    expect(html).toContain('<div class="v2-notice v2-notice--bad" data-whm-jobs-outcome hidden>')
    expect(html).toMatch(/<p data-whm-jobs-failure><\/p><p data-whm-jobs-error><\/p>/)
  })

  it('lays the three unread support manifest lists out in one group', () => {
    const html = render('/whm/support')
    const group = html.match(/<div class="v2-observation__charts">.*?<\/ul><\/div><\/div>/s)?.[0] ?? ''
    for (const key of ['included', 'excluded', 'redaction']) expect(group).toContain(`data-whm-support-${key}><li>The manifest has not been read.</li>`)
  })
})
