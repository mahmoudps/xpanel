import { auditActionLabel, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from '../../../../../audit-labels.ts'
import { formatDisplayDateTime } from '../../../../../display-format.ts'
import { actions, button, context, esc, field, fields, help, inputControl, link, page, section, table, technical, type WhmObservationInput } from '../monitoring/common.ts'

export function renderV2WhmAudit(input: WhmObservationInput): string {
  const { t, locale, canRead } = context(input)
  const supplied = canRead && input.auditEntries !== undefined
  const entries = canRead ? input.auditEntries ?? [] : []
  const filter = canRead ? input.auditList : undefined
  const scheme = input.theme ?? 'light', density = input.density ?? 'comfortable'
  const href = (before?: string): string => {
    const values = new URLSearchParams({ lang: locale, theme: scheme, density })
    for (const key of ['actor', 'action', 'target', 'outcome', 'from', 'to'] as const) if (filter?.[key]) values.set(key, filter[key]!)
    if (before) values.set('before', before)
    return `/whm/audit?${values}`
  }
  const filterField = (key: 'actor' | 'action' | 'target' | 'from' | 'to', label: string): string => {
    const date = key === 'from' || key === 'to'
    const value = filter?.[key] ?? ''
    return field(t, `v2-audit-${key}`, label, inputControl(`v2-audit-${key}`, {}, canRead, ` name="${key}" dir="ltr"${date ? ' step="0.001"' : ' autocomplete="off" maxlength="256"'} value="${esc(date ? value.replace(/Z$/, '') : value)}"`, date ? 'datetime-local' : 'text'))
  }
  const outcomes = [['', msgid('All outcomes')], ['ok', msgid('Success')], ['denied', msgid('Denied')], ['failed', msgid('Failed')]] as const
  const outcomeField = field(t, 'v2-audit-outcome', msgid('Outcome'), `<span class="v2-select"><select id="v2-audit-outcome" name="outcome"${canRead ? '' : ' disabled'}>${outcomes.map(([value, label]) => `<option value="${value}"${filter?.outcome === value ? ' selected' : ''}>${esc(t(label))}</option>`).join('')}</select></span>`)
  const tag = canRead ? 'form' : 'div'
  const filters = `<${tag} class="v2-observation__groups"${canRead ? ' method="get" action="/whm/audit"' : ''} data-audit-filters><input type="hidden" name="lang" value="${locale}"><input type="hidden" name="theme" value="${scheme}"><input type="hidden" name="density" value="${density}">${fields(filterField('actor', msgid('Actor')) + filterField('action', msgid('Action')) + filterField('target', msgid('Target')) + outcomeField + filterField('from', msgid('From (UTC)')) + filterField('to', msgid('To (UTC)')))}${actions(link(t, msgctxt('xwhm', 'Clear filters'), `/whm/audit?${new URLSearchParams({ lang: locale, theme: scheme, density })}`, { 'data-audit-clear': true }) + button(t, msgid('Apply filters'), {}, canRead, true, canRead ? 'submit' : 'button'))}</${tag}>`
  const publicRows = entries.map(entry => ({ at: entry.at, actor: auditActorLabel(entry.actor), action: auditActionLabel(entry.action, locale, entry), target: auditTargetLabel(entry.target, locale), outcome: auditOutcomeLabel(entry.action, entry.outcome, locale) }))
  const rowHtml = publicRows.map((row, index) => `<tr data-audit-id="${esc(entries[index]!.id)}"><td><time datetime="${esc(row.at)}">${technical(formatDisplayDateTime(row.at))}</time></td><td>${technical(row.actor)}</td><td>${esc(row.action)}</td><td>${technical(row.target)}</td><td>${esc(row.outcome)}</td></tr>`).join('')
  const columns = [msgid('Time (UTC)'), msgid('Actor'), msgid('Action'), msgid('Target'), msgid('Outcome')]
  const list = `<div class="v2-observation__scroll" role="region" tabindex="0" aria-label="${esc(t(msgid('Audit log')))}"><table><caption class="v2-sr">${esc(t(msgid('Entries')))}</caption><thead><tr>${columns.map(label => `<th scope="col">${esc(t(label))}</th>`).join('')}</tr></thead><tbody>${rowHtml || `<tr><td colspan="5">${esc(t(supplied ? msgid('No audit entries yet') : msgid('Not read')))}</td></tr>`}</tbody></table></div>`
  const csvCell = (value: string): string => `"${(/^[=+@\-\t\r]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`
  const csv = [['UTC', 'Actor', 'Action', 'Target', 'Outcome'], ...publicRows.map(row => [row.at, row.actor, row.action, row.target, row.outcome])].map(row => row.map(csvCell).join(',')).join('\r\n')
  const download = (label: string, type: string, body: string, extension: string) => `<a class="v2-btn" download="xpanel-audit-page.${extension}" href="data:${type};charset=utf-8,${esc(encodeURIComponent(body))}">${esc(t(label))}</a>`
  const exports = supplied ? `<div class="v2-observation__actions" data-audit-export>${download(msgid('Export page CSV'), 'text/csv', '\uFEFF' + csv, 'csv')}${download(msgid('Export page JSON'), 'application/json', JSON.stringify(publicRows, null, 2), 'json')}</div>` : ''
  const pager = filter?.before || (filter?.hasMore && filter.oldestId) ? `<nav class="v2-observation__actions" data-audit-pager="true" aria-label="${esc(t(msgctxt('theme:v2', 'Audit pages')))}">${filter.before ? link(t, msgid('Newest'), href()) : ''}${filter.hasMore && filter.oldestId ? link(t, msgid('Older'), href(filter.oldestId)) : ''}</nav>` : ''
  const details = publicRows.map(row => `<details data-audit-entry-detail><summary>${esc(row.action)} · ${technical(formatDisplayDateTime(row.at))}</summary><dl class="v2-observation__facts"><div><dt>${esc(t(msgid('Actor')))}</dt><dd>${technical(row.actor)}</dd></div><div><dt>${esc(t(msgid('Target')))}</dt><dd>${technical(row.target)}</dd></div><div><dt>${esc(t(msgid('Outcome')))}</dt><dd>${esc(row.outcome)}</dd></div></dl></details>`).join('')
  const generationRows = canRead ? input.generations ?? [] : []
  const generations = `<div class="v2-observation__scroll"><table><caption class="v2-sr">${esc(t(msgid('Config generations')))}</caption><thead><tr>${[msgid('Generation'), msgid('Created (UTC)'), msgid('Summary'), msgid('Files'), msgid('Status')].map(label => `<th scope="col">${esc(t(label))}</th>`).join('')}</tr></thead><tbody>${generationRows.map(row => `<tr><td>${technical(row.generationId)}</td><td>${technical(formatDisplayDateTime(row.at))}</td><td>${esc(row.summary)}</td><td>${technical(row.filesCount)}</td><td>${esc(t(row.status === 'active' ? msgid('Active') : row.status === 'rolled-back' ? msgid('Rolled back') : msgctxt('theme:v2', 'Superseded')))}</td></tr>`).join('') || `<tr><td colspan="5">${esc(t(msgid('Not read')))}</td></tr>`}</tbody></table></div>`
  return page(input, '/whm/audit', msgid('Audit log'), msgctxt('theme:v2', 'Authorized audit entries and configuration generations, with bounded page exports.'), section(t, 'audit-entries', msgid('Entries'), filters + list + exports + pager)
    + section(t, 'audit-record', msgid('Recorded entry'), `<div data-audit-supplement>${details || help(t, msgid('No entries match the current page.'))}</div>`)
    + section(t, 'audit-changes', msgctxt('theme:v2', 'Changes (before / after)'), table(t, msgctxt('theme:v2', 'Changes (before / after)'), [msgid('Field'), msgid('Before'), msgid('After')], { 'data-v2-audit-safe-changes': true }, msgctxt('theme:v2', 'No reviewed before-and-after values were supplied. Raw audit details are not exposed.')))
    + section(t, 'audit-generations', msgid('Config generations'), generations + help(t, msgid('Exports and details contain this authorized page only. Older entries use the keyset page links.'))))
}
