import { DNSSEC_ALGORITHM_CHOICES, DNSSEC_KEY_TYPE_CHOICES, DNSSEC_LAYOUT_CHOICES, DNSSEC_NSEC_CHOICES } from '../../../../../models/dnssec.ts'
import { card } from '../../../components/index.ts'
import { escapeHtml } from '../../../html.ts'
import { phoneLabels, serviceButton, serviceFacts, serviceField } from './common.ts'

type Translate = (message: string) => string

/** v2 markup for the rows the DNSSEC controller fills. */
export function v2DnssecClientTemplates(): string {
  return `<template data-xp-template="dnssec-key"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="id"></bdi></td><td data-xp-slot="type"></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="algorithm"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="tag"></bdi></td><td data-xp-slot="state"></td><td><div class="v2-panel-service__actions" data-xp-slot="actions"></div></td></tr></template>`
    + `<template data-xp-template="dnssec-action"><button type="button" class="v2-btn" disabled></button></template>`
    + `<template data-xp-template="dnssec-rollover"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="keys"></bdi></td><td data-xp-slot="type"></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="not-before"></bdi></td><td><button type="button" class="v2-btn" data-xp-slot="action" disabled></button></td></tr></template>`
    + `<template data-xp-template="dnssec-empty"><tr><td colspan="6" data-xp-slot="message"></td></tr></template>`
}

/** Zone editor DNSSEC card; only a verified, authorized tool connects the controller. */
export function renderV2DnssecCard(t: Translate, input: { zones: readonly string[]; selected?: string; connected: boolean }): string {
  const off = !input.connected
  const options = (items: readonly (readonly [string, string])[]) => items.map(([key, label]) => `<option value="${key}">${escapeHtml(t(label))}</option>`).join('')
  const select = (id: string, label: string, hook: string, html: string) => serviceField(id, t(label), `<select id="${id}" ${hook}${off ? ' disabled' : ''}>${html}</select>`)
  const zones = input.zones.map(zone => `<option value="${escapeHtml(zone)}"${zone === input.selected ? ' selected' : ''}>${escapeHtml(zone)}</option>`).join('') || `<option value="">${escapeHtml(t('No account domain is available'))}</option>`
  const table = (label: string, heads: readonly string[], hook: string) => `<div class="v2-panel-service__table" tabindex="0" role="region" aria-label="${escapeHtml(t(label))}"><table class="v2-table"${phoneLabels(heads.map(head => t(head)))}><thead><tr>${heads.map(head => `<th scope="col">${escapeHtml(t(head))}</th>`).join('')}</tr></thead><tbody ${hook}></tbody></table></div>`
  const notRead = escapeHtml(t('Not read'))
  return card({
    title: t('DNSSEC'), titleId: 'v2-dnssec-heading',
    description: t('PowerDNS signs the zone with keys kept in its own key store. Give the DS record to your registrar only after the zone shows as signed.'),
    hooks: input.connected ? { 'data-dnssec': true } : { 'data-capability-unavailable': 'true' },
    actionsHtml: serviceButton(t('Refresh'), { 'data-dnssec-refresh': true }, off),
    bodyHtml: `<div class="v2-panel-service__fields">${select('v2-dnssec-zone', 'Zone', 'data-dnssec-zone dir="ltr"', zones)}</div>`
      + serviceFacts([
        { label: t('Signing'), valueHtml: `<span data-dnssec-signing>${notRead}</span>` }, { label: t('Key publication'), valueHtml: `<span data-dnssec-publication>${notRead}</span>` },
        { label: t('Denial of existence'), valueHtml: `<span data-dnssec-nsec>${notRead}</span>` }, { label: t('Observed at (UTC)'), valueHtml: `<span data-dnssec-observed>${notRead}</span>` },
      ])
      + `<p data-dnssec-status role="status">${escapeHtml(t(input.connected ? 'Reading DNSSEC keys…' : 'DNSSEC is unavailable here. No keys were read or changed.'))}</p>`
      + table('DNSSEC keys', ['ID', 'Type', 'Algorithm', 'Key tag', 'State', 'Actions'], 'data-dnssec-keys')
      + `<h3>${escapeHtml(t('DS records for the registrar'))}</h3><pre class="v2-mono v2-panel-service__scroll" dir="auto" tabindex="0" data-dnssec-ds>${escapeHtml(t('No DS record is published yet.'))}</pre>`
      + `<div class="v2-panel-service__fields">${select('v2-dnssec-algorithm', 'Algorithm', 'data-dnssec-algorithm', options(DNSSEC_ALGORITHM_CHOICES))}${select('v2-dnssec-layout', 'Key layout', 'data-dnssec-layout', options(DNSSEC_LAYOUT_CHOICES))}${select('v2-dnssec-add-type', 'New key type', 'data-dnssec-add-type', options(DNSSEC_KEY_TYPE_CHOICES))}${select('v2-dnssec-nsec-mode', 'Denial of existence', 'data-dnssec-nsec-mode', options(DNSSEC_NSEC_CHOICES))}</div>`
      + `<div class="v2-panel-service__actions">${serviceButton(t('Enable DNSSEC'), { 'data-dnssec-enable': true }, off, true)}${serviceButton(t('Add inactive key'), { 'data-dnssec-add-key': true }, off)}${serviceButton(t('Save denial of existence'), { 'data-dnssec-nsec-save': true }, off)}</div>`
      + `<h3>${escapeHtml(t('Key rollovers'))}</h3>` + table('Key rollovers', ['Keys', 'Type', 'Not before (UTC)', 'Action'], 'data-dnssec-rollovers')
      + `<label class="v2-check" for="v2-dnssec-ds-updated"><input id="v2-dnssec-ds-updated" type="checkbox" data-dnssec-ds-updated${off ? ' disabled' : ''}> ${escapeHtml(t('The registrar publishes the DS record of the new key'))}</label>`
      + `<div class="v2-panel-service__fields">${serviceField('v2-dnssec-disable-confirm', t('Type the zone name to turn DNSSEC off'), `<input id="v2-dnssec-disable-confirm" type="text" dir="ltr" autocomplete="off" data-dnssec-disable-confirm${off ? ' disabled' : ''}>`, t('Remove the DS record at the registrar and wait at least a day before turning DNSSEC off, or resolvers will reject the zone.'))}</div>`
      + `<div class="v2-panel-service__actions">${serviceButton(t('Turn DNSSEC off'), { 'data-dnssec-disable': true }, off)}</div>` + v2DnssecClientTemplates(),
  })
}
