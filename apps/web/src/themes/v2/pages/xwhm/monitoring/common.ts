import { localeDirection, type Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'
import { IDENTITY_ROWS_CSS } from '../../identity.ts'
import type { WhmStoredFactAuthority } from '../stored-facts.ts'

/** Core supplies independent read and mutation decisions after catalog and principal admission. */
export interface ObservationAuthority extends WhmStoredFactAuthority { readonly canRead: boolean; readonly canManage: boolean }
export interface WhmObservationInput extends WhmSurfaceProps {
  readonly observationAuthority?: ObservationAuthority
  /** The reviewed unit list and bounds are supplied by the host contract, never inferred from user input. */
  readonly monitoringLogUnits?: readonly string[]
  readonly monitoringLogDefaultLines?: number
  readonly monitoringLogMaxLines?: number
}

export const esc = escapeHtml
export function context(input: WhmObservationInput) {
  const locale = input.locale ?? 'en'
  const canRead = input.observationAuthority?.canRead === true && input.capabilityUnavailable !== true
  return { locale, t: v2Messages.translator(locale), canRead, canManage: canRead && input.observationAuthority?.canManage === true }
}
/** A frame reader may run its saved-value read in a read-only document for root; its writes stay closed. */
export const frameRead = (input: WhmSurfaceProps & { readonly observationAuthority?: unknown }): boolean =>
  (input.observationAuthority as { presentation?: string } | undefined)?.presentation === 'read-only' && (input.visibility?.principal ?? input.principal)?.kind === 'root'
export const technical = (value: string | number): string => `<bdi dir="ltr" class="v2-mono">${esc(value)}</bdi>`
export const actions = (body: string): string => `<div class="v2-observation__actions">${body}</div>`
export const fields = (body: string): string => `<div class="v2-observation__fields">${body}</div>`
export const help = (t: Translate, text: string, hooks?: HookAttributes): string => `<p class="v2-muted"${hookAttrs(hooks)}>${esc(t(text))}</p>`
export const button = (t: Translate, text: string, hooks?: HookAttributes, enabled = false, primary = false, type: 'button' | 'submit' = 'button'): string => `<button type="${type}" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${enabled ? '' : ' disabled'}>${esc(t(text))}</button>`
export const link = (t: Translate, text: string, href: string, hooks?: HookAttributes): string => `<a class="v2-btn" href="${esc(href)}"${hookAttrs(hooks)}>${esc(t(text))}</a>`
export const field = (t: Translate, id: string, label: string, control: string, helpText?: string): string => `<div class="v2-field"><label for="${esc(id)}">${esc(t(label))}</label>${control}${helpText ? help(t, helpText) : ''}</div>`
export const inputControl = (id: string, hooks: HookAttributes, enabled = false, extra = '', type = 'text'): string => `<input id="${esc(id)}" type="${esc(type)}"${hookAttrs(hooks)}${extra}${enabled ? '' : ' disabled'}>`
export const area = (id: string, hooks: HookAttributes, extra = ''): string => `<textarea id="${esc(id)}"${hookAttrs(hooks)}${extra} disabled></textarea>`
export const select = (t: Translate, id: string, hooks: HookAttributes, choices: readonly (readonly [string, string])[], enabled = false): string => `<span class="v2-select"><select id="${esc(id)}"${hookAttrs(hooks)}${enabled ? '' : ' disabled'}>${choices.map(([value, label]) => `<option value="${esc(value)}">${esc(t(label))}</option>`).join('')}</select></span>`
export const check = (t: Translate, label: string, hooks: HookAttributes, enabled = false, ariaLabel?: string): string => `<label class="v2-observation__check"><input type="checkbox"${hookAttrs(hooks)}${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ''}${enabled ? '' : ' disabled'}><span>${esc(t(label))}</span></label>`
export const status = (t: Translate, text: string, hooks: HookAttributes, state = 'unread', hidden = false): string => `<p class="v2-observation__status" role="status" data-state="${esc(state)}"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${esc(t(text))}</p>`
export function facts(t: Translate, items: readonly (readonly [string, string])[], attribute: `data-${string}`, value = t(msgid('Not read'))): string {
  return `<dl class="v2-observation__facts">${items.map(([key, label]) => `<div><dt>${esc(t(label))}</dt><dd><bdi dir="auto"${hookAttrs({ [attribute]: key })}>${esc(value)}</bdi></dd></div>`).join('')}</dl>`
}
export function markerFacts(t: Translate, items: readonly (readonly [string, string])[], prefix: string): string {
  return `<dl class="v2-observation__facts">${items.map(([key, label]) => `<div><dt>${esc(t(label))}</dt><dd><bdi dir="auto"${hookAttrs({ [`data-${prefix}-${key}`]: true })}>${esc(t(msgid('Not read')))}</bdi></dd></div>`).join('')}</dl>`
}
export const section = (t: Translate, id: string, title: string, bodyHtml: string, hooks?: HookAttributes, hidden = false, elementId?: string): string => hidden
  ? `<div${elementId ? ` id="${esc(elementId)}"` : ''}${hookAttrs(hooks)} hidden>${card({ title: t(title), titleId: `v2-observation-${id}`, bodyHtml })}</div>`
  : card({ title: t(title), titleId: `v2-observation-${id}`, bodyHtml, hooks, ...(elementId ? { id: elementId } : {}) })
/** Phone rows name each stacked value: the translated column headers travel to CSS as custom properties on the table. */
export const columnLabels = (t: Translate, columns: readonly string[]): string =>
  ` style="${esc(columns.map((label, index) => `--v2-col-${index + 1}:'${t(label).replace(/[\\']/g, '\\$&')}'`).join(';'))}"`
