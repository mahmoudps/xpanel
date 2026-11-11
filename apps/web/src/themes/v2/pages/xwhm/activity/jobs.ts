import { formatDisplayDateTime } from '../../../../../display-format.ts'
import { statusPill } from '../../../components/index.ts'
import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import { icon } from '../../../icons.ts'
import { actions, button, columnLabels, context, esc, facts, field, fields, help, inputControl, page, section, select, status, table, technical, type WhmObservationInput } from '../monitoring/common.ts'

export function renderV2WhmJobs(input: WhmObservationInput): string {
  const { t, canRead, canManage } = context(input)
  const tag = canRead ? 'form' : 'div'
  const filters = `<${tag} class="v2-observation__groups" data-whm-jobs-filters aria-label="${esc(t(msgid('Filter jobs')))}" novalidate>${fields(field(t, 'v2-jobs-status', msgid('Status'), select(t, 'v2-jobs-status', { 'data-whm-jobs-status-filter': true }, [['', msgid('Any status')], ['queued', msgctxt('whm-jobs-workspace', 'Queued')], ['running', msgid('Running')], ['succeeded', msgid('Succeeded')], ['failed', msgctxt('whm-jobs-workspace', 'Failed')], ['cancelled', msgctxt('whm-jobs-workspace', 'Cancelled')]], canRead))
    + field(t, 'v2-jobs-kind', msgid('Kind starts with'), inputControl('v2-jobs-kind', { 'data-whm-jobs-kind-filter': true }, canRead, ' name="kindPrefix" dir="ltr" maxlength="128" autocomplete="off" spellcheck="false" placeholder="system.packages"') + `<p class="v2-muted">${esc(t(msgid('Lowercase letters, digits and . _ : - only, for example {example}.'), { example: '\u2066system.packages\u2069' }))}</p>`))}${actions(button(t, msgid('Apply filters'), { 'data-whm-jobs-apply': true }, canRead, true, canRead ? 'submit' : 'button') + button(t, msgid('Clear'), { 'data-whm-jobs-clear': true }, canRead) + button(t, msgid('Refresh'), { 'data-whm-jobs-refresh': true }, canRead))}</${tag}>`
  const duration = (ms: number): string => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
  const generationsSupplied = canRead && input.generations !== undefined
  const generationRows = canRead ? input.generations ?? [] : []
  const timelineColumns = [msgid('Generation'), msgid('Built'), msgid('Tested'), msgid('Activated'), msgid('Duration'), msgid('Status')]
  const renderStepCell = (row: typeof generationRows[number], stepName: 'built' | 'tested' | 'activated'): string => {
    const step = row.steps?.find(item => item.step === stepName)
    const fallbackAt = stepName === 'built' ? row.at : stepName === 'tested' ? row.testedAt ?? null : row.activatedAt ?? null
    const at = step?.at ?? fallbackAt
    const st = step?.status ?? (at ? 'done' : row.status === 'failed' ? 'failed' : 'pending')
    const label = st === 'done' ? t(msgid('Succeeded')) : st === 'failed' ? t(msgctxt('whm-jobs-workspace', 'Failed')) : st === 'skipped' ? t(msgid('Did not run')) : t(msgid('Pending'))
    const dur = typeof step?.durationMs === 'number' ? ` (${duration(step.durationMs)})` : ''
    return at
      ? `<span data-generation-step="${stepName}" data-step-status="${esc(st)}">${esc(label)} · ${technical(formatDisplayDateTime(at))}${dur ? technical(dur) : ''}</span>`
      : `<span data-generation-step="${stepName}" data-step-status="${esc(st)}">${esc(label)}</span>`
  }
  const timelineHtml = generationRows.map(row => `<tr data-generation-timeline-row="${row.generationId}"><td>${technical(`#${row.generationId}`)}</td><td>${renderStepCell(row, 'built')}</td><td>${renderStepCell(row, 'tested')}</td><td>${renderStepCell(row, 'activated')}</td><td>${technical(duration(row.durationMs))}</td><td>${statusPill({ tone: row.status === 'active' ? 'ok' : row.status === 'failed' ? 'bad' : row.status === 'rolled-back' ? 'warn' : 'neutral', hollow: row.status !== 'active' && row.status !== 'rolled-back' && row.status !== 'failed', label: t(row.status === 'active' ? msgid('Active') : row.status === 'failed' ? msgid('Failed') : row.status === 'rolled-back' ? msgid('Rolled back') : msgctxt('theme:v2', 'Superseded')) })}</td></tr>`).join('')
  const generationTimeline = `<div class="v2-observation__scroll" role="region" tabindex="0" aria-label="${esc(t(msgid('Generation step timeline')))}"><table${columnLabels(t, timelineColumns)}><caption class="v2-sr">${esc(t(msgid('Generation step timeline')))}</caption><thead><tr>${timelineColumns.map(label => `<th scope="col">${esc(t(label))}</th>`).join('')}</tr></thead><tbody data-whm-generation-timeline>${timelineHtml || `<tr><td colspan="6">${esc(t(generationsSupplied ? msgid('No generations have been recorded yet.') : msgid('Not read')))}</td></tr>`}</tbody></table></div>`
  const body = section(t, 'jobs-history', msgid('Job history'), filters + status(t, msgid('Job history has not been read. No job status or completion is assumed.'), { 'data-whm-jobs-status': true })
    + `<div class="v2-observation__groups" data-whm-jobs-loading aria-busy="true" aria-label="${esc(t(msgid('Loading jobs')))}" hidden><span class="v2-skeleton"></span><span class="v2-skeleton"></span></div>`
    + table(t, msgid('Jobs, newest first'), [msgid('Reference'), msgid('Kind'), msgid('Summary'), msgid('Status'), msgid('Progress'), msgid('Created (UTC)'), msgid('Started (UTC)'), msgid('Finished (UTC)'), msgctxt('whm-jobs-workspace', 'Actor')], { 'data-whm-jobs-rows': true }, msgid('No jobs have been read.'))
    + `<div class="v2-state v2-state--empty" data-whm-jobs-empty hidden><span class="v2-state__icon" aria-hidden="true">${icon('search', 22)}</span><h3>${esc(t(msgid('No jobs match these filters')))}</h3>${help(t, msgid('No host job was recorded for this status and kind. Clear a filter to see more.'))}</div>`
    + help(t, msgid('Newest first, up to 50 jobs. While a job is queued or running, the list refreshes every 5 seconds while this page is visible.')), { 'data-whm-detail-section': 'jobs-history' })
    + section(t, 'jobs-detail', msgid('Selected job'), status(t, msgid('Select a job to read its steps, verification and log.'), { 'data-whm-jobs-detail-status': true }, 'none')
      + facts(t, [['reference', msgid('Reference')], ['kind', msgid('Kind')], ['summary', msgid('Summary')], ['status', msgid('Status')], ['progress', msgid('Progress')], ['actor', msgctxt('whm-jobs-workspace', 'Actor')], ['created', msgid('Created (UTC)')], ['started', msgid('Started (UTC)')], ['finished', msgid('Finished (UTC)')], ['cancellation', msgid('Cancellation')]], 'data-whm-jobs-field')
      + `<div class="v2-notice v2-notice--bad" data-whm-jobs-outcome hidden>${icon('xCircle')}<div class="v2-notice__body"><h3>${esc(t(msgid('Why it did not succeed')))}</h3><p data-whm-jobs-failure></p><p data-whm-jobs-error></p></div></div>`
      + table(t, msgid('Job steps'), [msgid('Order'), msgid('Step'), msgid('State'), msgid('Exit code')], { 'data-whm-jobs-steps': true }, msgctxt('whm-jobs-workspace', 'No job is selected.'))
      + `<div class="v2-observation__groups"><h3>${esc(t(msgid('Host verification')))}</h3><p data-whm-jobs-verification>${esc(t(msgid('Not read')))}</p><pre class="v2-observation__log" dir="ltr" tabindex="0" data-whm-jobs-verification-detail aria-label="${esc(t(msgid('Verification detail')))}" hidden></pre></div>`
      + `<div class="v2-observation__groups"><h3>${esc(t(msgid('Log')))}</h3><p data-whm-jobs-log-status>${esc(t(msgid('No log has been read.')))}</p><pre class="v2-observation__log" dir="ltr" tabindex="0" data-whm-jobs-log aria-label="${esc(t(msgid('Job log')))}"></pre></div>`
      + actions(button(t, msgid('Load more log'), { 'data-whm-jobs-log-more': true }) + button(t, msgid('Cancel job'), { 'data-whm-jobs-cancel': true }))
      + help(t, msgid('Cancellation takes effect between steps. A running step is never interrupted, so a step that changes the host finishes or is reported with an unknown outcome.'))
      + status(t, '', { 'data-whm-jobs-cancel-status': true }, 'unread', true), { 'data-whm-jobs-detail': true, 'data-whm-detail-section': 'jobs-detail' }, false, 'whm-jobs-detail')
    + section(t, 'jobs-generations', msgid('Generation step timeline'), generationTimeline + help(t, msgid('Each configuration generation records when its candidate file set was built, syntax-tested and activated on the host.')), { 'data-whm-detail-section': 'jobs-generations' })
  return page(input, '/whm/jobs', msgid('Jobs'), msgid('Background host jobs such as package updates and repairs, with each step, its exit code, the host verification and the recorded log.'), v2WhmClientTemplates('jobs') + body, { 'data-whm-jobs-workspace': true, 'data-jobs-can-read': String(canRead), 'data-jobs-can-manage': String(canManage) })
}
