import { accountCronTemplates } from '../../../client-templates/data-workspaces.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { v2Messages } from '../../../messages.ts'
import { card, kpiCard } from '../../../components/index.ts'
import type { IconName } from '../../../icons.ts'
import { escapeHtml } from '../../../html.ts'
import { listFilter, listFilterEmpty, missingServiceAccount, phoneLabels, serviceButton, serviceFacts, serviceField, serviceHeader, serviceSelect, type PanelServiceAuthority } from './common.ts'

export function renderV2CronPage(props: PanelSurfaceProps, authority: PanelServiceAuthority = { canManage: false }): string {
  const t = v2Messages.translator(props.locale ?? 'en')
  const readOnly = authority.presentation === 'read-only'
  const missing = readOnly ? undefined : missingServiceAccount(t, props)
  if (missing) return missing
  const principal = props.visibility?.principal
  const account = !readOnly || authority.canReadFacts === true && principal?.kind === 'user' && props.account?.id === principal.accountId ? props.account : undefined
  const field = (key: string, label: string, options: { value?: string; maxLength?: number; type?: 'text' | 'number'; auto?: boolean } = {}): string => {
    const id = `v2-cron-${key}`
    return serviceField(id, label, `<input id="${id}" class="v2-mono" data-cron-field="${key}" dir="${options.auto ? 'auto' : 'ltr'}" type="${options.type ?? 'text'}" value="${escapeHtml(options.value ?? '')}"${options.maxLength ? ` maxlength="${options.maxLength}"` : ''} disabled>`)
  }
  const unread = t('Not observed')
  const summaries = `<section class="v2-kpi-row" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Scheduled job summary')))}">${[t('Scheduled jobs'), t(msgctxt('theme:v2', 'Last run results')), t('Next run'), t(msgctxt('theme:v2', 'Longest last run'))].map((label, index) => kpiCard({ label, headingLevel: 2, value: unread, tone: 'neutral', ...(index === 0 ? { valueHooks: { 'data-cron-kpi': 'jobs' } } : {}), icon: (['calendar', 'check', 'clock', 'activity'] as readonly IconName[])[index], hooks: { 'data-unread': true }, note: t(msgctxt('theme:v2', 'Read saved jobs and host status before interpreting these values.')) })).join('')}</section>`
  const heads = [t('Job'), t('Schedule'), t('Command'), t('Last run'), t('Duration'), t('Next run'), t('Actions')]
  const listed = !!account && !readOnly && authority.canManage
  // Board filter row: the cron controller stamps each job row with data-list-result from its observed last run.
  const filter = listFilter(t, { id: 'v2-cron-filter', label: t('Filter jobs'), group: t('Last run'), key: 'result', open: listed,
    options: [['', t('All')], ['succeeded', t('Succeeded')], ['failed', t('Failed')], ['never', t('Never run')]] })
  const table = `<div class="v2-panel-service__table" tabindex="0" role="region" aria-label="${escapeHtml(t('Scheduled commands'))}"><table class="v2-table"${phoneLabels(heads)}><thead><tr>${heads.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-cron-jobs><tr><td colspan="7">${escapeHtml(t('The scheduled job list has not been read.'))}</td></tr></tbody></table></div>`
  const jobs = card({
    title: t('Scheduled jobs'), titleId: 'v2-cron-jobs-heading',
    description: t('Saved schedules run as this account through isolated systemd timers after host reconciliation. Saving does not prove a job has run.'),
    actionsHtml: `<span class="v2-muted v2-num" data-cron-capacity>${escapeHtml(t('Capacity has not been read.'))}</span>${serviceButton(t('Read saved jobs'), { 'data-cron-refresh': true }, !listed)}`,
    hooks: { 'data-list-filter': true },
    bodyHtml: `${filter}${table}${listFilterEmpty(t('No jobs match these filters'))}<p data-cron-status data-state="unread" role="status">${escapeHtml(t('The scheduled job list has not been read.'))}</p>`,
  })
  const selected = card({
    title: t('Selected job'), titleId: 'v2-cron-selected-heading',
    description: t('Select a saved job to read its host status or request a run. Host qualification and the current saved source are checked before execution. Unobserved values stay explicit.'),
    actionsHtml: `${serviceButton(t('Read selected job status'), { 'data-cron-observe': true }, true)}${serviceButton(t('Run selected job now'), { 'data-cron-run': true }, true, true)}`,
    bodyHtml: `<section class="v2-panel-service__note" aria-labelledby="v2-cron-last-output-heading"><h3 id="v2-cron-last-output-heading">${escapeHtml(t(msgctxt('theme:v2', 'Last output')))}</h3><p>${escapeHtml(t(msgctxt('theme:v2', 'The selected job journal has not been read. No output or delivery result is assumed.')))}</p><pre class="v2-panel-service__technical v2-mono" dir="ltr" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Last output')))}"></pre></section>`,
  })
  const presetValues = [
    ['*/5 * * * *', t('Every 5 minutes')], ['0 * * * *', t('Every hour, on the hour')],
    ['0 0,12 * * *', t('Twice a day')], ['0 0 * * *', t('Every day')],
    ['0 0 * * 0', t('Every Sunday')], ['0 0 1 * *', t('On the 1st of the month')], ['', t('Custom schedule')],
  ]
  const preset = serviceField('v2-cron-preset', t('Common schedules'), serviceSelect(`<select id="v2-cron-preset" data-cron-preset disabled>${presetValues.map(([value, label]) => `<option value="${value}">${escapeHtml(label!)}</option>`).join('')}</select>`))
  const schedule = `<fieldset><legend>${escapeHtml(t('Schedule'))}</legend>${preset}<div class="v2-panel-service__five">${field('minute', t('Minute'), { value: '*/5', maxLength: 32 })}${field('hour', t('Hour'), { value: '*', maxLength: 32 })}${field('day', t('Day'), { value: '*', maxLength: 32 })}${field('month', t('Month'), { value: '*', maxLength: 32 })}${field('weekday', t('Weekday'), { value: '*', maxLength: 32 })}</div></fieldset>`
  const command = serviceField('v2-cron-command', t('Command to run'), `<textarea id="v2-cron-command" class="v2-mono" data-cron-field="command" dir="ltr" rows="4" maxlength="4096" spellcheck="false" disabled></textarea>`)
  const limit = serviceField('v2-cron-unlimited', t('Runtime limit'), `<label class="v2-check"><input id="v2-cron-unlimited" type="checkbox" data-cron-unlimited checked disabled>${escapeHtml(t('Unlimited'))}</label>`)
  const enabled = serviceField('v2-cron-enabled', t('Schedule state'), `<label class="v2-check"><input id="v2-cron-enabled" type="checkbox" data-cron-enabled checked disabled>${escapeHtml(t('Enable this schedule'))}</label>`)
  const delivery = `<fieldset disabled><legend>${escapeHtml(t('Email the output'))}</legend><div class="v2-panel-service__choices">${[t('Only when it fails'), t('After every run'), t('Never')].map((label, index) => `<label class="v2-check"><input type="radio" name="v2-cron-email-mode"${index === 2 ? ' checked' : ''}>${escapeHtml(label)}</label>`).join('')}</div><p>${escapeHtml(t('Output email is unavailable; no delivery setting is saved from this control.'))}</p></fieldset>`
  // The board's drawer: the job form sits in the side column beside the selected job.
  const editor = card({
    id: 'v2-cron-editor',
    bodyHtml: `<h2 id="v2-cron-editor-heading" data-cron-editor-title>${escapeHtml(t('Add a cron job'))}</h2>${field('comment', t('Job name (optional)'), { maxLength: 255, auto: true })}${schedule}<fieldset><legend>${escapeHtml(t('Command'))}</legend>${command}<div class="v2-panel-service__fields">${field('runtime', t('Stop the job after (seconds)'), { type: 'number', value: '300' })}${limit}${enabled}</div></fieldset>${delivery}<div class="v2-panel-service__actions">${serviceButton(t('Save job'), { 'data-cron-save': true }, true, true)}${serviceButton(t('Reset draft'), { 'data-cron-reset': true }, true)}</div>`,
  })
  const preview = card({
    title: t('Unit preview'), titleId: 'v2-cron-preview-heading',
    bodyHtml: `<p data-cron-preview-state>${escapeHtml(t('No job is selected.'))}</p><pre class="v2-panel-service__technical v2-mono" dir="ltr" data-cron-preview></pre>${serviceFacts([
      { label: t('Execution user'), valueHtml: `<bdi dir="ltr" data-cron-username>${escapeHtml(t('Not read'))}</bdi>` },
      { label: t('Working directory'), valueHtml: `<bdi dir="ltr" data-cron-home>${escapeHtml(t('Not read'))}</bdi>` },
    ])}<section class="v2-panel-service__note" aria-labelledby="v2-cron-next-heading"><h3 id="v2-cron-next-heading">${escapeHtml(t('Next runs (UTC)'))}</h3><div class="v2-panel-service__table" tabindex="0" role="region" aria-label="${escapeHtml(t('Next runs (UTC)'))}"><table class="v2-table"><thead><tr><th scope="col">${escapeHtml(t('Run'))}</th><th scope="col">${escapeHtml(t('Scheduled time'))}</th></tr></thead><tbody><tr><td colspan="2">${escapeHtml(t('Upcoming run times are not read from the host here. The next observed run of each job appears in the job list.'))}</td></tr></tbody></table></div></section>`,
  })
  const how = card({
    title: t('How a job runs'), titleId: 'v2-cron-how-heading',
    bodyHtml: `<div class="v2-panel-service__note"><p>${escapeHtml(t('Each enabled schedule starts a job as your account user from your home directory. The runtime limit stops work that exceeds it. A running job cannot be started again until that execution ends.'))}</p><p>${escapeHtml(t(msgctxt('theme:v2', 'Saving changes configuration only. The observed timer, service result and next run must be read from the host.')))}</p></div>`,
  })
  const output = card({
    title: t('Output email'), titleId: 'v2-cron-output-heading',
    bodyHtml: `${serviceField('v2-cron-mailto', t('Send job output to'), '<input id="v2-cron-mailto" type="email" dir="ltr" disabled>')}<p>${escapeHtml(t('No output-mail transport is connected. No address or delivery result has been invented.'))}</p>`,
  })
  return `<section class="v2-panel-service"${readOnly || !account ? ' data-readonly="true"' : ''} data-v2-panel-service="cron" data-account-cron data-account="${escapeHtml((account?.id ?? ''))}" data-cron-manage="${!!account && !readOnly && authority.canManage}">${serviceHeader(t, '/advanced/cron', t('Cron jobs'), t(msgctxt('theme:v2', 'Run a command on a schedule. Each job becomes a systemd timer that runs as your account, inside your account slice.')), { actionsHtml: serviceButton(t('New job'), { 'data-cron-new': true }, true, true) })}${summaries}${jobs}<div class="v2-panel-service__columns v2-panel-service__columns--drawer"><div class="v2-panel-service__main">${selected}${preview}<div class="v2-panel-service__pair">${how}${output}</div></div><aside class="v2-panel-service__aside" aria-label="${escapeHtml(t('Add a cron job'))}">${editor}</aside></div>${accountCronTemplates()}</section>`
}
