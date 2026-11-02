import type { PanelSurfaceProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { errorState, pageHeader } from '../../../components/index.ts'

/** Core supplies the result of the current route, principal and capability checks. */
export interface PanelServiceAuthority {
  readonly canManage: boolean
  readonly canRead?: boolean
  readonly presentation?: 'live' | 'read-only'
  readonly canReadFacts?: boolean
  readonly authorizedTools?: ReadonlySet<string>
}

export const latinDigits = (value: string): string => value.replace(/[\u0660-\u0669\u06f0-\u06f9]/gu,
  digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660)))

export const technical = (value: string | number): string => `<bdi dir="ltr" class="v2-mono">${escapeHtml(latinDigits(String(value)))}</bdi>`

export const serviceButton = (label: string, hooks?: HookAttributes, disabled = false, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`

export function serviceField(id: string, label: string, control: string, help?: string): string {
  const helpId = `${id}-help`
  const described = help ? control.replace(/^<(input|select|textarea)\b/, `<$1 aria-describedby="${escapeHtml(helpId)}"`) : control
  return `<div class="v2-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${described}${help ? `<p class="v2-field__help" id="${escapeHtml(helpId)}">${escapeHtml(help)}</p>` : ''}</div>`
}

export const serviceFacts = (facts: readonly { label: string; valueHtml: string }[], hooks?: HookAttributes): string =>
  `<dl class="v2-panel-service-facts"${hookAttrs(hooks)}>${facts.map(fact => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${fact.valueHtml}</dd></div>`).join('')}</dl>`

export const serviceHeader = (t: Translate, route: string, title: string, description: string): string => pageHeader(t, {
  route, title, description, breadcrumb: [{ label: t('Home'), href: '/home' }, { label: title }],
})

export function missingServiceAccount(t: Translate, props: PanelSurfaceProps): string | undefined {
  return props.account ? undefined : errorState(t, { lead: t(msgctxt('theme:v2', 'An authorized account has not been read.')) })
}

/** Page-scoped layout; technical isolation does not move values away from their labels. */
export const PANEL_SERVICES_CSS = `.v2-panel-service{display:grid;gap:var(--space-4);min-inline-size:0}
.v2-panel-service__columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);align-items:start;gap:var(--space-3);min-inline-size:0}
.v2-panel-service__main,.v2-panel-service__aside{display:grid;gap:var(--space-3);min-inline-size:0}
.v2-panel-service__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-panel-service__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-service-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:var(--space-2);margin:0}
.v2-panel-service-facts>div{display:grid;gap:var(--space-1);min-inline-size:0}
.v2-panel-service-facts :is(dt,dd){margin:0;text-align:start;overflow-wrap:anywhere}
.v2-panel-service-facts dt{color:var(--muted);font-size:12px}
.v2-panel-service :is(input,select,textarea)[dir=ltr]{text-align:start}
.v2-panel-service :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-panel-service .v2-field{align-items:stretch}
.v2-panel-service .v2-field>label{margin:0;text-align:start}
.v2-panel-service__table{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-panel-service__table :is(th,td){text-align:start;vertical-align:top;padding:12px 16px}
.v2-panel-service__table bdi{unicode-bidi:isolate}
.v2-panel-service__table .v2-panel-service__actions{gap:var(--space-1)}
.v2-panel-service__note{display:grid;gap:var(--space-1);min-inline-size:0}
.v2-panel-service__note p{margin:0;color:var(--muted);line-height:1.6}
.v2-panel-service__technical{display:block;white-space:pre-wrap;overflow-wrap:anywhere;min-inline-size:0;max-inline-size:100%;text-align:start}
.v2-panel-service fieldset{border:0;margin:0;padding:0;display:grid;gap:var(--space-2);min-inline-size:0}
.v2-panel-service legend{padding:0;margin-block-end:var(--space-2);font-weight:600}
.v2-panel-service .v2-check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-panel-service .v2-check>input{flex:none;margin:0}
.v2-panel-service [hidden]{display:none}
@media(max-width:1100px){.v2-panel-service__columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-panel-service__fields{grid-template-columns:minmax(0,1fr)}.v2-panel-service .v2-card{padding:var(--space-2)}.v2-panel-service .v2-card--flush{padding:0}}
`
