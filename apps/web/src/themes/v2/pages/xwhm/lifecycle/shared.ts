import type { Locale, Translate } from '../../../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { card, pageHeader } from '../../../components/index.ts'

/** Admission is supplied by core; a theme never derives permissions from a role name. */
export interface LifecycleAccess {
  readonly locale: Locale
  readonly canRead: boolean
  readonly canManage: boolean
}

export const text = (t: Translate, value: string): string => escapeHtml(t(value))

export function lifecycleHeader(t: Translate, title: string, route: string, description: string): string {
  return pageHeader(t, {
    breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: t(msgid('Server administration')) }, { label: t(title) }],
    title: t(title), route, description: t(description),
  })
}

export function lifecycleCard(t: Translate, key: string, title: string, bodyHtml: string, hooks?: HookAttributes): string {
  return card({ title: t(title), titleId: `v2-lifecycle-${key}`, bodyHtml, ...(hooks ? { hooks } : {}) })
}

export function lifecycleButton(t: Translate, label: string, hooks: HookAttributes, primary = false): string {
  return `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)} disabled>${text(t, label)}</button>`
}

export function lifecycleStatus(t: Translate, label: string, hooks: HookAttributes, hidden = false): string {
  return `<p class="v2-lifecycle__status" role="status"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${text(t, label)}</p>`
}

export function lifecycleField(t: Translate, id: string, label: string, controlHtml: string, help?: string): string {
  const helpId = `${id}-help`
  const control = help ? controlHtml.replace(/^<(input|select|textarea)\b/, `<$1 aria-describedby="${escapeHtml(helpId)}"`) : controlHtml
  return `<div class="v2-lifecycle__field"><label for="${escapeHtml(id)}">${text(t, label)}</label>${control}${help ? `<p class="v2-muted" id="${escapeHtml(helpId)}">${text(t, help)}</p>` : ''}</div>`
}

