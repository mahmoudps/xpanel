import { describe, expect, it } from 'vitest'
import { v2Messages } from '../messages.ts'
import * as layouts from './index.ts'
import { xpTemplate } from './common.ts'
import { statePill } from '../components/status-pill.ts'

const t = v2Messages.translator('en')
const EVIL = '<img src=x onerror="alert(1)">'
const SAFE = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
const header = (title = 'Page') => ({ breadcrumb: [{ label: 'Home', href: '/' }, { label: 'Section' }, { label: title }], route: '/x', title })
const table = { id: 'tbl', caption: 'Rows', columns: [{ label: 'Name' }, { label: 'State' }], rows: [{ cellsHtml: ['alice', 'ok'], hooks: { 'data-row': 'alice' } }] }

const list = (overrides: Partial<layouts.ListPageProps> = {}, text = 'Tokens') => layouts.listPage(t, {
  header: header(text), hooks: { 'data-list-workspace': true },
  kpis: { label: text, items: [{ label: text, value: '4', note: text }] },
  listNotices: [{ tone: 'info', text }],
  list: { title: text, titleId: 'list-title', status: text, statusHooks: { 'data-list-status': true },
    quickFilters: { label: text, options: [{ label: text, count: 1, pressed: true, hooks: { 'data-quick': 'all' } }] },
    filters: { search: { id: 's', label: text, hooks: { 'data-list-search': true } }, clear: { label: text, hooks: { 'data-list-clear': true } } },
    bulk: { countLabel: text, actions: [{ label: text, tone: 'bad', hooks: { 'data-bulk': 'revoke' } }], clear: { 'data-bulk-clear': true }, hidden: true },
    table: { ...table, caption: text, actions: true, selectAll: { label: text, hooks: { 'data-select-all': true } }, bodyHooks: { 'data-list-rows': true } },
    pagination: { summary: text, previous: { disabled: true }, next: { hooks: { 'data-page-next': true } } },
    footer: { count: text, note: text } },
  rowTemplate: { cellsHtml: ['<span data-xp-slot="name"></span>', '<span data-xp-slot="state"></span>'], select: { label: '', hooks: { 'data-row-select': true } }, actionsHtml: '<span data-xp-slot="menu"></span>' },
  rowMenuTemplate: { id: 'row-menu', label: text, items: [{ label: text, hooks: { 'data-xp-action': 'revoke' } }] },
  drawers: [{ id: 'tok-form', title: text, bodyHtml: '', close: { 'data-drawer-close': true } }, { id: 'tok-detail', title: text, bodyHtml: '', template: true }],
  ...overrides,
})

const settings = (commit: layouts.SettingsCommit, text = 'Spam filters') => layouts.settingsPage(t, {
  header: header(text), hooks: { 'data-settings-workspace': true },
  sections: [{ title: text, titleId: 'filtering', description: text, fields: [
    { kind: 'switch', id: 'sw', label: text, help: text, checked: true, hooks: { 'data-setting': 'filter' } },
    { kind: 'field', id: 'score', label: text, control: { kind: 'input', value: text, name: 'score', hooks: { 'data-setting': 'score' } } }] }],
  commit, aside: [{ title: text, titleId: 'effect', bodyHtml: '' }],
  dialogs: [{ id: 'discard', title: text, bodyHtml: '', alert: true }],
})
const review = (text: string) => ({ title: text, titleId: 'review-title', rows: [{ label: text, current: 'Off', proposed: 'On' }], tests: [{ command: 'rspamadm configtest', purpose: 'parses the whole rspamd configuration with your values.' }], rollbackGeneration: 142 })
const fieldReview = (text: string): layouts.SettingsCommit['review'] => ({ ...review(text), layout: 'fields', currentLabel: 'Current · gen 142', status: { tone: 'info', label: '2 pending' }, emptyText: text, rowsHooks: { 'data-review-rows': true },
  rows: [{ label: text, current: '7', proposed: '6', field: 'score' }, { label: 'Allow list', current: '2 entries', proposed: '3 entries', field: 'allow', detail: '+ a@example.com', invalid: true }] })

const custom = (state: layouts.CustomPageProps['state'], text = 'Virus scanner') => layouts.customPage(t, {
  header: header(text), state, hooks: { 'data-custom-workspace': true },
  states: { notInstalled: { lead: text, text }, error: { lead: text, retry: { 'data-retry': true } }, empty: { icon: 'shield', title: text } },
  sections: [{ title: text, titleId: 'engine', bodyHtml: '' }, { title: text, titleId: 'history', full: true, bodyHtml: '' }],
})

