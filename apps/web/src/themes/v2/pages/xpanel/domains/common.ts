import type { Translate } from '../../../../../i18n.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { card, notice, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'
import { phoneLabelCss, phoneLabels } from '../settings/common.ts'

export interface DomainPageAuthority {
  readonly canRead: boolean
  readonly presentation?: 'live' | 'read-only'
  readonly canReadFacts?: boolean
  readonly authorizedTools?: ReadonlySet<string>
  readonly canManage: boolean
}

export const NO_DOMAIN_AUTHORITY: DomainPageAuthority = { canRead: false, canManage: false }

export function domainContext(props: PanelSurfaceProps, authority: DomainPageAuthority) {
  const locale = props.locale ?? 'en'
  const t = v2Messages.translator(locale)
  const readOnly = authority.presentation === 'read-only'
  const factAccess = readOnly && authority.canReadFacts === true && authority.authorizedTools?.has('domains') === true
  const principal = props.visibility?.principal
  const identityMatches = principal?.kind === 'user' && props.account?.id === principal.accountId
  const account = (authority.canRead || factAccess) && (!readOnly || identityMatches) ? props.account : undefined
  const canManage = !!account && account.status === 'active' && authority.canManage && !readOnly
  const domains = account ? (props.domains ?? []).filter(domain => domain.accountId === account.id) : []
  const selected = domains.find(domain => domain.name === props.activeDomain)
    ?? domains.find(domain => domain.name === account?.primaryDomain) ?? domains[0]
  return { locale, t, account, canManage, domains, selected, domainsObserved: !!account && props.domains !== undefined }
}

export function domainHeader(t: Translate, route: string, title: string, description: string, actionsHtml?: string): string {
  return pageHeader(t, { breadcrumb: [{ label: t(msgid('Home')), href: '/home' }, { label: t(msgid('Domains')), href: '/domains' }, { label: title }], route, title, description, ...(actionsHtml ? { actionsHtml } : {}) })
}

export function missingDomainAccount(t: Translate, route: string, title: string): string {
  return `<section class="v2-domain-page">${domainHeader(t, route, title, t(msgid('Manage your hosting account and domains.')))}${notice(t, { tone: 'warn', lead: t(msgid('Unavailable')), text: t(msgctxt('theme:v2', 'No account is available.')), urgent: true })}</section>`
}

export const technical = (value: string | number): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`
/** Display names for saved domain kinds and site types; unknown values stay technical. */
export const domainKindLabel = (t: Translate, kind: string): string => kind === 'primary' ? t(msgid('Primary')) : kind === 'addon' ? t(msgid('Addon')) : kind === 'subdomain' ? t(msgid('Subdomain')) : kind === 'alias' ? t(msgid('Alias')) : kind
export const siteTypeLabel = (t: Translate, type: string): string => type === 'php' ? t(msgid('PHP files')) : type === 'static' ? t(msgid('Static files')) : type === 'proxy' ? t(msgid('Reverse proxy')) : type === 'node' ? 'Node.js' : type === 'python' ? 'Python' : type
export const domainButton = (label: string, hooks?: HookAttributes, disabled = true, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`

export function domainField(id: string, label: string, control: string, help?: string): string {
  return `<div class="v2-domain-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control}${help ? `<p class="v2-muted">${escapeHtml(help)}</p>` : ''}</div>`
}

export function domainFacts(items: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[]): string {
  return `<dl class="v2-domain-facts">${items.map(item => `<div><dt>${escapeHtml(item.label)}</dt><dd${hookAttrs(item.hooks)}>${item.valueHtml}</dd></div>`).join('')}</dl>`
}

