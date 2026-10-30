import type { Translate } from '../../../../../i18n.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { card, notice, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'

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

export function domainHeader(t: Translate, route: string, title: string, description: string): string {
  return pageHeader(t, { breadcrumb: [{ label: 'xPanel', href: '/home' }, { label: t(msgid('Domains')), href: '/domains' }, { label: title }], route, title, description })
}

export function missingDomainAccount(t: Translate, route: string, title: string): string {
  return `<section class="v2-domain-page">${domainHeader(t, route, title, t(msgid('Manage your hosting account and domains.')))}${notice(t, { tone: 'warn', lead: t(msgid('Unavailable')), text: t(msgctxt('theme:v2', 'No account is available.')), urgent: true })}</section>`
}

export const technical = (value: string | number): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`
export const domainButton = (label: string, hooks?: HookAttributes, disabled = true, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`

export function domainField(id: string, label: string, control: string, help?: string): string {
  return `<div class="v2-domain-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control}${help ? `<p class="v2-muted">${escapeHtml(help)}</p>` : ''}</div>`
}

export function domainFacts(items: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[]): string {
  return `<dl class="v2-domain-facts">${items.map(item => `<div><dt>${escapeHtml(item.label)}</dt><dd${hookAttrs(item.hooks)}>${item.valueHtml}</dd></div>`).join('')}</dl>`
}

export function domainTable(label: string, headers: readonly string[], rowsHtml: string, hooks: HookAttributes, tableHooks?: HookAttributes): string {
  return `<div class="v2-domain-scroll" role="region" tabindex="0" aria-label="${escapeHtml(label)}"><table${hookAttrs(tableHooks)}><caption class="v2-sr">${escapeHtml(label)}</caption><thead><tr>${headers.map(header => `<th scope="col">${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}>${rowsHtml}</tbody></table></div>`
}

export function domainCard(id: string, title: string, bodyHtml: string, actionsHtml?: string): string {
  return card({ title, titleId: `v2-${id}-heading`, bodyHtml, ...(actionsHtml ? { actionsHtml } : {}) })
}

export const DOMAIN_PAGES_CSS = `.v2-domain-page{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-domain-stack{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-domain-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,360px);gap:var(--space-3);align-items:start}
.v2-domain-fields,.v2-domain-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-domain-field,.v2-domain-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-domain-field>label,.v2-domain-facts dt{font-size:13px;font-weight:600}
.v2-domain-field :is(input,select,textarea):not([type=checkbox],[type=radio]){inline-size:100%;min-inline-size:0;min-block-size:var(--target);text-align:match-parent}
.v2-domain-facts dd{margin:0;overflow-wrap:anywhere}
.v2-domain-facts bdi{display:inline;unicode-bidi:isolate}
.v2-domain-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-domain-check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-domain-check input{flex:none;inline-size:20px;block-size:20px;margin:0}
.v2-domain-scroll{overflow:auto;min-inline-size:0;max-inline-size:100%}
.v2-domain-scroll table{min-inline-size:720px}
.v2-domain-scroll table[data-domain-table]{min-inline-size:1040px}
.v2-domain-scroll :is(th,td){text-align:start;vertical-align:top;overflow-wrap:anywhere}
.v2-domain-scroll bdi{unicode-bidi:isolate}
.v2-domain-cell{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-inline-size:0}
.v2-domain-cell>span{font-size:12px;color:var(--muted)}
.v2-domain-notes{margin:0;padding-inline-start:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2)}
.v2-domain-review{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--subtle)}
.v2-domain-page .v2-domain-field textarea{min-block-size:120px;resize:vertical}
.v2-domain-page .v2-domain-wide{grid-column:1/-1}
.v2-domain-page [hidden]{display:none!important}
.v2-domain-preview{inline-size:100%;block-size:420px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface)}
.v2-domain-secret{overflow-wrap:anywhere;user-select:all}
@media(max-width:1100px){.v2-domain-split{grid-template-columns:1fr}}
@media(max-width:600px){.v2-domain-fields,.v2-domain-facts{grid-template-columns:1fr}.v2-domain-preview{block-size:360px}}
`
