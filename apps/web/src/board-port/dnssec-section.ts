import { translator } from '../i18n.ts'
import type { Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { DNSSEC_ALGORITHM_CHOICES, DNSSEC_KEY_TYPE_CHOICES, DNSSEC_LAYOUT_CHOICES, DNSSEC_NSEC_CHOICES } from '../models/dnssec.ts'

export interface DnssecSectionInput { locale: Locale; zones: readonly string[]; selected?: string; connected: boolean }
/** Theme markup for the rows the DNSSEC controller fills; `button` is the selected theme's button class. */
export function dnssecClientTemplates(button: string): string {
  const b = escapeHtml(button)
  return `<template data-xp-template="dnssec-key"><tr><td><bdi dir="ltr" data-xp-slot="id"></bdi></td><td data-xp-slot="type"></td><td><bdi dir="ltr" data-xp-slot="algorithm"></bdi></td><td><bdi dir="ltr" data-xp-slot="tag"></bdi></td><td data-xp-slot="state"></td><td><div style="display:flex;flex-wrap:wrap;gap:8px" data-xp-slot="actions"></div></td></tr></template>`
    + `<template data-xp-template="dnssec-action"><button type="button" class="${b}" disabled></button></template>`
    + `<template data-xp-template="dnssec-rollover"><tr><td><bdi dir="ltr" data-xp-slot="keys"></bdi></td><td data-xp-slot="type"></td><td><bdi dir="ltr" data-xp-slot="not-before"></bdi></td><td><button type="button" class="${b}" data-xp-slot="action" disabled></button></td></tr></template>`
    + `<template data-xp-template="dnssec-empty"><tr><td colspan="6" data-xp-slot="message"></td></tr></template>`
}

/** Classic zone editor DNSSEC card; without a verified tool every control stays disabled and nothing is read. */
export function renderClassicDnssecSection(input: DnssecSectionInput): string {
  const t = (message: string): string => escapeHtml(translator(input.locale)(message))
  const off = input.connected ? '' : ' disabled'
  const options = (items: readonly (readonly [string, string])[]) => items.map(([key, label]) => `<option value="${key}">${t(label)}</option>`).join('')
  const select = (id: string, label: string, hook: string, html: string) => `<div class="xp-field"><label for="${id}">${t(label)}</label><select id="${id}" class="xp-select" ${hook}${off}>${html}</select></div>`
  const fact = (label: string, hook: string) => `<div><dt>${t(label)}</dt><dd ${hook}>${t(msgid('Not read'))}</dd></div>`
  const zones = input.zones.map(zone => `<option value="${escapeHtml(zone)}"${zone === input.selected ? ' selected' : ''}>${escapeHtml(zone)}</option>`).join('') || `<option value="">${t(msgid('No account domain is available'))}</option>`
  const th = (labels: readonly string[]) => labels.map(label => `<th scope="col">${t(label)}</th>`).join('')
  return `<section class="xp-panel-detail__card" data-workspace-section="dnssec"${input.connected ? ' data-dnssec' : ' data-capability-unavailable="true"'}><h2>${t(msgid('DNSSEC'))}</h2>`
    + `<p class="xp-help">${t(msgid('PowerDNS signs the zone with keys kept in its own key store. Give the DS record to your registrar only after the zone shows as signed.'))}</p>`
    + `<div class="xp-panel-detail__fields">${select('panel-dnssec-zone', msgid('Zone'), 'data-dnssec-zone', zones)}</div>`
    + `<dl class="xp-panel-detail__facts">${fact(msgid('Signing'), 'data-dnssec-signing')}${fact(msgid('Key publication'), 'data-dnssec-publication')}${fact(msgid('Denial of existence'), 'data-dnssec-nsec')}${fact(msgid('Observed at (UTC)'), 'data-dnssec-observed')}</dl>`
    + `<p class="xp-help" data-dnssec-status role="status">${t(input.connected ? msgid('Reading DNSSEC keys…') : msgid('DNSSEC is unavailable here. No keys were read or changed.'))}</p>`
    + `<div class="xp-table-wrap" tabindex="0" role="region" aria-label="${t(msgid('DNSSEC keys'))}"><table class="xp-table"><thead><tr>${th([msgid('ID'), msgid('Type'), msgid('Algorithm'), msgid('Key tag'), msgid('State'), msgid('Actions')])}</tr></thead><tbody data-dnssec-keys></tbody></table></div>`
    + `<h3>${t(msgid('DS records for the registrar'))}</h3><pre class="xp-mono" dir="ltr" tabindex="0" style="overflow-x:auto;white-space:pre" data-dnssec-ds>${t(msgid('No DS record is published yet.'))}</pre>`
    + `<div class="xp-panel-detail__fields">${select('panel-dnssec-algorithm', msgid('Algorithm'), 'data-dnssec-algorithm', options(DNSSEC_ALGORITHM_CHOICES))}${select('panel-dnssec-layout', msgid('Key layout'), 'data-dnssec-layout', options(DNSSEC_LAYOUT_CHOICES))}${select('panel-dnssec-add-type', msgid('New key type'), 'data-dnssec-add-type', options(DNSSEC_KEY_TYPE_CHOICES))}${select('panel-dnssec-nsec-mode', msgid('Denial of existence'), 'data-dnssec-nsec-mode', options(DNSSEC_NSEC_CHOICES))}</div>`
    + `<div class="xp-panel-detail__actions"><button type="button" class="xp-btn xp-btn--primary" data-dnssec-enable${off}>${t(msgid('Enable DNSSEC'))}</button><button type="button" class="xp-btn" data-dnssec-add-key${off}>${t(msgid('Add inactive key'))}</button><button type="button" class="xp-btn" data-dnssec-nsec-save${off}>${t(msgid('Save denial of existence'))}</button><button type="button" class="xp-btn" data-dnssec-refresh${off}>${t(msgid('Refresh'))}</button></div>`
    + `<h3>${t(msgid('Key rollovers'))}</h3><div class="xp-table-wrap" tabindex="0" role="region" aria-label="${t(msgid('Key rollovers'))}"><table class="xp-table"><thead><tr>${th([msgid('Keys'), msgid('Type'), msgid('Not before (UTC)'), msgid('Action')])}</tr></thead><tbody data-dnssec-rollovers></tbody></table></div>`
    + `<label class="xp-check" for="panel-dnssec-ds-updated"><input id="panel-dnssec-ds-updated" type="checkbox" data-dnssec-ds-updated${off}> ${t(msgid('The registrar publishes the DS record of the new key'))}</label>`
    + `<div class="xp-panel-detail__fields"><div class="xp-field"><label for="panel-dnssec-disable-confirm">${t(msgid('Type the zone name to turn DNSSEC off'))}</label><input id="panel-dnssec-disable-confirm" class="xp-input" dir="ltr" autocomplete="off" data-dnssec-disable-confirm${off}></div></div>`
    + `<p class="xp-help">${t(msgid('Remove the DS record at the registrar and wait at least a day before turning DNSSEC off, or resolvers will reject the zone.'))}</p>`
    + `<div class="xp-panel-detail__actions"><button type="button" class="xp-btn" data-dnssec-disable${off}>${t(msgid('Turn DNSSEC off'))}</button></div>`
    + dnssecClientTemplates('xp-btn') + '</section>'
}
