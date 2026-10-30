import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { classicWhmDiagnosticTemplates } from './whm-diagnostic-client-templates.ts'
/** Repair center body for /whm/monitoring/repair. Findings are filled by WHM_REPAIR_CLIENT_BINDING from authorized reads only. */
export function renderWhmRepairWorkspace(input: { locale: Locale; canRead: boolean; canRepair: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-whm-repair-${key}>${t('Not read')}</bdi></dd></div>`
  const list = (key: string, label: string): string => `<details data-whm-repair-${key}-group hidden><summary>${label}</summary><ul class="xp-whm-repair__packages" dir="ltr" data-whm-repair-${key}-list></ul></details>`
  return `<div class="xp-whm-repair" data-whm-repair-workspace data-repair-can-read="${input.canRead}" data-repair-can-repair="${input.canRead && input.canRepair}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    ${classicWhmDiagnosticTemplates()}
    <style>.xp-whm-repair{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-repair :is(h2,h3,p,dl,dd,ul,pre){margin:0}.xp-whm-repair__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:16px}.xp-whm-repair__summary>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-repair__summary dt{font-weight:600}.xp-whm-repair__summary dd{overflow-wrap:anywhere}.xp-whm-repair__list{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-whm-repair__item{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;min-inline-size:0}.xp-whm-repair__item[data-state="problem"]{border-color:var(--xp-danger,#b42318)}.xp-whm-repair__item-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}.xp-whm-repair__item-head h3{font-size:16px;line-height:1.6}.xp-whm-repair__evidence{max-block-size:320px;overflow:auto;padding:16px;border-radius:8px;background:var(--xp-bg-elevated);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;text-align:start}.xp-whm-repair__packages{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}.xp-whm-repair__packages li{padding:0 8px;line-height:2;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;overflow-wrap:anywhere}.xp-whm-repair__removals{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--xp-danger,#b42318);border-radius:8px}.xp-whm-repair__removals strong{color:var(--xp-danger,#b42318)}.xp-whm-repair details{display:flex;flex-direction:column;gap:8px}.xp-whm-repair summary{cursor:pointer;min-block-size:44px;align-content:center;font-weight:600}.xp-whm-repair details[open]>:not(summary){margin-block-start:8px}.xp-whm-repair :is(button,a,summary,pre):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}</style>
    <section class="xp-whm-detail-card" data-whm-detail-section="repair-summary" aria-labelledby="whm-detail-repair-summary">
      <h2 id="whm-detail-repair-summary">${t('Diagnostics')}</h2>
      <p class="xp-help">${t('Diagnostics run read-only package database, service configuration and drift checks on this server. Nothing changes until you preview and start a reviewed repair.')}</p>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-repair-diagnose${input.canRead ? '' : ' disabled'}>${t('Run diagnostics')}</button></div>
      <p class="xp-whm-detail-status" data-whm-repair-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('Diagnostics have not been run.') : t('Repair diagnostics require an authorized root administrator. Nothing was read or changed.')}</p>
      <dl class="xp-whm-repair__summary">${fact('count-problem', t('Problems'))}${fact('count-ok', t(msgctxt('whm-repair-workspace', 'No problem found')))}${fact('count-unavailable', t(msgctxt('whm-repair-workspace', 'Not verified')))}${fact('observed-at', t('Observed at (UTC)'))}</dl>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="repair-findings" aria-labelledby="whm-detail-repair-findings">
      <h2 id="whm-detail-repair-findings">${t('Findings')}</h2>
      <div class="xp-whm-repair__list" data-whm-repair-list aria-live="polite"><p class="xp-help" data-whm-repair-empty>${t('No diagnostics have been read.')}</p></div>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="repair-preview" data-whm-repair-preview aria-labelledby="whm-detail-repair-preview" hidden>
      <h2 id="whm-detail-repair-preview">${t('Repair preview')}</h2>
      <p data-whm-repair-preview-summary></p>
      <dl class="xp-whm-repair__summary">${fact('preview-install', t('Install or upgrade'))}${fact('preview-remove', t(msgctxt('whm-repair-workspace', 'Remove')))}${fact('preview-configure', t(msgctxt('whm-repair-workspace', 'Configure')))}</dl>
      <div class="xp-whm-repair__removals" data-whm-repair-removals role="alert" hidden><strong>${t('Packages will be removed')}</strong><p data-whm-repair-removals-text></p><ul class="xp-whm-repair__packages" dir="ltr" data-whm-repair-remove-list></ul></div>
      ${list('install', t('Packages to install or upgrade'))}${list('configure', t('Packages to configure'))}
      <details><summary>${t('Preview output')}</summary><pre class="xp-whm-repair__evidence" dir="ltr" tabindex="0" data-whm-repair-preview-evidence></pre></details>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-whm-repair-start disabled>${t('Run repair')}</button><button type="button" class="xp-btn" data-whm-repair-cancel>${t('Cancel')}</button></div>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="repair-job" data-whm-repair-job aria-labelledby="whm-detail-repair-job" hidden>
      <h2 id="whm-detail-repair-job">${t('Repair job')}</h2>
      <p class="xp-whm-detail-status" data-whm-repair-job-status role="status"></p>
      <div class="xp-whm-detail-actions"><a class="xp-btn" href="/whm/jobs" data-whm-repair-job-link>${t('Open job')}</a><button type="button" class="xp-btn" data-whm-repair-rerun>${t('Re-run diagnostics')}</button></div>
    </section>
  </div>`
}
