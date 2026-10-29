import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
/** System update plan, package selection and job hand-off for /whm/software/updates. Host data is filled by the client binding. */
export function renderWhmUpdatesWorkspace(input: { locale: Locale; canRead: boolean; canApply: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const notRead = t('Not read')
  const fact = (key: string, label: string, technical = false): string => `<div><dt>${label}</dt><dd>${technical ? `<bdi dir="ltr" data-whm-updates-fact="${key}">${notRead}</bdi>` : `<span data-whm-updates-fact="${key}">${notRead}</span>`}</dd></div>`
  const action = (key: string, label: string, primary = false, enabled = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-whm-updates-action="${key}"${enabled ? '' : ' disabled'}>${label}</button>`
  const headers = [t('Select'), t('Package'), t('Installed'), t('Candidate'), t('Origin'), t('Type'), t('State')]
  return `<div class="xp-whm-updates" data-whm-updates-workspace data-updates-can-read="${input.canRead}" data-updates-can-apply="${input.canApply}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-whm-updates{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-updates :is(h2,p,dl,dd){margin:0}.xp-whm-updates__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-whm-updates__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-updates__facts dd{overflow-wrap:anywhere}.xp-whm-updates__job{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.xp-whm-updates__job[hidden]{display:none}.xp-whm-updates .xp-whm-detail-table th{white-space:nowrap}.xp-whm-updates td input[type="checkbox"]{margin:0}.xp-whm-updates__option{display:flex;flex-direction:column;gap:8px}.xp-whm-updates__option input{margin:0;align-self:flex-start}</style>
    <section class="xp-whm-detail-card" data-whm-detail-section="updates-plan" aria-labelledby="whm-updates-plan">
      <h2 id="whm-updates-plan">${t('Update plan')}</h2>
      <p class="xp-whm-detail-status" data-whm-updates-status data-state="unread" role="status">${t('No update plan has been read. Nothing has been changed.')}</p>
      <dl class="xp-whm-updates__facts">${fact('source', t('Source'), true)}${fact('observed-at', t('Observed at (UTC)'), true)}${fact('total', t('Pending packages'), true)}${fact('security', t('Security updates'), true)}${fact('kernel', t('Kernel packages'), true)}${fact('held', t('Held packages'), true)}${fact('reboot', t('Reboot required'))}${fact('writers', t('Other package managers running'))}${fact('database', t('Package database'))}</dl>
      <div class="xp-whm-updates__option"><label for="whm-updates-exclude-kernel">${t('Exclude kernel packages from this update')}</label><input id="whm-updates-exclude-kernel" type="checkbox" data-whm-updates-exclude-kernel aria-describedby="whm-updates-exclude-help"${input.canRead ? '' : ' disabled'}><p id="whm-updates-exclude-help" class="xp-help">${t('Read a new plan after changing this option. Kernel rows remain visible and excluded; a kernel dependency blocks the update. System package holds are unchanged.')}</p></div>
      <div class="xp-whm-detail-actions">${action('read', t('Read update plan'), false, input.canRead)}${action('refresh', t('Refresh package lists'))}${action('security', t('Apply security updates'), true)}${action('selected', t('Apply selected'))}${action('all', t('Apply all'))}</div>
      <p class="xp-whm-detail-status" data-whm-updates-safety data-state="unread" role="status" hidden></p><a class="xp-btn" data-whm-updates-repair-link href="/whm/monitoring/repair?lang=${input.locale}" hidden>${t('Open repair center')}</a>
      <p class="xp-help">${t('Updates run as a host job and are verified by reading the plan again. Held packages and new dependencies cannot be selected. Services are not restarted automatically: needrestart only lists services that need a restart, and kernel updates take effect after a reboot.')}</p>
      <p class="xp-whm-updates__job" data-whm-updates-job hidden><span>${t('Job submitted:')}</span> <a class="xp-btn" data-whm-updates-job-link href="/whm/jobs?lang=${input.locale}">${t('Open job')}</a></p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="updates-packages" aria-labelledby="whm-updates-packages">
      <h2 id="whm-updates-packages">${t('Pending packages')}</h2>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Pending package updates')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('Pending package updates')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-updates-rows><tr><td colspan="7">${t('No update plan has been read.')}</td></tr></tbody></table></div>
    </section>
  </div>`
}