const dashboard = (text = 'Server health') => layouts.dashboardPage(t, {
  header: header(text), hooks: { 'data-health-workspace': true },
  kpis: { label: text, items: [{ label: text, value: '91', unit: '%', meter: { percent: 91, tone: 'bad' } }] },
  charts: [{ title: text, titleId: 'cpu', chart: { kind: 'line', label: text, max: 100, series: [{ label: text, values: [1, 2, 3] }] } }, { title: text, titleId: 'req', chart: { kind: 'bar', label: text, max: 10, bars: [{ label: '8', value: 3 }] } }],
  lists: [{ title: text, titleId: 'checks', filters: { label: text, options: [{ label: text, pressed: true }] }, listHooks: { 'data-check-list': true },
    items: [{ title: text, text, icon: 'disk', status: { tone: 'bad', label: text }, metric: { label: text, value: text }, hooks: { 'data-check': 'disk' } }],
    itemTemplate: { icon: 'activity', actionsHtml: '<a class="v2-btn" data-xp-action="open">Fix</a>' } }],
  meters: { title: text, titleId: 'meters-title', description: text, items: [
    { label: text, valueText: '0.26', unit: 'of 4 processors', scale: { value: 0.26, max: 2.5, warn: 1, bad: 2, minText: '0', maxText: '2.5' }, valueLabel: text, note: text },
    { label: 'Swap used', valueText: 'None', untracked: 'No swap is configured, so swap is not graded' }] },
  sections: [{ title: text, titleId: 'thr', bodyHtml: '' }],
})

const wizard = (blocked?: string, text = 'Convert addon domain') => layouts.wizardPage(t, {
  header: header(text), label: text, hooks: { 'data-wizard-workspace': true },
  steps: [
    { id: 'domain', label: text, state: 'done', title: text, bodyHtml: '<p>domain</p>', panelHooks: { 'data-wizard-step': 'domain' } },
    { id: 'review', label: text, state: 'current', title: text, review: review(text), panelHooks: { 'data-wizard-step': 'review' } },
    { id: 'run', label: text, state: 'upcoming', title: text, bodyHtml: '<p>run</p>' },
  ],
  summary: [{ label: text, value: text, mono: true }],
  nav: { back: { hooks: { 'data-wizard-back': true } }, next: { label: text, hooks: { 'data-wizard-next': true }, blockedReason: blocked }, note: text },
})

const log = (text = 'Logs', state: layouts.ListState = 'ready') => layouts.logPage(t, {
  header: header(text), hooks: { 'data-log-workspace': true },
  query: { title: text, titleId: 'read-title', fields: [{ id: 'unit', label: text, control: { kind: 'select', name: 'unit', options: [{ value: 'nginx.service', label: text }] } }], submit: { label: text, hooks: { 'data-log-read': true } } },
  stream: { title: text, titleId: 'tail-title', meta: text, state, table: { ...table, caption: text, bodyHooks: { 'data-log-rows': true } },
    filters: { search: { id: 'q', label: text } }, error: { lead: text },
    follow: { hooks: { 'data-log-follow-interval': 5 }, status: text, retryHooks: { 'data-retry': 'follow' } },
    footer: { count: text }, entryTemplate: { cellsHtml: ['<span data-xp-slot="time"></span>', `${statePill()}<span data-xp-slot="message"></span>`],
      detailsActionsHtml: '<button type="button" class="v2-btn" data-xp-action="copy">Copy</button><a class="v2-btn" data-xp-action="open">Open in audit log</a>' } },
})

const editor = (ready: boolean, text = 'Error pages', code = 'ErrorDocument 404 /404.html\nErrorDocument 503 /503.html') => layouts.editorPage(t, {
  header: header(text), hooks: { 'data-editor-workspace': true },
  context: { title: text, titleId: 'file-title', bodyHtml: '' },
  editor: { title: text, titleId: 'block-title', tabs: { label: text, tabs: [{ id: 'tab-draft', label: text, panelId: 'block-panel', selected: true }, { id: 'tab-live', label: text, panelId: 'block-panel', selected: false }, { id: 'tab-diff', label: text, panelId: 'diff-panel', selected: false }] },
    field: { id: 'block', name: 'block', label: text, value: code, hooks: { 'data-editor-input': true } }, gutterHooks: { 'data-editor-gutter': true }, footer: { meta: text, note: text },
    diff: { label: text, panelId: 'diff-panel', hooks: { 'data-editor-diff': true }, lines: [{ text: '# BEGIN xPanel' }, { text: 'ErrorDocument 404 /old.html', change: 'removed' }, { text: `ErrorDocument 404 ${text}`, change: 'added' }] } },
  snippets: { title: text, titleId: 'snip', items: [{ label: text, description: text, code: `${text} <b>`, hooks: { 'data-snippet': '404' } }] },
  test: { titleId: 'test-title', status: { tone: 'neutral', label: text }, run: { label: text, hooks: { 'data-editor-test': true } }, outputLabel: text, output: text, outputHooks: { 'data-editor-output': true } },
  save: { label: text, ready, hooks: { 'data-editor-save': true }, discard: { hooks: { 'data-editor-discard': true } } },
})

