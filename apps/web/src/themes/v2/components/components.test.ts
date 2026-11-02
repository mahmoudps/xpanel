import { describe, expect, it } from 'vitest'
import { v2Messages } from '../messages.ts'
import * as kit from './index.ts'
import { FILTER_BAR_CSS } from './filter-bar.ts'
import { V2_BASE_CSS } from '../base.ts'

const t = v2Messages.translator('en')
const EVIL = '<img src=x onerror="alert(1)">'
const SAFE = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
const hooks = { 'data-test-hook': 'yes' } as const

describe('v2 component kit', () => {
  it('escape caller text in every component', () => {
    const rendered = [
      kit.statusPill({ tone: 'ok', label: EVIL }),
      kit.pageHeader(t, { breadcrumb: [{ label: EVIL, href: '/x' }, { label: EVIL }], route: EVIL, title: EVIL, description: EVIL }),
      kit.card({ title: EVIL, titleId: 'c', bodyHtml: '' }),
      kit.kpiCard({ label: EVIL, value: EVIL, unit: EVIL, note: EVIL, spark: { values: [1, 2], label: EVIL } }),
      kit.notice(t, { tone: 'info', lead: EVIL, text: EVIL, action: { label: EVIL, href: EVIL } }),
      kit.dataTable(t, { id: 'x', caption: EVIL, columns: [{ label: EVIL }], rows: [], emptyText: EVIL }),
      kit.filterBar({ search: { id: 's', label: EVIL, placeholder: EVIL, value: EVIL }, chips: [{ label: EVIL, removeLabel: EVIL }] }),
      kit.bulkBar(t, { countLabel: EVIL, actions: [{ label: EVIL }] }),
      kit.drawer(t, { id: 'd', title: EVIL, bodyHtml: '' }),
      kit.dialog(t, { id: 'g', title: EVIL, bodyHtml: '' }),
      kit.rowMenu({ id: 'm', label: EVIL, items: [{ label: EVIL, shortcut: EVIL }] }),
      kit.tabs({ label: EVIL, tabs: [{ id: 'a', label: EVIL, panelId: 'p', selected: true }] }),
      kit.stepper({ label: EVIL, steps: [{ label: EVIL, sub: EVIL, state: 'done' }] }),
      kit.pagination(t, { summary: EVIL, previous: {}, next: { href: EVIL } }),
      kit.changeReview(t, { title: EVIL, titleId: 'r', rows: [{ label: EVIL, current: EVIL, proposed: EVIL }], tests: [{ command: EVIL, purpose: EVIL }], impact: { lead: EVIL, text: EVIL } }),
      kit.applyBar(t, { pendingCount: 1, tests: [EVIL], discard: {}, apply: {} }),
      kit.formField({ id: 'f', label: EVIL, help: EVIL, error: EVIL, control: { kind: 'input', value: EVIL, placeholder: EVIL } }),
      kit.formField({ id: 'f2', label: 'L', control: { kind: 'textarea', value: EVIL } }),
      kit.switchRow({ id: 'w', label: EVIL, help: EVIL }),
      kit.codeBlock(t, { title: EVIL, code: EVIL }),
      kit.meter({ label: EVIL, valueText: EVIL, note: EVIL }),
      kit.lineChart({ label: EVIL, max: 1, series: [{ label: EVIL, values: [0, 1] }], yTicks: [EVIL], xTicks: [EVIL] }),
      kit.barChart({ label: EVIL, max: 1, bars: [{ label: EVIL, value: 1 }] }),
      kit.emptyState({ icon: 'database', title: EVIL, text: EVIL }),
      kit.errorState(t, { lead: EVIL, text: EVIL, detail: EVIL }),
      kit.leadCell({ initial: EVIL, title: EVIL, meta: EVIL }),
    ]
    for (const html of rendered) {
      expect(html).not.toContain('<img')
      expect(html).toContain(SAFE)
    }
  })

  it('pass data-* hooks through to every component root', () => {
    const rendered = [
      kit.statusPill({ tone: 'ok', label: 'A', hooks }),
      kit.pageHeader(t, { breadcrumb: [{ label: 'A' }], title: 'A', hooks }),
      kit.card({ bodyHtml: '', hooks }),
      kit.kpiCard({ label: 'A', value: '1', hooks }),
      kit.notice(t, { tone: 'ok', text: 'A', hooks }),
      kit.dataTable(t, { id: 'x', caption: 'A', columns: [], rows: [], regionHooks: hooks }),
      kit.filterBar({ hooks }),
      kit.bulkBar(t, { countLabel: '1', actions: [], hooks }),
      kit.drawer(t, { id: 'd', title: 'A', bodyHtml: '', hooks }),
      kit.dialog(t, { id: 'g', title: 'A', bodyHtml: '', hooks }),
      kit.rowMenu({ id: 'm', label: 'A', items: [], hooks }),
      kit.tabs({ label: 'A', tabs: [], hooks }),
      kit.tabPanel({ id: 'p', tabId: 'a', bodyHtml: '', hooks }),
      kit.stepper({ label: 'A', steps: [], hooks }),
      kit.pagination(t, { summary: '1', previous: {}, next: {}, hooks }),
      kit.changeReview(t, { title: 'A', titleId: 'r', rows: [], tests: [], hooks }),
      kit.applyBar(t, { pendingCount: 1, discard: {}, apply: {}, hooks }),
      kit.formField({ id: 'f', label: 'A', control: { kind: 'input' }, hooks }),
      kit.codeBlock(t, { code: '', hooks }),
      kit.meter({ label: 'A', valueText: '1', hooks }),
      kit.emptyState({ icon: 'database', title: 'A', hooks }),
      kit.loadingState(t, { hooks }),
      kit.errorState(t, { lead: 'A', hooks }),
    ]
    for (const html of rendered) expect(html).toContain(' data-test-hook="yes"')
  })

  it('carry the ARIA of the kit recipes', () => {
    const header = kit.pageHeader(t, { breadcrumb: [{ label: 'Home', href: '/whm' }, { label: 'Accounts' }], title: 'Accounts', status: { tone: 'ok', label: 'Applied' } })
    expect(header).toMatch(/<nav class="v2-crumbs" aria-label="Breadcrumb"><ol>/)
    expect(header).toContain('<span aria-current="page">Accounts</span>')
    expect(header).toMatch(/<h1>Accounts<\/h1>/)

    expect(kit.card({ title: 'Usage', titleId: 'usage', bodyHtml: '' })).toMatch(/<section class="v2-card" aria-labelledby="usage"><div class="v2-card__head"><div class="v2-card__title"><h2 id="usage">/)
    expect(() => kit.card({ title: 'Usage', bodyHtml: '' })).toThrow(/titleId/)

    expect(kit.statusPill({ tone: 'neutral', label: 'Not installed', hollow: true })).toMatch(/v2-pill--hollow"><span class="v2-pill__dot" aria-hidden="true"><\/span>Not installed/)
    expect(kit.notice(t, { tone: 'bad', text: 'x', urgent: true })).toContain('role="alert"')
    expect(kit.notice(t, { tone: 'ok', text: 'x', dismiss: { 'data-dismiss': true } })).toMatch(/<button type="button" class="v2-notice__dismiss" aria-label="Dismiss" data-dismiss>/)
    expect(kit.notice(t, { tone: 'ok', text: 'x' })).not.toContain('<button')

    const table = kit.dataTable(t, { id: 'acc', caption: 'Accounts', columns: [{ label: 'Account' }], actions: true, selectAll: { label: 'Select all' },
      rows: [{ cellsHtml: ['alice'], select: { label: 'Select alice', checked: true }, actionsHtml: '<button type="button">Manage</button>' }], bodyHooks: { 'data-account-rows': true } })
    expect(table).toMatch(/<div class="v2-table-scroll" role="region" aria-labelledby="acc-caption" tabindex="0">/)
    expect(table).toContain('<caption id="acc-caption" class="v2-sr">Accounts</caption>')
    expect(table).toContain('<th scope="col" class="v2-table__actions"><span class="v2-sr">Actions</span></th>')
    expect(table).toContain('<input type="checkbox" aria-label="Select all">')
    expect(table).toContain('<input type="checkbox" aria-label="Select alice" checked>')
    expect(table).toContain('<tbody data-account-rows>')
    expect(table.match(/<th scope="col"/g)).toHaveLength(3)

    const loading = kit.dataTable(t, { id: 'l', caption: 'L', columns: [{ label: 'A' }, { label: 'B' }], rows: [], state: 'loading', loadingRows: 2 })
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('data-table-state="loading"')
    expect(loading).toContain('colspan="2"')
    expect(kit.dataTable(t, { id: 'e', caption: 'E', columns: [], rows: [] })).toContain('data-table-state="empty"><td colspan="0"><p role="status">')
    const failed = kit.dataTable(t, { id: 'f', caption: 'F', columns: [{ label: 'A' }], rows: [], state: 'error', error: { lead: 'Not read.', retry: { 'data-retry': true } } })
    expect(failed).toMatch(/data-table-state="error">.*role="alert".*data-retry>.*Retry/)

    expect(kit.bulkBar(t, { countLabel: '2 selected', actions: [], hidden: true })).toMatch(/role="region" aria-label="Bulk actions" hidden>.*role="status"/)
    expect(kit.drawer(t, { id: 'ed', title: 'Edit', bodyHtml: '', close: { 'data-close': true } })).toMatch(/<aside class="v2-drawer" id="ed" aria-labelledby="ed-title">.*<h2 id="ed-title">Edit<\/h2><button[^>]*aria-label="Close" data-close>/s)
    expect(kit.dialog(t, { id: 'x', title: 'Terminate?', bodyHtml: '', alert: true, describedBy: 'x-body' })).toMatch(/role="alertdialog" aria-modal="true" aria-labelledby="x-title" aria-describedby="x-body" hidden/)
    expect(kit.dialog(t, { id: 'y', title: 'Y', bodyHtml: '', open: true })).not.toContain(' hidden')

    const menu = kit.rowMenu({ id: 'm1', label: 'Actions for alice', items: [{ label: 'Modify', hooks: { 'data-row-action': 'modify' } }, { label: 'Terminate', danger: true, separatorBefore: true, href: '/x' }] })
    expect(menu).toMatch(/<button type="button" class="v2-btn v2-btn--icon" popovertarget="m1" aria-haspopup="menu" aria-controls="m1" aria-label="Actions for alice">/)
    expect(menu).toContain('<ul class="v2-menu__list" id="m1" role="menu" aria-label="Actions for alice" popover>')
    expect(menu).toContain('<li role="none"><button type="button" role="menuitem" class="v2-menu__item" data-row-action="modify">Modify</button></li>')
    expect(menu).toContain('<li role="separator"></li><li role="none"><a role="menuitem"')

    const tabList = kit.tabs({ label: 'Site settings', tabs: [{ id: 'a', label: 'A', panelId: 'pa', selected: true }, { id: 'b', label: 'B', panelId: 'pb', selected: false }] })
    expect(tabList).toContain('role="tablist" aria-label="Site settings"')
    expect(tabList).toContain('<button type="button" role="tab" id="a" aria-selected="true" aria-controls="pa" tabindex="0">')
    expect(tabList).toContain('id="b" aria-selected="false" aria-controls="pb" tabindex="-1"')
    expect(kit.tabPanel({ id: 'pa', tabId: 'a', bodyHtml: '', hidden: true })).toBe('<div class="v2-tabpanel" role="tabpanel" id="pa" aria-labelledby="a" tabindex="0" hidden></div>')

    const steps = kit.stepper({ label: 'Steps', steps: [{ label: 'One', state: 'done' }, { label: 'Two', state: 'current' }, { label: 'Three', state: 'upcoming' }] })
    expect(steps).toContain('<ol class="v2-steps" aria-label="Steps">')
    expect(steps.match(/aria-current="step"/g)).toHaveLength(1)
    expect(steps).toContain('data-step-status="current" aria-current="step"')

    const pages = kit.pagination(t, { summary: '1-25 of 44', previous: { disabled: true }, next: { href: '?page=2' } })
    expect(pages).toMatch(/<nav class="v2-pagination" aria-label="Pagination">/)
    expect(pages).toMatch(/aria-label="Previous page" disabled>/)
    expect(pages).toMatch(/<a class="v2-btn v2-btn--icon" href="\?page=2" aria-label="Next page">/)

    const field = kit.formField({ id: 'dom', label: 'Primary domain', help: 'Lowercase.', error: 'Two dots.', control: { kind: 'input', name: 'domain', mono: true, required: true } })
    expect(field).toMatch(/<label for="dom">Primary domain<\/label><input id="dom" name="domain" required class="v2-mono" aria-describedby="dom-error dom-help" aria-invalid="true"/)
    expect(field).toContain('id="dom-error"')
    expect(field).toContain('id="dom-help"')
    expect(kit.formField({ id: 'p', label: 'Plan', control: { kind: 'select', options: [{ value: 'b', label: 'Business', selected: true }] } })).toContain('<option value="b" selected>Business</option>')
    expect(kit.switchRow({ id: 'ssl', label: 'AutoSSL', checked: true })).toMatch(/<input type="checkbox" role="switch" id="ssl" checked>/)

    expect(kit.codeBlock(t, { title: 'a.slice', code: 'x', copy: { 'data-copy': 'a' } })).toMatch(/dir="ltr".*aria-label="Copy a.slice" data-copy="a"/s)
    expect(kit.codeBlock(t, { code: 'x' })).not.toContain('<button')

    const review = kit.changeReview(t, { title: 'Change review', titleId: 'cr', rows: [{ label: 'Plan', current: 'Starter', proposed: 'Business' }, { label: 'Shell', current: 'jailed', proposed: 'jailed' }], tests: [{ command: 'nginx -t', purpose: 'checks every server block.' }], rollbackGeneration: 142 })
    expect(review).toContain('aria-labelledby="cr"')
    expect(review.match(/v2-review__changed/g)).toHaveLength(1)
    expect(review).toContain('Generation 142 stays on disk as the rollback target.')
    expect(review).toContain('<ol><li><code>nginx -t</code> checks every server block.</li></ol>')
    const bar = kit.applyBar(t, { pendingCount: 2, tests: ['nginx -t'], nextGeneration: 143, rollbackGeneration: 142, discard: { 'data-discard': true }, apply: { 'data-apply': true } })
    expect(bar).toContain('data-state="pending"')
    expect(kit.applyBar(t, { pendingCount: 0, discard: {}, apply: {} })).toContain('data-state="clean"')
    expect(bar).toMatch(/role="status"><span class="v2-apply__dot" aria-hidden="true"><\/span><strong>2 pending changes<\/strong>/)
    expect(bar).toContain('Applies as generation 143; generation 142 stays as the rollback target')
    expect(bar).toMatch(/data-discard>Discard<\/button><button type="button" class="v2-btn v2-btn--primary" data-apply>Review and apply/)

    expect(kit.lineChart({ label: 'CPU', max: 100, series: [{ label: 'CPU', values: [0, 50, 100] }, { label: 'Memory', values: [10, 20], dashed: true }] }))
      .toMatch(/role="img" aria-label="CPU".*stroke-dasharray/s)
    expect(kit.kpiCard({ label: 'CPU', value: '28', valueHooks: { 'data-live-kpi': 'cpu' }, meter: { percent: 140 } })).toContain('<span data-live-kpi="cpu">28</span>')
    expect(kit.kpiCard({ label: 'CPU', value: '28', meter: { percent: 140 } })).toContain('inline-size:100%')
    expect(kit.loadingState(t, { label: 'Loading databases' })).toMatch(/aria-busy="true"><span class="v2-sr" role="status">Loading databases<\/span>/)
    expect(kit.errorState(t, { lead: 'Not read.', retry: { 'data-retry': true } })).toMatch(/role="alert".*data-retry>.*Retry/s)
    expect(kit.toastRegion(t)).toBe('<div id="xp-toast-region" class="v2-toasts" role="status" aria-live="polite" aria-label="Notifications"></div>')
  })

  it('match the template boards: header pill, labelled filters, inline steps, threshold meters and the review', () => {
    // The page status pill sits beside the title; the generation stamp heads the actions.
    const header = kit.pageHeader(t, { breadcrumb: [{ label: 'Home' }], title: 'API tokens', status: { tone: 'ok', label: '3 active' }, stamp: { tone: 'ok', label: 'Applied · generation 142', meta: '14:05 UTC' }, actionsHtml: '<a class="v2-btn" href="/x">Audit log</a>' })
    expect(header).toMatch(/<div class="v2-page-head__text"><div class="v2-page-head__title"><h1>API tokens<\/h1><span class="v2-pill v2-pill--ok">.*3 active<\/span><\/div>/)
    expect(header).toMatch(/<div class="v2-page-head__actions"><div class="v2-page-head__status"><span class="v2-pill v2-pill--ok">.*Applied · generation 142<\/span><span class="v2-num v2-muted">14:05 UTC<\/span><\/div><a class="v2-btn"/)

    // A bar of fields shows each label above its control; segments alone keep an aria-label only.
    const bar = kit.filterBar({ search: { id: 'q', label: 'Contains text' }, selects: [{ id: 'acct', label: 'Mentions account', options: [{ value: '', label: 'Any' }] }],
      segments: { label: 'Level', options: [{ label: 'All', pressed: true }] }, clear: { label: 'Clear filters' } })
    expect(bar).toContain('<div class="v2-filter v2-filter--fields"><div class="v2-filter__field v2-filter__search"><label class="v2-filter__label" for="q">Contains text</label><span class="v2-filter__input">')
    expect(bar).toContain('<div class="v2-filter__field v2-filter__select"><label class="v2-filter__label" for="acct">Mentions account</label><span class="v2-select"><select id="acct">')
    expect(bar).toContain('<div class="v2-filter__field v2-filter__group"><span class="v2-filter__label" aria-hidden="true">Level</span><div class="v2-segmented" role="group" aria-label="Level">')
    expect(bar).not.toContain('v2-sr')
    expect(kit.filterBar({ segments: { label: 'Show', options: [] } })).toBe('<div class="v2-filter"><div class="v2-segmented" role="group" aria-label="Show"></div></div>')
    // 8px from label to control; the controls themselves take the 44px target from the base styles.
    expect(FILTER_BAR_CSS).toContain('.v2-filter__field{display:flex;flex-direction:column;gap:var(--space-1);')
    expect(V2_BASE_CSS).toMatch(/:is\([^)]*\),select,textarea\)\{min-height:var\(--target\)/)

    // Inline steps: marker, label and rail side by side.
    expect(kit.stepper({ label: 'Steps', inline: true, steps: [{ label: 'Pick', sub: 'Done', state: 'done' }] }))
      .toMatch(/^<ol class="v2-steps v2-steps--inline" aria-label="Steps"><li class="v2-step" data-step-status="done"><span class="v2-step__dot">.*<\/span><span class="v2-step__text"><span class="v2-step__label">Pick<\/span><span class="v2-step__sub v2-num">Done<\/span><\/span><span class="v2-step__rail" aria-hidden="true"><\/span><\/li><\/ol>$/)

    // Meters report their value; a threshold meter adds its scale and the warning and problem ticks.
    expect(kit.meter({ label: 'Disk', valueText: '3.2 / 10 GB', percent: 32 })).toContain('<div class="v2-bar" role="meter" aria-label="Disk" aria-valuenow="32" aria-valuemin="0" aria-valuemax="100" aria-valuetext="Disk 3.2 / 10 GB">')
    expect(kit.meter({ label: 'Mail', valueText: '412 MB / unlimited' })).toContain('<div class="v2-bar" aria-hidden="true">')
    const graded = kit.meter({ label: 'Certificate validity left', valueText: '13 days', unit: 'alice-shop.com', tone: 'warn', scale: { value: 13, max: 60, warn: 14, minText: '0 days', maxText: '60 days' }, note: 'Warning under 14 days' })
    expect(graded).toContain('<span class="v2-meter__value v2-num"><span class="v2-text--warn">13 days</span><span class="v2-meter__unit">alice-shop.com</span></span>')
    expect(graded).toContain('role="meter" aria-label="Certificate validity left" aria-valuenow="13" aria-valuemin="0" aria-valuemax="60" aria-valuetext="Certificate validity left 13 days alice-shop.com"')
    expect(graded).toContain('<span class="v2-meter__tick v2-meter__tick--warn" style="inset-inline-start:23.3%"></span></div>')
    expect(graded).not.toContain('tick--bad')

    // Per-field review rows carry Undo with the field it restores; the side review stacks label over value.
    const rows = kit.changeReview(t, { title: 'Review changes', titleId: 'rv', layout: 'fields', tests: [], rows: [{ label: 'Spam score', current: '7', proposed: '6', field: 'score' }, { label: 'Note', current: 'a', proposed: 'b' }] })
    expect(rows).toContain('data-xp-action="undo" data-xp-field="score" aria-label="Undo the change to Spam score">Undo</button>')
    expect(rows.match(/data-xp-action="undo"/g)).toHaveLength(2)
    expect(rows).toContain('<template data-xp-template="review-row">')
    const sides = kit.changeReview(t, { title: 'Review changes', titleId: 'rv', tests: [], rows: [{ label: 'Plan', current: 'Starter', proposed: 'Business' }], steps: { label: 'What saving does', items: [{ icon: 'files', text: 'Writes the file.' }] }, actions: { back: { hooks: { 'data-back': true } }, save: { label: 'Save settings', hooks: { 'data-save': true } } } })
    expect(sides).not.toContain('<template')
    expect(sides).toMatch(/<ul class="v2-review__steps" aria-label="What saving does"><li><svg.*<\/svg><span>Writes the file.<\/span><\/li><\/ul><div class="v2-review__actions"><button type="button" class="v2-btn" data-back>Back to editing<\/button><button type="button" class="v2-btn v2-btn--primary" data-save>Save settings<\/button><\/div>/s)
  })

  it('mirror only directional icons', () => {
    const header = kit.pageHeader(t, { breadcrumb: [{ label: 'Home', href: '/' }, { label: 'Here' }], title: 'T' })
    expect(header).toMatch(/class="v2-icon v2-flip"/)
    const notice = kit.notice(t, { tone: 'warn', text: 'x', dismiss: {} })
    expect(notice).not.toContain('v2-flip')
  })
})
