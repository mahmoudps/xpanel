import { escapeHtml } from '../../tokens.ts'
import type { ComposedContext } from './context.ts'
import { copyOf, type ComposedLayout, type ComposedRoute, type Copy } from './types.ts'
import { translator, type MessageValues } from '../../i18n.ts'
interface LayoutContent {
  state: 'unread' | 'empty' | 'loaded' | 'denied' | 'unavailable' | 'failed'
  message: string
  facts: string
  table: string
}

const text = (context: ComposedContext, message: string, values?: MessageValues): string => escapeHtml(translator(context.locale)(message, values))
const groupTitles: Record<ComposedLayout, Copy> = {
  files: msgid('Files and access'),
  site: msgid('Site configuration'),
  database: msgid('Database configuration'),
  metrics: msgid('Measurements'),
  ssl: msgid('Certificate configuration'),
  security: msgid('Security policy'),
  php: msgid('PHP configuration'),
  cron: msgid('Schedule and command'),
  editor: msgid('File editor'),
  launch: msgid('Connection details'),
  list: msgid('Records'),
  settings: msgctxt('layout', 'Configuration'),
  dashboard: msgid('Overview'),
  log: msgid('Log filters'),
  wizard: msgctxt('layout', 'Configuration'),
  matrix: msgid('Policies and assignments'),
  terminal: msgid('Terminal session'),
}

const editorLayouts = new Set<ComposedLayout>(['editor', 'terminal'])
const readLayouts = new Set<ComposedLayout>(['dashboard', 'metrics', 'list', 'log'])
const fieldId = (route: string, index: number): string => `composed-${route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-${index}`

const panel = (id: string, title: string, body: string, extra = ''): string => `<section class="xp-composed-card" aria-labelledby="${id}"${extra}><h2 id="${id}">${title}</h2>${body}</section>`

const controls = (spec: ComposedRoute, context: ComposedContext, reasonId: string): string => {
  if (!spec.fields.length) return ''
  return `<fieldset class="xp-composed-controls" disabled aria-describedby="${reasonId}"><legend class="sr-only">${escapeHtml(copyOf(groupTitles[spec.layout], context.locale))}</legend><div class="xp-composed-fields">${spec.fields.map((field, index) => {
    const id = fieldId(spec.route, index)
    const label = escapeHtml(copyOf(field, context.locale))
    return `<div class="xp-composed-field"><label for="${id}">${label}</label><input class="xp-input" id="${id}" type="text" value="" disabled data-wiring="unavailable" aria-describedby="${reasonId}"></div>`
  }).join('')}</div></fieldset>`
}

const action = (spec: ComposedRoute, context: ComposedContext, reasonId: string): string => spec.action
  ? `<div class="xp-composed-actions"><button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="unavailable" aria-describedby="${reasonId}">${escapeHtml(copyOf(spec.action, context.locale))}</button></div>`
  : ''

/** Preserve a page's layout while distinguishing a missing reader from a completed empty read. */
export const renderComposedLayout = (spec: ComposedRoute, context: ComposedContext, content: LayoutContent): string => {
  const id = fieldId(spec.route, 0)
  const status = `<p class="xp-composed-state" id="${id}-state" role="status">${escapeHtml(content.message)}</p>`
  if (content.state === 'denied') return panel(`${id}-access`, text(context, 'Access required'), status)

  const reasonId = `${id}-reason`
  const reason = `<p id="${reasonId}" class="xp-help">${text(context, 'Changes are unavailable on this screen. No operation will be submitted.')}</p>`
  const fields = controls(spec, context, reasonId)
  const title = escapeHtml(copyOf(groupTitles[spec.layout], context.locale))
  const recordsTitle = spec.layout === 'log' ? text(context, 'Events') : text(context, 'Records')
  const records = content.table ? panel(`${id}-records`, recordsTitle, content.table, ' data-composed-records') : ''
  const facts = content.facts ? panel(`${id}-facts`, text(context, 'Stored information'), content.facts) : ''
  const state = `<div class="xp-composed-state-group">${status}${reason}</div>`

  if (editorLayouts.has(spec.layout)) {
    const editorId = `${id}-editor`
    const editor = `<div class="xp-composed-field"><label for="${editorId}">${spec.layout === 'terminal' ? text(context, 'Session output') : text(context, 'File contents')}</label><textarea class="xp-composed-editor" id="${editorId}" rows="12" dir="ltr" readonly disabled data-wiring="unavailable" aria-describedby="${reasonId}"></textarea></div>`
    return `${panel(`${id}-configuration`, title, `${state}${fields}${editor}${action(spec, context, reasonId)}`, ' data-composed-editor')}${facts}${records}`
  }

  if (spec.layout === 'wizard') {
    const steps: readonly Copy[] = [msgctxt('layout', 'Configure'), msgid('Review changes'), msgid('Apply')]
    const workflow = `<ol class="xp-composed-steps" aria-label="${text(context, 'Workflow')}">${steps.map((step, index) => `<li${index === 0 ? ' aria-current="step"' : ''}><span class="xp-composed-step-number" aria-hidden="true">${index + 1}</span><span>${escapeHtml(copyOf(step, context.locale))}</span></li>`).join('')}</ol>`
    return `${workflow}${panel(`${id}-configuration`, title, `${state}${fields}${action(spec, context, reasonId)}`)}${facts}${records}`
  }

  if (readLayouts.has(spec.layout)) {
    const filters = fields ? panel(`${id}-filters`, title, `${fields}${reason}`) : ''
    const statusPanel = panel(`${id}-overview`, text(context, 'Read status'), status)
    return `${filters}${statusPanel}${facts}${records}${spec.action ? panel(`${id}-actions`, text(context, 'Actions'), `${filters ? '' : reason}${action(spec, context, reasonId)}`) : ''}`
  }

  const matrix = spec.layout === 'matrix' ? ' data-composed-matrix' : ''
  return `${panel(`${id}-configuration`, title, `${state}${fields}${action(spec, context, reasonId)}`, matrix)}${facts}${records}`
}

export const COMPOSED_LAYOUT_CSS = `<style>
.xp-composed-page .xp-composed-state-group{display:flex;flex-direction:column;gap:8px}.xp-composed-page .xp-composed-controls{border:0;padding:0;margin:0;min-inline-size:0}.xp-composed-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}.xp-composed-fields label{font-weight:600}.xp-composed-fields .xp-input{box-sizing:border-box;inline-size:100%;min-inline-size:0}.xp-composed-actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-composed-editor{box-sizing:border-box;inline-size:100%;min-inline-size:0;resize:vertical;min-block-size:240px;padding:16px;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface);color:var(--xp-text-primary);font:inherit;font-family:var(--xp-font-mono);text-align:start}.xp-composed-steps{display:flex;flex-wrap:wrap;gap:16px;list-style:none;margin:0;padding:0}.xp-composed-steps li{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-composed-step-number{display:inline-flex;align-items:center;justify-content:center;inline-size:32px;block-size:32px;border:1px solid var(--xp-border);border-radius:50%;font-variant-numeric:tabular-nums}.xp-composed-steps [aria-current="step"]{font-weight:600}.xp-composed-page .xp-composed-empty-cell{display:table-cell;text-align:start;padding:16px}.xp-composed-controls:disabled .xp-input,.xp-composed-editor:disabled{opacity:1;color:var(--xp-text-secondary)}
@media(max-width:600px){.xp-composed-page .xp-composed-empty-cell{display:block;padding:0}}
</style>`