export function table(t: Translate, title: string, columns: readonly string[], hooks: HookAttributes, empty = msgid('Not read'), numeric: readonly number[] = []): string {
  return `<div class="v2-observation__scroll" role="region" tabindex="0" aria-label="${esc(t(title))}"><table${columnLabels(t, columns)}><caption class="v2-sr">${esc(t(title))}</caption><thead><tr>${columns.map((label, index) => `<th scope="col"${numeric.includes(index) ? ' data-numeric' : ''}>${esc(t(label))}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}><tr><td colspan="${columns.length}">${esc(t(empty))}</td></tr></tbody></table></div>`
}
export function page(input: WhmObservationInput, route: string, title: string, description: string, body: string, hooks?: HookAttributes): string {
  const { t, locale, canRead } = context(input)
  return `<section class="v2-observation" data-whm-detail-route="${esc(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}" lang="${esc(locale)}" dir="${localeDirection(locale)}"${hookAttrs(hooks)}>${pageHeader(t, { route, title: t(title), description: t(description), breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: t(title) }] })}${body}</section>`
}

/** Reading rules shared by the WHM page families: quiet help and status lines, facts with muted labels. Zero specificity, so a family rule wins. */
/** Plain paragraphs a controller fills with a result, a job line or a record keep the body emphasis. */
const RESULT_TEXT = ['xp-slot', 'sc-job', 'sm-job', 'sw-job', 'sw-addons-job', 'whm-updates-job', 'whm-jobs-error', 'whm-jobs-failure', 'whm-jobs-verification', 'whm-jobs-log-status', 'whm-php-binary-status', 'whm-repair-preview-summary', 'whm-repair-removals-text', 'whm-tokens-reveal-text', 'web-stats-summary', 'generations-current', 'branding-asset-state', 'np-count', 'ip-pool-count', 'whm-ssh-opaque', 'whm-domain-application', 'whm-domain-removal-reason', 'status-notice', 'ctr-field'].map(hook => `[data-${hook}]`).join(',')
export const whmPolish = (s: string): string => `${s} :where(.v2-card__body p:not([class],[role],.v2-notice p,${RESULT_TEXT})){font-size:13px;line-height:1.6;color:var(--muted)}
${s} :where(p[role=status]:not([data-state=failed],[data-state=error])){font-size:13px;line-height:1.6;color:var(--muted);overflow-wrap:anywhere}
${s} p[role=status]:empty{display:none}
${s} :where(p:is([role=status],[role=alert]):is([data-state=problem],[data-state=bad],[data-state=invalid])){color:var(--bad)}
${s} :where(p[role=status]:is([data-state=ok],[data-state=saved],[data-state=success],[data-state=verified])){color:var(--ok)}
${s} :where(.v2-card__body,.v2-card,.v2-observation__groups,.v2-host__groups,.v2-admin-form,.v2-lifecycle__column,.v2-services__panel)>:where(.v2-field,.v2-admin-field,.v2-host__field,.v2-lifecycle__field):not(:has(textarea)){max-inline-size:480px}
${s} :where(dt){font-size:13px;font-weight:400;color:var(--muted)}
${s} :where(dd){font-variant-numeric:tabular-nums}
${s} :where(.v2-card__body :is(h3,legend)){font-size:14px;font-weight:600;color:var(--text)}
`

/** Shared only by these diagnostic, security and activity bodies; no global component overrides. */
export const WHM_OBSERVATION_CSS = `${IDENTITY_ROWS_CSS}
.v2-observation [data-whm-ssh-remove]{color:var(--bad)}
.v2-observation{display:flex;flex-direction:column;gap:32px;min-inline-size:0}
.v2-observation :is(h2,h3,p,dl,dd,pre,fieldset,ul,ol){margin:0}
.v2-observation :is(.v2-card,.v2-card__body){gap:24px}
.v2-observation__groups{display:flex;flex-direction:column;gap:24px;min-inline-size:0}
.v2-observation__columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start;min-inline-size:0}
.v2-observation__columns--wide-end{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}
.v2-observation__jump{display:flex;flex-wrap:wrap;gap:8px}
.v2-observation__jump>a{display:inline-flex;align-items:center;justify-content:center;min-block-size:var(--target);min-inline-size:var(--target);padding-inline:12px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text-2);font-size:13px;font-weight:500;text-decoration:none}
.v2-observation__jump>a:hover{border-color:var(--line-strong);color:var(--text)}
.v2-observation h2[id]{scroll-margin-block-start:96px}
.v2-observation__fields,.v2-observation__facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:16px;min-inline-size:0}
.v2-observation__fields>.v2-field:has(textarea){grid-column:1/-1}
.v2-observation__columns :is(.v2-observation__fields,.v2-observation__facts){grid-template-columns:repeat(auto-fill,minmax(min(100%,180px),1fr));align-items:end}
.v2-observation__columns .v2-observation__facts{align-items:start}
.v2-observation:is([data-whm-detail-route="/whm/security"],[data-whm-detail-route="/whm/security/ssh"])>.v2-kpi-row{grid-template-columns:repeat(4,minmax(0,1fr))}
.v2-observation__facts>div,.v2-observation .v2-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}
.v2-observation__facts dt{font-size:13px;color:var(--muted)}
.v2-observation__facts dd{overflow-wrap:anywhere;text-align:start}
.v2-observation__facts>div:only-child{grid-column:1/-1}
.v2-observation [data-panel-access] .v2-observation__facts{grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))}
.v2-observation__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}
.v2-observation__check{display:flex;align-items:flex-start;gap:8px;min-block-size:var(--target)}
.v2-observation__check>input{flex:none;margin:0}
.v2-observation__check+.v2-observation__check{margin-block-start:-16px}
.v2-observation__fields>.v2-observation__check{margin-block-start:0}
.v2-observation [data-panel-access]{display:flex;flex-direction:column;gap:32px;min-inline-size:0}
.v2-observation .v2-field :is(input,select,textarea){inline-size:100%;min-inline-size:0}
.v2-observation .v2-field [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-observation__scroll{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-observation :is(th,td){text-align:start;vertical-align:top;padding:12px 16px;overflow-wrap:anywhere}
.v2-observation tr:has(button)>:is(th,td){vertical-align:middle}
@media(min-width:601px){.v2-observation [data-whm-ssh-key-rows] td:nth-child(2){white-space:nowrap}.v2-observation [data-whm-ssh-key-rows] td:nth-child(3){overflow-wrap:break-word}}
.v2-panel-access__code{white-space:pre-wrap;overflow-wrap:anywhere}
.v2-observation__log{max-block-size:480px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font:13px/1.6 var(--font-mono)}
.v2-observation__list{display:flex;flex-direction:column;gap:16px;list-style:none;padding:0;min-inline-size:0}
.v2-observation__charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}
.v2-observation [data-whm-alerts-form] .v2-observation__check{white-space:nowrap}
@media(min-width:1101px){.v2-observation__charts:has(>:nth-child(5):last-child){grid-template-columns:repeat(6,minmax(0,1fr))}
.v2-observation__charts:has(>:nth-child(5):last-child)>*{grid-column:span 2}
.v2-observation__charts:has(>:nth-child(5):last-child)>:nth-child(n+4){grid-column:span 3}}
.v2-observation__job-progress{display:flex;gap:8px;align-items:center;min-inline-size:128px}
.v2-observation__job-progress>.v2-bar{flex:1 1 auto;min-inline-size:64px}
.v2-observation__chart{display:flex;flex-direction:column;gap:8px;min-inline-size:0;padding:16px;border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-observation details>summary{min-block-size:var(--target);align-content:center;cursor:pointer;font-weight:600}
.v2-observation details[open]>:not(summary){margin-block-start:16px}
.v2-observation fieldset{padding:16px;border:1px solid var(--line);border-radius:var(--radius-control);min-inline-size:0}
.v2-observation fieldset>legend{padding-inline:8px;font-weight:600}
.v2-observation[data-whm-detail-route="/whm/security"]:has(tr[data-check-state])>.v2-kpi-row .v2-kpi__note{display:none}
.v2-observation__filter{display:inline-flex;flex-wrap:wrap;align-self:flex-start;gap:4px;padding:4px;border-radius:var(--radius-control);background:var(--sunken)}
.v2-observation__filter>label{position:relative;display:inline-flex;align-items:center;justify-content:center;min-block-size:var(--target);min-inline-size:var(--target);padding-inline:12px;border-radius:var(--radius-chip);color:var(--muted);font-size:13px;font-weight:600;cursor:pointer}
.v2-observation__filter input{position:absolute;inset:0;inline-size:100%;block-size:100%;margin:0;opacity:0;cursor:pointer}
.v2-observation__filter>label:has(:checked){background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
.v2-observation__filter>label:has(:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.v2-observation [data-whm-security-evidence]:not(:has(tr[data-check-state])) .v2-observation__filter,.v2-observation__filter-empty{display:none}
.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=observed-ok]:checked) tr[data-check-state]:not([data-check-state=observed-ok]){visibility:collapse}
.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=observed-ok]:checked):has(tr[data-check-state]):not(:has(tr[data-check-state=observed-ok])) .v2-observation__filter-empty{display:block;font-size:13px;color:var(--muted)}
.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=attention]:checked) tr[data-check-state]:not([data-check-state=attention]){visibility:collapse}
.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=attention]:checked):has(tr[data-check-state]):not(:has(tr[data-check-state=attention])) .v2-observation__filter-empty{display:block;font-size:13px;color:var(--muted)}
.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=unavailable]:checked) tr[data-check-state]:not([data-check-state=unavailable]){visibility:collapse}
.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=unavailable]:checked):has(tr[data-check-state]):not(:has(tr[data-check-state=unavailable])) .v2-observation__filter-empty{display:block;font-size:13px;color:var(--muted)}
.v2-observation tr[data-check-state=attention]>td:nth-child(2){color:var(--warn);font-weight:600}
.v2-observation tr[data-check-state=observed-ok]>td:nth-child(2){color:var(--ok);font-weight:600}
.v2-observation tr[data-check-state=unavailable]>td:nth-child(2){color:var(--muted)}
.v2-observation :is([data-host-info],[data-host-info-unread]){display:flex;flex-direction:column;gap:16px}
.v2-observation__savebar{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;padding:16px 24px;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-observation__savebar>p{flex:1 1 240px}
.v2-observation [hidden]{display:none}
.v2-observation__chart>svg{display:block;inline-size:100%;block-size:96px;color:var(--accent)}
@media(min-width:641px){.v2-observation [data-whm-alerts-form] tbody>tr>:is(th,td){vertical-align:middle}}
@media(min-width:1101px){.v2-observation__facts:not(.v2-observation__columns .v2-observation__facts):is(:has(>:nth-child(4):last-child),:has(>:nth-child(7):last-child),:has(>:nth-child(8):last-child)){grid-template-columns:repeat(4,minmax(0,1fr))}.v2-observation__facts:not(.v2-observation__columns .v2-observation__facts,[data-panel-access] .v2-observation__facts):is(:has(>:nth-child(5):last-child),:has(>:nth-child(10):last-child)){grid-template-columns:repeat(5,minmax(0,1fr))}}
@media(min-width:601px){.v2-observation table:has(>thead>tr>:nth-child(9)) :is(th,td){padding-inline:10px}.v2-observation table:has(>thead>tr>:nth-child(9)) td{overflow-wrap:break-word}
.v2-observation[data-whm-detail-route="/whm/monitoring/processes"] table:has(>[data-whm-monitoring-rows]) td:not(:nth-child(3),:nth-child(9)){white-space:nowrap}.v2-observation[data-whm-detail-route="/whm/monitoring/processes"] table:has(>[data-whm-monitoring-rows]) td:nth-child(9){overflow-wrap:anywhere}}
${whmPolish('.v2-observation')}@media(max-width:1100px){.v2-observation__columns{grid-template-columns:minmax(0,1fr)}.v2-observation:is([data-whm-detail-route="/whm/security"],[data-whm-detail-route="/whm/security/ssh"])>.v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(n+3):not([colspan]){grid-column:1/-1;display:flex;justify-content:space-between;gap:16px;text-align:end}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(n+3):not([colspan])::before{flex:none;font-size:13px;color:var(--muted);text-align:start}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(3):not([colspan])::before{content:var(--v2-col-3)}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(4):not([colspan])::before{content:var(--v2-col-4)}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(5):not([colspan])::before{content:var(--v2-col-5)}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(6):not([colspan])::before{content:var(--v2-col-6)}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(7):not([colspan])::before{content:var(--v2-col-7)}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(8):not([colspan])::before{content:var(--v2-col-8)}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(9):not([colspan])::before{content:var(--v2-col-9)}
.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"],[data-whm-detail-route="/whm/audit"]) .v2-observation__scroll td:nth-child(10):not([colspan])::before{content:var(--v2-col-10)}}
@media(max-width:600px){.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=observed-ok]:checked) tr[data-check-state]:not([data-check-state=observed-ok]),.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=attention]:checked) tr[data-check-state]:not([data-check-state=attention]),.v2-observation [data-whm-security-evidence]:has(.v2-observation__filter [value=unavailable]:checked) tr[data-check-state]:not([data-check-state=unavailable]){display:block;block-size:0;padding:0;border:0;overflow:hidden;visibility:hidden}}
@media(max-width:640px){.v2-observation__filter>label{min-block-size:var(--target)}.v2-observation:is([data-whm-detail-route^="/whm/security"],[data-whm-detail-route^="/whm/monitoring"]) .v2-observation__facts{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-observation__fields,.v2-observation__facts{grid-template-columns:minmax(0,1fr)}.v2-observation__jump>a{min-block-size:var(--target)}
.v2-observation:is([data-whm-detail-route="/whm/security"],[data-whm-detail-route="/whm/security/ssh"])>.v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-observation [data-panel-access] .v2-observation__facts{grid-template-columns:minmax(0,1fr)}
.v2-observation [data-whm-alerts-form] :is(table,tbody){display:block}
.v2-observation [data-whm-alerts-form] thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
.v2-observation [data-whm-alerts-form] tbody>tr{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;align-items:center;padding-block:16px;border-block-end:1px solid var(--line)}
.v2-observation [data-whm-alerts-form] tbody>tr>:is(th,td){padding:0;border:0}
.v2-observation [data-whm-alerts-form] tbody>tr>:is(th,td:last-child){grid-column:1/-1}
.v2-observation [data-whm-alerts-form] td>.v2-observation__actions{flex-wrap:nowrap;gap:8px}
.v2-observation [data-whm-alerts-form] td>.v2-observation__actions>input{flex:1 1 0;min-inline-size:0;max-inline-size:120px}
.v2-observation [data-whm-alerts-form] tbody>tr>td:last-child{font-size:13px;color:var(--muted)}}
`