export function lifecycleTable(t: Translate, title: string, columns: readonly string[], hooks: HookAttributes, empty: string): string {
  return `<div class="v2-lifecycle__scroll" role="region" tabindex="0" aria-label="${text(t, title)}"><table class="v2-lifecycle__table"><caption class="v2-sr">${text(t, title)}</caption><thead><tr>${columns.map(column => `<th scope="col">${text(t, column)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}><tr><td colspan="${columns.length}">${text(t, empty)}</td></tr></tbody></table></div>`
}

export function lifecycleFacts(t: Translate, facts: readonly { key: string; label: string; value?: string }[], hook: `data-${string}`): string {
  return `<dl class="v2-lifecycle__fields">${facts.map(fact => `<div class="v2-lifecycle__field"><dt>${text(t, fact.label)}</dt><dd><bdi dir="ltr"${hookAttrs({ [hook]: fact.key })}>${fact.value === undefined ? text(t, msgid('Not read')) : escapeHtml(fact.value)}</bdi></dd></div>`).join('')}</dl>`
}

/** Scoped to lifecycle bodies: compact table cells do not inherit panel padding. */
export const LIFECYCLE_PAGES_CSS = `.v2-lifecycle{display:flex;flex-direction:column;gap:32px;min-inline-size:0;text-align:start}
.v2-lifecycle .v2-card__body{gap:24px}
.v2-lifecycle :is(p,dl,dd,h2,h3,ol,ul){margin:0}
.v2-lifecycle__grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:24px;align-items:start}
.v2-lifecycle__column,.v2-lifecycle__group{display:flex;flex-direction:column;gap:24px;min-inline-size:0}
.v2-lifecycle__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;min-inline-size:0}
.v2-lifecycle__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}
.v2-lifecycle__field>label{padding-inline:13px}
.v2-lifecycle__field :is(input,select,textarea){inline-size:100%;min-inline-size:0;box-sizing:border-box}
.v2-lifecycle__field :is(input,select){min-block-size:44px}
.v2-lifecycle__field :is(dd,bdi){overflow-wrap:anywhere}
.v2-lifecycle [dir=ltr]{text-align:var(--v2-control-align,start);unicode-bidi:isolate}
.v2-lifecycle__actions,.v2-lifecycle__choices{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.v2-lifecycle__choice{display:flex;align-items:start;gap:8px;min-block-size:44px;overflow-wrap:anywhere}
.v2-lifecycle__choice>span{display:flex;flex-direction:column;gap:8px}
.v2-lifecycle__choice>input{flex:none;inline-size:20px;block-size:20px;margin:0}
.v2-lifecycle [data-approved-whm-backups] [role=radiogroup]{display:flex;flex-direction:column;gap:16px;min-inline-size:0}
.v2-lifecycle [data-approved-whm-backups] .v2-lifecycle__choice[role=radio]{inline-size:100%;align-items:center;min-block-size:52px;padding:8px 16px;border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface);color:var(--text);font:inherit;text-align:start;cursor:pointer}
.v2-lifecycle [data-approved-whm-backups] .v2-lifecycle__choice[role=radio]>span:last-child{flex:1;min-inline-size:0;text-align:start}
.v2-lifecycle [data-approved-whm-backups] .v2-lifecycle__radio-ring{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:18px;block-size:18px;border:2px solid var(--line-strong);border-radius:50%}
.v2-lifecycle [data-approved-whm-backups] [role=radio][aria-checked=true]{border-color:var(--accent-fill);background:var(--accent-soft)}
.v2-lifecycle [data-approved-whm-backups] [role=radio][aria-checked=true] .v2-lifecycle__radio-ring{border-color:var(--accent-fill)}
.v2-lifecycle [data-approved-whm-backups] [role=radio][aria-checked=true] .v2-lifecycle__radio-ring::after{content:"";inline-size:8px;block-size:8px;border-radius:50%;background:var(--accent-fill)}
.v2-lifecycle [data-approved-whm-backups] [role=radio]:disabled{color:var(--muted);background:var(--sunken);cursor:not-allowed}
.v2-lifecycle__scroll{max-inline-size:100%;overflow:auto}
.v2-lifecycle__table{inline-size:100%;border-collapse:collapse;text-align:start}
.v2-lifecycle__table :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere;border-block-end:1px solid var(--line)}
.v2-lifecycle__table th{color:var(--muted);font-size:12px;font-weight:500}
.v2-lifecycle__table td{font-size:13px}
.v2-lifecycle__table bdi{overflow-wrap:anywhere}
.v2-lifecycle__status{color:var(--muted);overflow-wrap:anywhere}
.v2-lifecycle__status[role=alert]{color:var(--bad)}
.v2-lifecycle__key{padding:16px;border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font:12px/1.7 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.v2-lifecycle__steps{display:flex;flex-wrap:wrap;list-style:none;padding:0;gap:16px}
.v2-lifecycle__steps>li{display:flex;flex:1 1 180px;align-items:center;gap:8px;color:var(--muted)}
.v2-lifecycle__steps>li>span:first-child{display:flex;align-items:center;justify-content:center;inline-size:28px;block-size:28px;flex:none;border:1px solid var(--line-strong);border-radius:50%;font-variant-numeric:tabular-nums}
.v2-lifecycle__steps>li[aria-current=step]{color:var(--text);font-weight:600}
.v2-lifecycle__steps>li[aria-current=step]>span:first-child{border-color:var(--accent-fill);background:var(--accent-fill);color:var(--on-accent)}
.v2-lifecycle details{display:flex;flex-direction:column;gap:16px;min-inline-size:0}
.v2-lifecycle details>summary{cursor:pointer;min-block-size:44px;align-content:center;font-weight:600}
.v2-lifecycle fieldset{border:0;padding:0;margin:0;min-inline-size:0}
.v2-lifecycle fieldset>legend{margin-block-end:16px;font-weight:600}
.v2-lifecycle [hidden]{display:none!important}
.v2-lifecycle__tabs{display:flex;flex-wrap:wrap;gap:16px;border-block-end:1px solid var(--line)}
.v2-lifecycle__tabs>a{display:inline-flex;align-items:center;min-block-size:44px;padding-inline:8px;color:var(--muted);text-decoration:none;border-block-end:2px solid transparent}
.v2-lifecycle__tabs>a[aria-current=page]{color:var(--text);border-color:var(--accent-fill);font-weight:600}
.v2-lifecycle__summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.v2-lifecycle__summary>div{padding:24px;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface)}
.v2-lifecycle__summary dt{color:var(--muted);font-size:13px}
.v2-lifecycle__summary dd{font-size:20px;font-weight:600}
@media(max-width:1000px){.v2-lifecycle__grid{grid-template-columns:minmax(0,1fr)}.v2-lifecycle__summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-lifecycle__fields,.v2-lifecycle__summary{grid-template-columns:minmax(0,1fr)}.v2-lifecycle__summary>div{padding:16px}}
`