const matrix = (text = 'Notifications') => layouts.matrixPage(t, {
  header: header(text), hooks: { 'data-matrix-workspace': true },
  matrix: { title: text, titleId: 'matrix-title', status: text, caption: text, eventColumn: text, leadColumns: [text],
    quickFilters: { label: text, options: [{ label: text, pressed: true }] },
    channels: [{ label: text, note: text, fixed: text }, { label: text, note: text, noteTone: 'warn', all: { label: text, hooks: { 'data-channel-all': 'email' } } }],
    groups: [{ label: text, countText: text, hooks: { 'data-group': 'accounts' }, switches: [{ label: text, checked: true, hooks: { 'data-group-all': 'accounts' } }],
      events: [{ label: text, key: 'account.created', cellsHtml: ['Reconciler'], switches: [{ label: text, checked: true, hooks: { 'data-event': 'account.created' } }], changed: text, hooks: { 'data-event-row': 'account.created' } }] }] },
  aside: [{ title: text, titleId: 'rcp', bodyHtml: '' }], asideLabel: text,
  review: { title: text, titleId: 'review-title', id: 'nt-review', meta: text, currentLabel: 'Current · saved 2026-10-22 14:05 UTC', rows: [{ label: text, current: 'Off', proposed: 'Email' }], tests: [],
    steps: { label: 'What saving does', items: [{ icon: 'files', text }, { icon: 'check', text }] },
    actions: { back: { hooks: { 'data-review-back': true } }, save: { hooks: { 'data-review-save': true } } } },
  save: { pendingCount: 2, revision: 'r-7"><x', discard: { 'data-discard': true }, save: { 'data-save': true } },
})

const count = (html: string, pattern: RegExp): number => html.match(new RegExp(pattern.source, 'g'))?.length ?? 0

