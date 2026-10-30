import { classicWhmClientTemplates } from '../themes/classic/whm-client-templates.ts'
import { localeDirection, type Locale, type MessageValues, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const STATUS_FILTERS: readonly (readonly [string, string])[] = [
  ['', msgid('Any status')],
  ['queued', msgctxt('whm-jobs-workspace', 'Queued')],
  ['running', msgid('Running')],
  ['succeeded', msgid('Succeeded')],
  ['failed', msgctxt('whm-jobs-workspace', 'Failed')],
  ['cancelled', msgctxt('whm-jobs-workspace', 'Cancelled')],
]

const styles = `<style>.xp-whm-jobs :is(h3,p,dl,dd,pre){margin:0}.xp-whm-jobs__group{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-whm-jobs__heading{display:flex;flex-direction:column;gap:8px}.xp-whm-jobs__loading,.xp-whm-jobs__empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start}.xp-whm-jobs__loading{align-items:stretch}.xp-whm-jobs__progress{display:flex;align-items:center;gap:8px;min-inline-size:128px}.xp-whm-jobs__progress .xp-meter__track{flex:1 1 auto;min-inline-size:64px}.xp-whm-jobs__select{appearance:none;background:none;border:0;padding:0;font:inherit;color:var(--xp-accent,#1d5bd6);text-decoration:underline;cursor:pointer;text-align:start;display:inline-flex;align-items:center;min-block-size:var(--xp-hit-target,44px);max-inline-size:100%;overflow-wrap:anywhere}.xp-whm-jobs__select[aria-pressed="true"]{font-weight:700;text-decoration:none}.xp-whm-jobs__select:focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}.xp-whm-jobs__log,.xp-whm-jobs__json{max-block-size:480px;overflow:auto;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;background:var(--xp-bg-elevated,#f7f8fa);white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--xp-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:13px;line-height:1.6;text-align:left}.xp-whm-jobs__json{max-block-size:240px}.xp-whm-jobs__facts dd{overflow-wrap:anywhere}.xp-whm-jobs [data-whm-detail-section="jobs-history"] .xp-whm-detail-table{min-inline-size:64rem}.xp-whm-jobs .xp-whm-detail-table th{white-space:nowrap;overflow-wrap:normal;word-break:normal}.xp-whm-jobs .xp-whm-detail-table bdi,.xp-whm-jobs__facts bdi{font-family:var(--xp-font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}</style>`

/** Complete /whm/jobs page body: durable host job history, step detail, verification and log. */
export function renderWhmJobsWorkspace(input: { locale: Locale; canRead: boolean; canManage?: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = input.canRead ? '' : ' disabled'
  const fact = (key: string, label: string): string => `<div class="xp-whm-detail-field"><dt>${label}</dt><dd data-whm-jobs-field="${key}">${t('Not read')}</dd></div>`
  const headers = [t('Reference'), t('Kind'), t('Summary'), t('Status'), t('Progress'), t('Created (UTC)'), t('Started (UTC)'), t('Finished (UTC)'), t(msgctxt('whm-jobs-workspace', 'Actor'))]
  return `${styles}<section class="xp-whm-detail xp-whm-jobs" data-whm-detail-route="/whm/jobs" data-whm-jobs-workspace data-jobs-can-read="${input.canRead}" data-jobs-can-manage="${input.canRead && input.canManage === true}" data-capability-state="${input.canRead ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${classicWhmClientTemplates('jobs')}
  <header class="xp-whm-detail-heading"><h1>${t('Jobs')}</h1><p>${t('Background host jobs such as package updates and repairs, with each step, its exit code, the host verification and the recorded log.')}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" data-whm-detail-section="jobs-history" aria-labelledby="whm-jobs-history-heading">
      <h2 id="whm-jobs-history-heading">${t('Job history')}</h2>
      <${input.canRead ? 'form' : 'div'} class="xp-whm-jobs__group" data-whm-jobs-filters aria-label="${t('Filter jobs')}" novalidate>
        <div class="xp-whm-detail-fields">
          <div class="xp-whm-detail-field"><label for="whm-jobs-status">${t('Status')}</label><select id="whm-jobs-status" name="status" class="xp-select" data-whm-jobs-status-filter${disabled}>${STATUS_FILTERS.map(([value, label]) => `<option value="${value}">${t(label)}</option>`).join('')}</select></div>
          <div class="xp-whm-detail-field"><label for="whm-jobs-kind">${t('Kind starts with')}</label><input id="whm-jobs-kind" name="kindPrefix" class="xp-input" type="text" dir="ltr" maxlength="128" autocomplete="off" spellcheck="false" placeholder="system.packages" aria-describedby="whm-jobs-kind-help" data-whm-jobs-kind-filter${disabled}><p class="xp-help" id="whm-jobs-kind-help">${t('Lowercase letters, digits and . _ : - only, for example')} <bdi dir="ltr">system.packages</bdi></p></div>
        </div>
        <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary" data-whm-jobs-apply${disabled}>${t('Apply filters')}</button><button type="button" class="xp-btn" data-whm-jobs-clear${disabled}>${t('Clear')}</button><button type="button" class="xp-btn" data-whm-jobs-refresh${disabled}>${t('Refresh')}</button></div>
      </${input.canRead ? 'form' : 'div'}>
      <p class="xp-whm-detail-status" data-whm-jobs-status data-state="unread" role="status">${t('Job history has not been read. No job status or completion is assumed.')}</p>
      <div class="xp-whm-jobs__loading" data-whm-jobs-loading aria-busy="true" aria-label="${t('Loading jobs')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Jobs')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Jobs, newest first')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-jobs-rows><tr><td colspan="9">${t('No jobs have been read.')}</td></tr></tbody></table></div>
      <div class="xp-whm-jobs__empty" data-whm-jobs-empty hidden><h3>${t('No jobs match these filters')}</h3><p>${t('No host job was recorded for this status and kind. Clear a filter to see more.')}</p></div>
      <p class="xp-help">${t('Newest first, up to 50 jobs. While a job is queued or running, the list refreshes every 5 seconds while this page is visible.')}</p>
    </section>
    <section class="xp-whm-detail-card" id="whm-jobs-detail" data-whm-detail-section="jobs-detail" data-whm-jobs-detail aria-labelledby="whm-jobs-detail-heading" aria-live="polite">
      <h2 id="whm-jobs-detail-heading">${t('Selected job')}</h2>
      <p class="xp-whm-detail-status" data-whm-jobs-detail-status data-state="none" role="status">${t('Select a job to read its steps, verification and log.')}</p>
      <dl class="xp-whm-detail-fields xp-whm-jobs__facts">${fact('reference', t('Reference'))}${fact('kind', t('Kind'))}${fact('summary', t('Summary'))}${fact('status', t('Status'))}${fact('progress', t('Progress'))}${fact('actor', t(msgctxt('whm-jobs-workspace', 'Actor')))}${fact('created', t('Created (UTC)'))}${fact('started', t('Started (UTC)'))}${fact('finished', t('Finished (UTC)'))}${fact('cancellation', t('Cancellation'))}</dl>
      <div class="xp-whm-jobs__group" data-whm-jobs-outcome hidden><h3>${t('Why it did not succeed')}</h3><p data-whm-jobs-failure></p><p class="xp-help" data-whm-jobs-error></p></div>
      <div class="xp-whm-jobs__group"><h3>${t('Steps')}</h3><div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Job steps')}"><table class="xp-whm-detail-table xp-table"><thead><tr><th scope="col">${t('Order')}</th><th scope="col">${t('Step')}</th><th scope="col">${t('State')}</th><th scope="col">${t('Exit code')}</th></tr></thead><tbody data-whm-jobs-steps><tr><td colspan="4">${t(msgctxt('whm-jobs-workspace', 'No job is selected.'))}</td></tr></tbody></table></div></div>
      <div class="xp-whm-jobs__group"><h3>${t('Host verification')}</h3><p data-whm-jobs-verification>${t('Not read')}</p><pre class="xp-whm-jobs__json" dir="ltr" tabindex="0" aria-label="${t('Verification detail')}" data-whm-jobs-verification-detail hidden></pre></div>
      <div class="xp-whm-jobs__group"><div class="xp-whm-jobs__heading"><h3>${t('Log')}</h3><p class="xp-help" data-whm-jobs-log-status>${t('No log has been read.')}</p></div><pre class="xp-whm-jobs__log" dir="ltr" tabindex="0" aria-label="${t('Job log')}" data-whm-jobs-log></pre></div>
      <div class="xp-whm-jobs__group"><div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-jobs-log-more disabled>${t('Load more log')}</button><button type="button" class="xp-btn xp-btn--danger" data-whm-jobs-cancel disabled>${t('Cancel job')}</button></div><p class="xp-help">${t('Cancellation takes effect between steps. A running step is never interrupted, so a step that changes the host finishes or is reported with an unknown outcome.')}</p><p class="xp-whm-detail-status" data-whm-jobs-cancel-status role="status" hidden></p></div>
    </section>
  </div>
</section>`
}