/** Phone rows name their values from the headers; the domain list cells carry their own data-label. */
export function domainTable(label: string, headers: readonly string[], rowsHtml: string, hooks: HookAttributes, tableHooks?: HookAttributes): string {
  return `<div class="v2-domain-scroll" role="region" tabindex="0" aria-label="${escapeHtml(label)}"><table${tableHooks?.['data-domain-table'] ? '' : phoneLabels(headers)}${hookAttrs(tableHooks)}><caption class="v2-sr">${escapeHtml(label)}</caption><thead><tr>${headers.map(header => `<th scope="col">${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}>${rowsHtml}</tbody></table></div>`
}

export function domainCard(id: string, title: string, bodyHtml: string, actionsHtml?: string): string {
  return card({ title, titleId: `v2-${id}-heading`, bodyHtml, ...(actionsHtml ? { actionsHtml } : {}) })
}

export const DOMAIN_PAGES_CSS = `.v2-domain-page{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-domain-stack{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-domain-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,360px);gap:var(--space-3);align-items:start}
.v2-domain-split--drawer{grid-template-columns:minmax(0,1fr) minmax(340px,440px)}
.v2-domain-split--drawer>aside .v2-domain-fields:not(.v2-domain-facts){grid-template-columns:minmax(0,1fr)}
.v2-domain-split--drawer>:not(aside) .v2-domain-fields{grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr))}
.v2-domain-limits{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-domain-limits__head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:var(--space-1)}.v2-domain-limits__head>h2{font-size:16px}.v2-domain-limits__head>span{font-size:13px;color:var(--muted)}
.v2-domain-head-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-domain-scroll table[data-domain-table] th:first-child{inline-size:25%}
@media(min-width:601px){.v2-domain-scroll table[data-domain-table]{table-layout:fixed}.v2-domain-scroll table[data-domain-table] th{white-space:normal}.v2-domain-scroll table[data-domain-table] th:nth-child(2){inline-size:12%}.v2-domain-scroll table[data-domain-table] th:nth-child(3){inline-size:11%}.v2-domain-scroll table[data-domain-table] th:nth-child(4){inline-size:14%}.v2-domain-scroll table[data-domain-table] th:nth-child(5){inline-size:15%}.v2-domain-scroll table[data-domain-table] th:nth-child(6){inline-size:9%}.v2-domain-scroll table[data-domain-table] .v2-domain-check{white-space:normal}.v2-domain-scroll table[data-domain-table] :is(th,td){padding-inline:12px}.v2-domain-scroll table[data-domain-table] td:last-child{min-inline-size:132px}.v2-domain-scroll table[data-domain-table] td:last-child .v2-btn{padding-inline:12px;font-size:13px;white-space:normal;text-align:start}}
.v2-domain-scroll table[data-domain-table] td:last-child>details{margin-block-start:var(--space-1);font-size:13px}.v2-domain-scroll table[data-domain-table] td:last-child>details>summary{display:inline-flex;align-items:center;min-block-size:var(--target);min-inline-size:var(--target);cursor:pointer;color:var(--text-2)}.v2-domain-scroll table[data-domain-table] td:last-child>details[open]>summary{margin-block-end:var(--space-1)}.v2-domain-scroll table[data-domain-table] td:last-child>p{margin-block-start:var(--space-1);font-size:12px;color:var(--muted)}
.v2-domain-split--strip{grid-template-columns:minmax(0,1fr)}.v2-domain-split--strip>aside{order:-1}
.v2-domain-split--strip .v2-domain-notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:var(--space-1) var(--space-4)}
.v2-domain-split--strip>aside .v2-domain-fields{grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))}
.v2-domain-split--strip .v2-domain-facts{grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr))}
.v2-domain-fields,.v2-domain-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-domain-field,.v2-domain-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-domain-field>label,.v2-domain-page .v2-filter__label,.v2-domain-facts dt{text-box-trim:trim-end;text-box-edge:text}
.v2-domain-field>label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}.v2-domain-facts dt{font-size:12px;color:var(--muted)}.v2-domain-facts dd{font-size:13px;text-box-trim:trim-start;text-box-edge:text}
.v2-domain-field>p{font-size:12px;line-height:1.5;color:var(--muted)}
.v2-domain-page .v2-kpi-row{grid-template-columns:repeat(4,minmax(0,1fr))}.v2-domain-page .v2-kpi__value>:first-child{font-size:26px;overflow-wrap:anywhere}.v2-domain-page .v2-kpi__note{overflow-wrap:anywhere}
.v2-domain-page .v2-card p{font-size:13px;line-height:1.6}.v2-domain-page .v2-card__body>p,.v2-domain-page :is(form,.v2-domain-create)>p{color:var(--text-2)}
.v2-domain-page .v2-card h3{font-size:14px}
.v2-domain-meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);color:var(--muted)}
.v2-domain-meta>[data-domain-count]{display:inline-flex;align-items:center;justify-content:center;min-inline-size:28px;padding:2px 10px;border-radius:var(--radius-pill);background:var(--sunken);color:var(--text-2);font-size:12px;font-weight:600}
.v2-domain-meta>[data-domain-status]{font-weight:600;color:var(--text-2)}
.v2-domain-field :is(input,select,textarea):not([type=checkbox],[type=radio]){inline-size:100%;min-inline-size:0;min-block-size:var(--target);text-align:match-parent;text-align:-webkit-match-parent}
.v2-domain-facts dd{margin:0;overflow-wrap:anywhere}
.v2-domain-facts bdi{display:inline;unicode-bidi:isolate}
.v2-domain-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-domain-check{display:flex;align-items:center;gap:var(--space-1);min-inline-size:var(--target);min-block-size:var(--target)}
.v2-domain-check input{flex:none;inline-size:20px;block-size:20px;margin:0}
.v2-domain-scroll{overflow:auto;min-inline-size:0;max-inline-size:100%;border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-domain-scroll table{min-inline-size:0}
.v2-domain-page>[role=status]:not(:empty,[hidden]),.v2-domain-page .v2-card__body>[role=status]:not(:empty,[hidden]){padding:10px 14px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--subtle);font-size:13px;color:var(--text-2)}
.v2-domain-page>[role=status]:not(:empty,[hidden]){background:var(--surface)}.v2-domain-scroll tbody tr:first-child>td{border-block-start-color:var(--line)}
.v2-domain-scroll table[data-domain-table]{min-inline-size:860px}
.v2-domain-scroll td{font-size:13px}.v2-domain-scroll td[colspan]{padding-block:var(--space-3);color:var(--muted);text-align:center}
.v2-domain-scroll :is(th,td){text-align:start;vertical-align:top;overflow-wrap:break-word}.v2-domain-scroll td bdi{overflow-wrap:anywhere}.v2-domain-scroll .v2-domain-check{white-space:nowrap}
.v2-domain-options{display:flex;flex-wrap:wrap;gap:0 var(--space-3)}
.v2-domain-page .v2-card__head{flex-wrap:nowrap}.v2-domain-page .v2-card__title{flex:1 1 auto}.v2-domain-page .v2-card__actions{flex:none}
.v2-domain-scroll bdi{unicode-bidi:isolate}
.v2-domain-cell{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-inline-size:0}
.v2-domain-cell>span{font-size:12px;color:var(--muted)}
.v2-domain-notes{margin:0;padding-inline-start:var(--space-3);display:flex;flex-direction:column;gap:var(--space-1);font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-domain-review{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--subtle)}
.v2-domain-page .v2-domain-field textarea{min-block-size:120px;resize:vertical}
.v2-domain-page .v2-domain-wide{grid-column:1/-1}
.v2-domain-page [hidden]{display:none!important}
.v2-domain-preview{inline-size:100%;block-size:420px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface)}
.v2-domain-secret{overflow-wrap:anywhere;user-select:all}
@media(max-width:1100px){.v2-domain-split{grid-template-columns:1fr}.v2-domain-page .v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:1100px){.v2-domain-split--drawer>aside{order:-1}}
@media(max-width:600px){.v2-domain-scroll table[data-domain-table] td:last-child>details>summary{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);padding-inline:var(--space-1)}.v2-domain-scroll table[data-domain-table] td:last-child>details>summary::before{content:"";border:5px solid transparent;border-block-start-color:currentColor;border-block-end:0}.v2-domain-scroll table[data-domain-table]{display:block;min-inline-size:0}.v2-domain-scroll table[data-domain-table] thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
.v2-domain-scroll table[data-domain-table] tbody{display:block}
.v2-domain-scroll table[data-domain-table] tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);padding-block:var(--space-2);border-block-start:1px solid var(--line)}
.v2-domain-scroll table[data-domain-table] td{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-inline-size:0;padding:0;border:0}
.v2-domain-scroll table[data-domain-table] td:is(:first-child,:last-child,[colspan]){grid-column:1/-1}
.v2-domain-scroll table[data-domain-table] td:last-child{flex-flow:row wrap;align-items:center}.v2-domain-scroll table[data-domain-table] td:last-child>.v2-btn{flex:1 1 auto}
.v2-domain-scroll table[data-domain-table] td[data-label]::before{content:attr(data-label);font-size:12px;color:var(--muted)}
.v2-domain-fields{grid-template-columns:1fr}.v2-domain-preview{block-size:360px}.v2-domain-actions>.v2-btn{flex:1 1 auto;white-space:normal}.v2-domain-page .v2-card__head{flex-wrap:wrap}.v2-domain-scroll{border:0;border-block-start:1px solid var(--line);border-radius:0}}
.v2-domain-page .v2-filter--fields{padding:0}.v2-domain-page [data-list-row][hidden]{display:none}
.v2-domain-filter-empty{margin:0;padding:var(--space-3);text-align:center;font-size:13px;color:var(--muted)}
@media(min-width:601px){.v2-domain-scroll table:has(>[data-staging-rows]){table-layout:fixed;inline-size:100%;min-inline-size:0}.v2-domain-scroll table:has(>[data-staging-rows]) th:nth-child(1){inline-size:34%}.v2-domain-scroll table:has(>[data-staging-rows]) th:nth-child(2){inline-size:15%}.v2-domain-scroll table:has(>[data-staging-rows]) th:nth-child(3){inline-size:8%}.v2-domain-scroll table:has(>[data-staging-rows]) th:nth-child(4){inline-size:13%}.v2-domain-scroll table:has(>[data-staging-rows]) th:nth-child(5){inline-size:13%}.v2-domain-scroll table:has(>[data-staging-rows]) th:nth-child(6){inline-size:17%}}
.v2-domain-page textarea[dir=ltr][spellcheck=false]{text-align:start}
@media(min-width:601px){.v2-domain-scroll table:has(>[data-ddns-rows]){table-layout:fixed;inline-size:100%;min-inline-size:0}.v2-domain-scroll table:has(>[data-ddns-rows]) th:nth-child(1){inline-size:26%}.v2-domain-scroll table:has(>[data-ddns-rows]) th:nth-child(2){inline-size:8%}.v2-domain-scroll table:has(>[data-ddns-rows]) th:nth-child(3){inline-size:20%}.v2-domain-scroll table:has(>[data-ddns-rows]) th:nth-child(4){inline-size:15%}.v2-domain-scroll table:has(>[data-ddns-rows]) th:nth-child(5){inline-size:14%}.v2-domain-scroll table:has(>[data-ddns-rows]) th:nth-child(6){inline-size:17%}}
@media(min-width:601px){.v2-domain-scroll table:has(>:is([data-ddns-rows],[data-staging-rows])) :is(.v2-pill,.v2-btn){white-space:normal;text-align:start}}
@media(min-width:601px){.v2-domain-scroll table:has(>[data-staging-rows]) th{overflow-wrap:anywhere;white-space:normal}.v2-domain-scroll [data-staging-rows] time{overflow-wrap:normal}}
@media(max-width:600px){.v2-domain-scroll [data-staging-rows] tr>td:nth-child(2):not([colspan]){grid-column:1/-1;grid-row:auto;justify-self:start;text-align:start}.v2-domain-scroll [data-staging-rows] td:is(:has(>bdi:empty),:has(>time:empty)){display:none}.v2-domain-scroll [data-staging-rows] time{white-space:nowrap}}
@media(max-width:600px){.v2-domain-page .v2-segmented>button{min-block-size:var(--target)}}
@media(min-width:1101px){.v2-domain-create{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);align-items:start;gap:var(--space-4)}.v2-domain-create .v2-domain-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
.v2-domain-filter-count{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);margin:0;font-size:12px;color:var(--muted)}
${phoneLabelCss('.v2-domain-scroll')}
`