describe('v2 page layouts', () => {
  it('escape caller text in every layout', () => {
    const rendered = [
      list({}, EVIL), settings({ kind: 'apply', review: review(EVIL), bar: { pendingCount: 1, tests: [EVIL], discard: {}, apply: {} } }, EVIL),
      settings({ kind: 'revision', review: fieldReview(EVIL), bar: { pendingCount: 1, revision: 'r', discard: {}, save: {} } }, EVIL),
      custom('not-installed', EVIL), custom('error', EVIL), dashboard(EVIL), wizard(EVIL, EVIL), log(EVIL), editor(false, EVIL, EVIL), matrix(EVIL),
    ]
    for (const html of rendered) {
      expect(html).not.toContain('<img')
      expect(html).toContain(SAFE)
    }
    expect(matrix()).toContain('<input type="hidden" name="revision" value="r-7&quot;&gt;&lt;x">')
  })

  it('build the page top and root hooks of every layout', () => {
    for (const html of [list(), settings({ kind: 'revision', bar: { pendingCount: 1, revision: 'r1', discard: {}, save: {} } }), custom('ready'), dashboard(), wizard(), log(), editor(true), matrix()]) {
      expect(html).toMatch(/^<div class="v2-layout" data-[a-z-]+-workspace><header class="v2-page-head">/)
      expect(count(html, /<h1>/)).toBe(1)
      expect(html).toContain('<nav class="v2-crumbs" aria-label="Breadcrumb">')
    }
    const top = list()
    expect(top).toMatch(/<section class="v2-kpi-row" aria-label="Tokens"><article class="v2-kpi">\s*<div class="v2-kpi__head"><h2>/)
    expect(top).toMatch(/<span>Section<\/span><svg class="v2-icon v2-flip"/)
  })

  it('list: filters, table, bulk bar, pagination, drawers and the row and menu templates', () => {
    const html = list()
    expect(html).toContain('<section class="v2-card v2-card--flush" aria-labelledby="list-title">')
    expect(html).toContain('<p role="status" data-list-status>Tokens</p>')
    for (const hook of ['data-quick="all"', 'data-list-search', 'data-list-clear', 'data-bulk="revoke"', 'data-bulk-clear', 'data-select-all', 'data-list-rows', 'data-row="alice"', 'data-page-next', 'data-drawer-close']) expect(html, hook).toContain(` ${hook}`)
    expect(html).toMatch(/role="region" aria-label="Bulk actions" hidden/)
    expect(html).toContain('<div class="v2-split" data-xp-drawer-host><div class="v2-stack v2-stack--tight"><div class="v2-notice v2-notice--info" role="status">')
    expect(html).toContain('<aside class="v2-drawer" id="tok-form" aria-labelledby="tok-form-title">')
    expect(html).toContain('<template data-xp-template="list-row"><tr><td class="v2-table__check"><input type="checkbox" aria-label="" data-xp-action="select" data-row-select></td><td><span data-xp-slot="name"></span></td><td><span data-xp-slot="state"></span></td><td class="v2-table__actions"><span data-xp-slot="menu"></span></td></tr></template>')
    expect(html).toMatch(/<template data-xp-template="row-menu"><span class="v2-menu"><button[^>]*aria-haspopup="menu"[^>]*data-xp-action="menu">.*role="menu".*data-xp-action="revoke"/s)
    expect(html).toMatch(/<template data-xp-template="tok-detail"><aside class="v2-drawer" id="tok-detail"/)
    expect(html).toContain('<span class="v2-num" aria-live="polite">Tokens</span>')
  })

  it('list: empty, no-match, loading and error states come from the kit blocks', () => {
    const base = { title: 'T', titleId: 't', table }
    const empty = list({ list: { ...base, state: 'empty', empty: { icon: 'shield', title: 'No API tokens yet' } } })
    expect(empty).toContain('<div class="v2-state v2-state--empty"><span class="v2-state__icon" aria-hidden="true">')
    expect(empty).not.toContain('<table')
    expect(list({ list: { ...base, state: 'no-match', noMatch: { icon: 'filter', title: 'No token matches these filters' } } })).toContain('No token matches these filters')
    const loading = list({ list: { ...base, state: 'loading' } })
    expect(loading).toContain('aria-busy="true"')
    expect(loading).toContain('data-table-state="loading"')
    const failed = list({ list: { ...base, state: 'error', error: { lead: 'Not read.', retry: { 'data-retry': true } } } })
    expect(failed).toMatch(/<div class="v2-state v2-state--error" role="alert">.*data-retry>/s)
    expect(failed).toContain('data-row="alice"')
  })

  it('settings: field sections, the review aside and the apply bar or the revision-checked save', () => {
    const applied = settings({ kind: 'apply', review: fieldReview('Spam'), bar: { pendingCount: 2, tests: ['rspamadm configtest'], nextGeneration: 143, rollbackGeneration: 142, discard: { 'data-discard': true }, apply: { 'data-apply': true } } })
    expect(applied).toContain('<section class="v2-card" aria-labelledby="filtering">')
    expect(applied).toContain('<div class="v2-fields"><label class="v2-switch-row" for="sw">')
    expect(applied).toContain('name="score"')
    expect(applied).toMatch(/<aside class="v2-aside" aria-label="Review changes"><section class="v2-card v2-review" aria-labelledby="review-title">/)
    // Per-field rows: current beside proposed, each with Undo carrying the field it restores.
    expect(applied).toContain('<ul class="v2-review__rows" data-review-rows><li class="v2-review__row" data-state="changed"><div class="v2-review__row-head"><span class="v2-review__name" data-xp-slot="name">Spam</span><button type="button" class="v2-btn v2-btn--ghost v2-review__undo" data-xp-action="undo" data-xp-field="score" aria-label="Undo the change to Spam">Undo</button></div>')
    expect(applied).toContain('<div class="v2-review__box"><span>Current · gen 142</span><span class="v2-num v2-mono" data-xp-slot="current">7</span></div>')
    expect(applied).toContain('<span>Proposed</span><span class="v2-num v2-mono" data-xp-slot="proposed">6</span>')
    expect(applied).toContain('<span class="v2-review__detail v2-mono" data-xp-slot="details" data-empty></span>')
    expect(applied).toMatch(/data-state="invalid">.*data-xp-field="allow".*data-xp-slot="details">\+ a@example.com</s)
    expect(applied).toContain('<p class="v2-review__empty v2-num">Spam</p><template data-xp-template="review-row"><li class="v2-review__row" data-state="changed">')
    expect(applied).toMatch(/<template data-xp-template="review-row">.*<button type="button" class="v2-btn v2-btn--ghost v2-review__undo" data-xp-action="undo">Undo<\/button>.*<\/template>/s)
    expect(applied).toContain('Generation 142 stays on disk as the rollback target.')
    expect(applied).toMatch(/<section class="v2-commit" aria-label="Apply changes"><div class="v2-apply" data-state="pending"><p class="v2-apply__text v2-num" role="status"><span class="v2-apply__dot" aria-hidden="true"><\/span><strong>2 pending changes<\/strong>/)
    expect(applied).toContain('Applies as generation 143; generation 142 stays as the rollback target')
    expect(applied).toMatch(/data-discard>Discard<\/button><button type="button" class="v2-btn v2-btn--primary" data-apply>/)
    expect(applied).toMatch(/role="alertdialog" aria-modal="true" aria-labelledby="discard-title" hidden/)
    const saved = settings({ kind: 'revision', bar: { pendingCount: 1, revision: 'r-41', discard: { 'data-discard': true }, save: { 'data-save': true } } })
    expect(saved).toContain('<section class="v2-commit" aria-label="Save changes">')
    expect(saved).toContain('<input type="hidden" name="revision" value="r-41">')
    expect(saved).toMatch(/data-save>Review and save<\/button>/)
    expect(saved).not.toContain('generation')
    const loading = layouts.settingsPage(t, { header: header(), state: 'loading', sections: [], commit: { kind: 'apply', bar: { pendingCount: 0, discard: {}, apply: {} } } })
    expect(loading).toContain('v2-state--loading')
    expect(loading).not.toContain('v2-apply')
  })

  it('custom: a section grid with the not-installed, error, loading and empty states', () => {
    const missing = custom('not-installed')
    expect(missing).toMatch(/<div class="v2-notice v2-notice--warn" role="status">.*<strong>Virus scanner<\/strong>/s)
    expect(missing).toContain('<div class="v2-grid"><div class="v2-grid__cell"><section class="v2-card" aria-labelledby="engine">')
    expect(missing).toContain('<div class="v2-grid__cell v2-grid__cell--full">')
    expect(layouts.customPage(t, { header: header(), state: 'not-installed', sections: [] })).toContain('<strong>Not installed</strong>')
    expect(custom('error')).toMatch(/role="alert".*data-retry>.*v2-grid/s)
    expect(custom('loading')).toContain('v2-state--loading')
    expect(custom('loading')).not.toContain('v2-grid')
    expect(custom('empty')).toContain('v2-state--empty')
  })

  it('dashboard: KPI grid, chart cards and status lists with their item template', () => {
    const html = dashboard()
    expect(html).toMatch(/aria-labelledby="cpu">.*<svg role="img" aria-label="Server health"/s)
    expect(html).toContain('<figure class="v2-chart v2-chart--bars" dir="ltr">')
    expect(html).toContain('<ul class="v2-status-list" aria-live="polite" data-check-list><li class="v2-status-item" data-state="bad" data-check="disk">')
    expect(html).toMatch(/<h3>Server health<\/h3><span class="v2-pill v2-pill--bad">/)
    expect(html).toContain('<template data-xp-template="status-item"><li class="v2-status-item" data-state="neutral"><span class="v2-tile v2-tile--state" aria-hidden="true">')
    expect(html).toContain('<h3 data-xp-slot="name"></h3><span class="v2-pill v2-pill--state"><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="state"></span></span></div><p data-xp-slot="message"></p></div><p class="v2-status-item__metric v2-num" data-xp-slot="item"></p>')
    // Threshold meters: the measured value on its scale with warning and problem ticks, readable as a meter.
    expect(html).toMatch(/<section class="v2-card" aria-labelledby="meters-title">.*<ul class="v2-legend" aria-label="Legend">.*Measured value.*Warning tick.*Problem tick/s)
    expect(html).toContain('<div class="v2-meter__track" role="meter" aria-label="Server health" aria-valuenow="0.26" aria-valuemin="0" aria-valuemax="2.5" aria-valuetext="Server health">')
    expect(html).toContain('<span class="v2-meter__tick v2-meter__tick--warn" style="inset-inline-start:40%"></span><span class="v2-meter__tick v2-meter__tick--bad" style="inset-inline-start:80%"></span>')
    expect(html).toContain('<div class="v2-meter__scale v2-num" aria-hidden="true"><span>0</span><span>2.5</span></div>')
    expect(html).toContain('<div class="v2-meter__untracked">No swap is configured, so swap is not graded</div>')
    expect(html.indexOf('meters-title')).toBeLessThan(html.indexOf('aria-labelledby="cpu"'))
    expect(html).toContain('role="group" aria-label="Server health"')
    expect(layouts.dashboardPage(t, { header: header(), state: 'loading', lists: [] })).toContain('v2-state--loading')
  })

  it('wizard: stepper, one visible step panel, the review step and gated navigation', () => {
    const html = wizard()
    expect(html).toContain('<ol class="v2-steps v2-steps--inline" aria-label="Steps">')
    expect(html).toMatch(/<li class="v2-step" data-step-status="current" aria-current="step"><span class="v2-step__dot">.*?<\/span><\/span><span class="v2-step__text"><span class="v2-step__label">/)
    expect(count(html, /aria-current="step"/)).toBe(1)
    expect(html).toContain('<dl class="v2-facts" aria-label="Your choices">')
    expect(html).toMatch(/<section class="v2-wizard__panel" aria-labelledby="domain-title" hidden data-wizard-step="domain">/)
    expect(html).toMatch(/<section class="v2-wizard__panel" aria-labelledby="review-title" data-wizard-step="review">.*Step 2 of 3.*<section class="v2-card v2-review"/s)
    expect(count(html, /class="v2-wizard__panel"[^>]*hidden/)).toBe(2)
    expect(html).toMatch(/data-wizard-back>Back<\/button><button type="button" class="v2-btn v2-btn--primary" data-wizard-next>/)
    const blocked = wizard('Review again first.')
    expect(blocked).toContain('aria-disabled="true" aria-describedby="v2-wizard-next-reason" data-wizard-next')
    expect(blocked).toContain('<p id="v2-wizard-next-reason">Review again first.</p>')
  })

  it('log: query, stream root and every follow hook of the core contract', () => {
    const html = log()
    expect(html).toMatch(/<button type="button" class="v2-btn" aria-pressed="false" data-log-follow-interval="5" data-log-follow>/)
    expect(count(html, / data-log-follow[\s>]/)).toBe(1)
    expect(html).toMatch(/<div class="v2-log__stream" role="log" aria-labelledby="tail-title" data-log-stream data-log-follow-state="stopped">/)
    expect(count(html, /role="status"[^>]*data-log-follow-status/)).toBe(1)
    expect(html).toContain('<p class="v2-num" role="status" data-log-follow-status>Logs</p>')
    expect(html).toMatch(/<button type="button" class="v2-btn" data-retry="follow" data-log-follow-retry hidden>/)
    // Each entry is a disclosure: the time is the expand toggle and its details row starts hidden with the slot.
    expect(html).toMatch(/<template data-xp-template="log-entry"><tr data-level="info"><td><button type="button" class="v2-log__toggle" data-xp-action="expand" aria-expanded="false"><svg[^>]*>.*?<\/svg><span data-xp-slot="time"><\/span><\/button><\/td>/)
    expect(html).toContain('<tr class="v2-log__details"><td colspan="2"><div class="v2-log__detail"><dl class="v2-log__facts" data-xp-slot="details" hidden></dl><template data-xp-template="log-fact"><div class="v2-log__fact"><dt data-xp-slot="label"></dt><dd dir="ltr" data-xp-slot="value"></dd></div></template><div class="v2-log__detail-actions"><button type="button" class="v2-btn" data-xp-action="copy">')
    expect(html).toContain('data-log-read>Logs</button>')
    // A caller cannot start the stream in another state.
    const forced = layouts.logPage(t, { header: header(), stream: { title: 'L', titleId: 'l', table, streamHooks: { 'data-log-follow-state': 'following' } } })
    expect(forced).toMatch(/role="log" aria-labelledby="l" data-log-follow-state="stopped" data-log-stream>/)
    expect(forced).toContain('Not following. The entries below are from one read.')
    expect(log('Logs', 'loading')).toContain('data-table-state="loading"')
    expect(log('Logs', 'error')).toMatch(/role="alert".*data-log-stream/s)
  })

  it('editor: line numbers, the snippet slot and the test gate before save', () => {
    const html = editor(false)
    expect(html).toContain('<div class="v2-editor" dir="ltr"><div class="v2-editor__gutter v2-num" aria-hidden="true" data-editor-gutter><span>1</span><span>2</span></div>')
    expect(html).toMatch(/<label class="v2-sr" for="block">Error pages<\/label><textarea class="v2-editor__input" id="block" name="block" rows="8" wrap="off" spellcheck="false"[^>]*data-editor-input>ErrorDocument 404/)
    expect(html).toMatch(/role="tablist" aria-label="Error pages">.*<div class="v2-tabpanel" role="tabpanel" id="block-panel" aria-labelledby="tab-draft"/s)
    expect(html).toContain('<template data-xp-template="snippet">Error pages &lt;b&gt;</template>')
    expect(html).toMatch(/<button type="button" class="v2-btn" aria-controls="block" data-snippet="404">/)
    expect(html).toContain('data-editor-test>')
    expect(html).toMatch(/<pre tabindex="0" aria-live="polite"><code>Error pages<\/code><\/pre>/)
    expect(html).toContain('<p class="v2-apply__text" id="block-save-reason">Save is available after the draft passes its test.</p>')
    expect(html).toContain('aria-disabled="true" aria-describedby="block-save-reason" data-editor-save>')
    // The Changes tab: +/- markers against the saved version, with the change in words on each line.
    expect(html).toContain('<div class="v2-tabpanel" role="tabpanel" id="diff-panel" aria-labelledby="tab-diff" tabindex="0" hidden><div class="v2-diff" dir="ltr"><pre class="v2-diff__lines" role="region" tabindex="0" aria-label="Error pages" data-editor-diff>')
    expect(html).toMatch(/<span class="v2-diff__line" data-state="unchanged"><span class="v2-diff__gutter v2-num" aria-hidden="true"><span class="v2-diff__mark"><\/span><span data-xp-slot="item">1<\/span>/)
    expect(html).toContain('<span class="v2-diff__line" data-state="removed"><span class="v2-diff__gutter v2-num" aria-hidden="true"><span class="v2-diff__mark"></span><span data-xp-slot="item"></span></span><span class="v2-diff__code"><span class="v2-sr v2-diff__added">Added line: </span><span class="v2-sr v2-diff__removed">Removed line: </span><span data-xp-slot="message">ErrorDocument 404 /old.html</span>')
    expect(html).toMatch(/data-state="added"><span class="v2-diff__gutter v2-num" aria-hidden="true"><span class="v2-diff__mark"><\/span><span data-xp-slot="item">2<\/span>/)
    expect(html).toContain('<template data-xp-template="diff-line"><span class="v2-diff__line" data-state="unchanged">')
    const ready = editor(true)
    expect(ready).not.toContain('aria-disabled')
    expect(ready).toMatch(/class="v2-btn v2-btn--primary" data-editor-save>Error pages<\/button>/)
    expect(layouts.editorPage(t, { ...{ header: header(), state: 'error', states: { error: { lead: 'Not read.' } } }, editor: { title: 'E', titleId: 'e', field: { id: 'f', label: 'F', value: '' } }, test: { titleId: 't', status: { tone: 'neutral', label: 'N' }, run: { label: 'R', hooks: {} }, outputLabel: 'O' }, save: { label: 'S', hooks: {}, ready: false } }))
      .not.toContain('<textarea')
  })

  it('matrix: grouped events, channel columns with group switches, the review and the save bar', () => {
    const html = matrix()
    expect(html).toMatch(/<div class="v2-table-scroll" role="region" aria-labelledby="matrix-title-caption" tabindex="0"><table class="v2-table v2-matrix"><caption id="matrix-title-caption" class="v2-sr">/)
    expect(html).toContain('<tbody data-group="accounts"><tr class="v2-matrix__group"><th scope="rowgroup" colspan="2">')
    expect(html).toMatch(/<td><\/td><td><label class="v2-matrix__switch"><input type="checkbox" role="switch" aria-label="Notifications" checked data-group-all="accounts"><span>All in group<\/span><\/label><\/td>/)
    expect(html).toMatch(/<th scope="col"><label class="v2-matrix__switch"><input type="checkbox" role="switch" aria-label="Notifications" data-channel-all="email">/)
    expect(html).toMatch(/<tr data-event-row="account.created"><th scope="row">.*<td>Reconciler<\/td><td><span class="v2-matrix__fixed">.*<\/td><td><label class="v2-matrix__switch"><input type="checkbox" role="switch" aria-label="Notifications" checked data-event="account.created"><\/label><\/td><\/tr>/s)
    expect(html).toContain('<aside class="v2-aside" aria-label="Notifications">')
    expect(html).toContain('<span class="v2-matrix__channel"><span>Notifications</span><span class="v2-text--warn">Notifications</span></span>')
    expect(html).toMatch(/<section class="v2-card v2-review" id="nt-review" aria-labelledby="review-title">\n<div class="v2-card__head"><div class="v2-card__title"><h2 id="review-title">Notifications<\/h2><\/div><span class="v2-review__meta v2-num">Notifications<\/span><\/div>/)
    expect(html).toContain('<div class="v2-review__side"><h3>Current · saved 2026-10-22 14:05 UTC</h3><dl><div><dt>Notifications</dt><dd class="v2-num">Off</dd></div></dl></div>')
    expect(html).not.toContain('v2-review__gate')
    // In review: what saving does, then Back to editing and Save settings.
    expect(html).toMatch(/<ul class="v2-review__steps" aria-label="What saving does"><li><svg[^>]*>.*?<\/svg><span>Notifications<\/span><\/li>/)
    expect(html).toContain('<div class="v2-review__actions"><button type="button" class="v2-btn" data-review-back>Back to editing</button><button type="button" class="v2-btn v2-btn--primary" data-review-save>Save settings</button></div>')
    expect(html).toContain('class="v2-btn v2-btn--primary" aria-controls="nt-review" data-save>Review and save')
    expect(html).toMatch(/<section class="v2-commit" aria-label="Save changes">.*data-discard>Discard<\/button>.*data-save>Review and save/s)
  })

  it('lay out right to left without direction branches; code and charts keep their reading order', () => {
    const ar = v2Messages.translator('ar')
    const html = [layouts.logPage(ar, { header: header(), stream: { title: 'L', titleId: 'l', table } }), editor(false), dashboard()].join('')
    expect(html).not.toMatch(/dir="rtl"|style="[^"]*(?:left|right)/)
    expect(html).toContain('<div class="v2-editor" dir="ltr">')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    // Only directional icons mirror: breadcrumb chevrons do, the follow and snippet icons do not.
    expect(count(editor(false), /v2-flip/)).toBe(2)
  })

  it('keep every template inside its workspace root, in the core template vocabulary', () => {
    // V2-HOOKS: slots take text only from the agreed names; every control in a template carries a verb.
    const SLOTS = new Set(['name', 'state', 'time', 'message', 'item', 'menu', 'details', 'current', 'proposed', 'label', 'value'])
    // Slots v2 asks core to announce (the per-field review values).
    const REQUESTED = new Set(['current', 'proposed'])
    const pages = [list(), settings({ kind: 'revision', review: fieldReview('Spam'), bar: { pendingCount: 1, revision: 'r', discard: {}, save: {} } }), dashboard(), log(), editor(false), matrix()]
    const names = new Set<string>()
    for (const html of pages) {
      // The workspace root opens the page and its matching </div> closes it: every template lies inside.
      expect(html).toMatch(/^<div class="v2-layout" data-[a-z-]+-workspace>/)
      let depth = 0
      let close = -1
      for (const tag of html.matchAll(/<(\/?)div\b/g)) {
        depth += tag[1] ? -1 : 1
        if (depth === 0) { close = tag.index; break }
      }
      expect(close).toBe(html.length - '</div>'.length)
      // Names come from a full scan: a nested template (log-fact inside log-entry) is checked as part of its parent's body.
      for (const [, name] of html.matchAll(/data-xp-template="([^"]+)"/g)) names.add(name!)
      for (const [, name, body] of html.matchAll(/<template data-xp-template="([^"]+)">([\s\S]*?)<\/template>/g)) {
        for (const [, slot] of body!.matchAll(/data-xp-slot="([^"]+)"/g)) expect(SLOTS.has(slot!) || REQUESTED.has(slot!), `${name} slot ${slot}`).toBe(true)
        // Slots are text only: nothing but text between a slot's opening tag and its closing tag.
        expect(body!.match(/<[a-z0-9]+[^>]*data-xp-slot="[^"]+"[^>]*>[^<]*<(?!\/)/g), `${name} slot with markup`).toBeNull()
        for (const [control] of body!.matchAll(/<(?:button|a|input|select|textarea)\b[^>]*>/g)) expect(control, name).toMatch(/ data-xp-action="[a-z]+(?:-[a-z]+)*"/)
        // State is styled from the clone root's attributes, never from a class core would toggle.
        expect(body).not.toMatch(/v2-[a-z-]+--(?:ok|warn|bad|info|neutral|selected)\b/)
      }
    }
    expect([...names].sort()).toEqual(['diff-line', 'list-row', 'log-entry', 'log-fact', 'review-row', 'row-menu', 'snippet', 'status-item', 'tok-detail'])
    // expand: aria-expanded starts false and the details slot of the same clone starts hidden.
    const entry = log().match(/<template data-xp-template="log-entry">([\s\S]*?)<\/template>/)![1]!
    expect(entry).toContain('data-xp-action="expand" aria-expanded="false"')
    expect(entry).toContain('data-xp-slot="details" hidden')
    // undo: the field it restores is data-xp-field, never data-xp-id.
    const review = pages[1]!
    expect(review.match(/data-xp-action="undo" data-xp-field="[a-z]+"/g)).toHaveLength(2)
    expect(review).not.toContain('data-xp-id')
  })

  it('name templates safely', () => {
    expect(xpTemplate('list-row', '<tr></tr>')).toBe('<template data-xp-template="list-row"><tr></tr></template>')
    for (const name of ['', 'A', 'a b', 'a"', '-a']) expect(() => xpTemplate(name, '')).toThrow(/Invalid template name/)
  })
})
