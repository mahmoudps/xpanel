import { type Locale, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

type Copy = string
const notRead = msgid('Not read')
const notRun = msgid('Not run')

/** Preflight checks in the order the upgrade machine's pure preflight reports them. */
export const UPGRADE_PREFLIGHT_CHECKS: readonly (readonly [string, Copy])[] = [
  ['disk-space', msgid('Free space is at least twice the release')],
  ['os-supported', msgid('Operating system is supported')],
  ['no-active-transfer', msgid('No transfer or queued job is running')],
  ['version-newer', msgid('Target release is newer')],
  ['schema-compatible', msgid('Schema change is forward only')],
]
/** Phases recorded on the upgrades row by the machine. */
export const UPGRADE_PHASES: readonly (readonly [string, Copy])[] = [
  ['precheck', msgid('Precheck')], ['snapshot', msgid('Snapshot')], ['stage', msgid('Stage')],
  ['migrate', msgid('Migrate')], ['switch', msgid('Switch')], ['health-check', msgid('Health')], ['rollback', msgid('Rollback')],
]

/** Every approved upgrade card, server-rendered disabled; the client binding enables controls only from host observations. */
export function renderWhmUpgradeWorkspace(input: { locale: Locale; canManage: boolean; hostname?: string }): { main: string; aside: string } {
  const rtl = localeDirection(input.locale) === 'rtl'
  const t = (copy: Copy): string => escapeHtml(translator(input.locale)(copy))
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" data-whm-detail-section="${key}" aria-labelledby="whm-detail-${key}"><h2 id="whm-detail-${key}">${t(title)}</h2>${body}</section>`
  const status = (copy: Copy, attribute: string, role = 'status'): string => `<p class="xp-whm-detail-status" ${attribute} role="${role}">${t(copy)}</p>`
  const fact = (key: string, label: Copy): string => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd><bdi dir="ltr" style="overflow-wrap: anywhere" data-upgrade-fact="${key}">${t(notRead)}</bdi></dd></div>`
  const button = (copy: Copy, attribute: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" ${attribute} disabled>${t(copy)}</button>`
  const table = (title: Copy, headers: readonly Copy[], body: string, attribute: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(title)}"><table class="xp-whm-detail-table"><caption class="sr-only">${t(title)}</caption><thead><tr>${headers.map(h => `<th scope="col">${t(h)}</th>`).join('')}</tr></thead><tbody ${attribute}>${body}</tbody></table></div>`
  const empty = (columns: number, copy: Copy): string => `<tr><td colspan="${columns}">${t(copy)}</td></tr>`
  const hostname = input.hostname ? escapeHtml(input.hostname) : t(notRead)

  const release = `<div class="xp-whm-upgrade" data-whm-upgrade-workspace data-upgrade-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
<style>.xp-whm-upgrade{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-upgrade :is(p,dl,dd,h3){margin:0}.xp-whm-upgrade__pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}.xp-whm-upgrade__pair>section{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-whm-upgrade bdi{overflow-wrap:anywhere}.xp-whm-upgrade .xp-whm-detail-field>label{padding-inline:var(--xp-control-content-inset,13px)}[data-whm-detail-route="/whm/server/upgrade"] [data-whm-detail-section^="upgrade-"]>ul{margin-block:0}.xp-whm-upgrade__confirm{display:flex;flex-direction:column;gap:16px}</style>
${status(msgid('Release state has not been read. Nothing has changed.'), 'data-upgrade-banner')}
<div class="xp-whm-upgrade__pair"><section aria-labelledby="whm-upgrade-current"><h3 id="whm-upgrade-current">${t(msgid('Current'))}</h3><dl class="xp-whm-detail-fields">${fact('current-version', msgid('Installed'))}${fact('current-schema', msgid('Schema'))}${fact('current-path', msgid('Release folder'))}${fact('current-since', msgid('Since (UTC)'))}</dl></section>
<section aria-labelledby="whm-upgrade-available"><h3 id="whm-upgrade-available">${t(msgid(msgctxt('whm-upgrade-workspace', 'Available')))}</h3><dl class="xp-whm-detail-fields">${fact('available-version', msgid('Version'))}${fact('available-schema', msgid('Schema'))}${fact('available-bytes', msgid('Unpacked size'))}${fact('available-signature', msgid('Signature'))}</dl></section></div>
<div class="xp-whm-detail-field"><label for="whm-upgrade-target">${t(msgid('Target release'))}</label><select id="whm-upgrade-target" name="targetRelease" data-upgrade-target disabled><option value="">${t(msgid('No verified staged release has been read'))}</option></select><p class="xp-help">${t(msgid('Only releases staged on this server whose Ed25519 signature verifies against the root-held release keys are listed.'))}</p></div>
<dl class="xp-whm-detail-fields">${fact('trust-keys', msgid('Trusted release keys'))}${fact('trust-source', msgid('Key file'))}${fact('staged-directory', msgid('Staging folder'))}${fact('coordinator', msgid('Upgrade coordinator'))}</dl>
${table(msgid('Staged releases'), [msgid('Manifest'), msgid('Version'), msgid('Schema'), msgid('Signature')], empty(4, msgid('No staged release has been read.')), 'data-upgrade-staged')}
<h3>${t(msgid(msgctxt('whm-upgrade-workspace', 'What changes')))}</h3>
${status(msgid('Release notes are not part of the signed release manifest, so none are shown as evidence.'), 'data-upgrade-notes')}
${status(msgid('Migrations in this release: the schema range is read from the signed manifest; individual migrations are checked by the upgrade machine after unpacking and must be expand only.'), 'data-upgrade-migrations')}
<div class="xp-whm-detail-actions">${button(msgid('Read release state'), 'data-upgrade-refresh')}${button(msgid('Run preflight again'), 'data-upgrade-preflight')}${button(msgid('Upgrade to selected release'), 'data-upgrade-open-confirm', true)}</div>
<details class="xp-whm-upgrade__confirm" data-upgrade-confirm><summary>${t(msgid('Confirm upgrade'))}</summary>
<dl class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><dt>${t(msgid('Server'))}</dt><dd><bdi dir="ltr">${hostname}</bdi></dd></div>${fact('confirm-from', msgid('From version'))}${fact('confirm-to', msgid('To version'))}</dl>
<p>${t(msgid('Panel sign-in pauses while the xPanel API and agent restart. Sites, mail and databases keep serving. If the health check fails, the previous release is switched back and the current desired state is reconciled; earlier generations are not replayed.'))}</p>
<div class="xp-whm-detail-field"><label for="whm-upgrade-confirm-input">${t(msgid('Type the confirmation exactly'))} <bdi dir="ltr" data-upgrade-fact="confirm-phrase">upgrade</bdi></label><input id="whm-upgrade-confirm-input" type="text" dir="ltr" autocomplete="off" spellcheck="false" data-upgrade-confirm-input disabled></div>
<div class="xp-whm-detail-actions">${button(msgid('Cancel'), 'data-upgrade-cancel')}${button(msgid('Start upgrade'), 'data-upgrade-start', true)}</div></details>
${status(msgid('No upgrade has been requested from this page.'), 'data-upgrade-status')}
</div>`

  const checks = UPGRADE_PREFLIGHT_CHECKS.map(([id, title]) => `<tr data-upgrade-check="${id}"><td>${t(title)}</td><td data-upgrade-check-result>${t(notRun)}</td><td><bdi dir="ltr" data-upgrade-check-detail>${t(notRun)}</bdi></td></tr>`).join('')
  const preflight = `${status(msgid('Preflight has not run. Every value is read from this server when it runs.'), 'data-upgrade-preflight-summary')}
${table(msgid('Preflight checks'), [msgid('Check'), msgid('Result'), msgid('Observed')], checks, 'data-upgrade-checks')}
<dl class="xp-whm-detail-fields">${fact('snapshot-dir', msgid('Control-database snapshot is written to'))}<div class="xp-whm-detail-field"><dt>${t(msgid('Current generation'))}</dt><dd>${t(msgid('Rollback reconciles the current desired state; earlier generations are not replayed.'))}</dd></div></dl>`

  const phases = UPGRADE_PHASES.map(([id, title]) => `<tr data-upgrade-phase="${id}"><td>${t(title)}</td><td data-upgrade-phase-state>${t(notRead)}</td></tr>`).join('')
  const job = `<div data-upgrade-progress-state="not-read">${status(msgid('No upgrade job or progress observation has been read.'), 'data-upgrade-progress')}</div>
${table(msgid('Upgrade progress'), [msgid('Phase'), msgid('State')], phases, 'data-upgrade-phases')}
<div class="xp-whm-detail-actions">${button(msgid('Cancel pending upgrade'), 'data-upgrade-cancel-pending')}</div>
<p class="xp-help">${t(msgid('The upgrade machine has no cancel step. Once handed off it finishes or rolls back on its own.'))}</p>`

  const history = `${table(msgid('Upgrade history'), [msgid('From → to'), msgid('Schema'), msgid(msgctxt('whm-upgrade-workspace', 'Started (UTC)')), msgid('Result'), msgid(msgctxt('whm-upgrade-workspace', 'Actor')), msgid('Reason')], empty(6, msgid('No records have been read.')), 'data-upgrade-history')}<a class="xp-btn" href="/whm/audit?lang=${rtl ? 'ar' : 'en'}">${t(msgid('All entries in the audit log'))}</a>`

  const list = (items: readonly Copy[]): string => `<ul>${items.map(item => `<li>${t(item)}</li>`).join('')}</ul>`
  const touches = `<h3>${t(msgid('Never touched'))}</h3><ul><li>${t(msgid('Account homes in'))} <bdi dir="ltr">/home</bdi></li><li>${t(msgid('Mail stores and mailboxes'))}</li><li>${t(msgid('Customer MariaDB databases'))}</li></ul>
<h3>${t(msgid('Kept as they are'))}</h3>${list([msgid('UIDs and GIDs of every account'), msgid('Account slices and their limits'), msgid('Disk quotas, IO bandwidth and IOPS caps')])}
<h3>${t(msgid('Added'))}</h3><dl class="xp-whm-detail-fields">${fact('added-release', msgid('Release folder'))}${fact('added-schema', msgid('Control-database schema'))}</dl><p>${t(msgid('A new configuration generation is built from the same desired state after the switch.'))}</p>`
  const health = `<p>${t(msgid('Every check must pass within the health attempts. Any failure starts the automatic rollback.'))}</p><ol class="xp-whm-detail-steps">${[
    msgid('Reconciler equals the desired state and account identities are unchanged'),
    msgid('A canary account is served under its own UID, when a canary is configured'),
    msgid('The control plane services and private IPC are ready'),
  ].map((step, i) => `<li><strong>${i + 1}</strong>${t(step)}</li>`).join('')}</ol>`
  const runs = `<p>${t(msgid('Only xPanel’s own services restart. Nginx, Apache, PHP-FPM, MariaDB and mail are reloaded at most.'))}</p><ol class="xp-whm-detail-steps">${[
    msgid('Precheck'), msgid('Snapshot'), msgid('Stage'), msgid('Migrate'), msgid('Switch'), msgid('Health'),
  ].map((step, i) => `<li><strong>${i + 1}</strong>${t(step)}</li>`).join('')}</ol><h3>${t(msgid('Result'))}</h3><p>${t(msgid('A healthy host flow stays recorded as retirement pending until the native coordinator settles it. A failed health check switches back to the previous release.'))}</p>`

  return {
    main: card('upgrade-version', msgid(msgctxt('whm-upgrade-workspace', 'Release')), release)
      + card('upgrade-preflight', msgid('Preflight'), preflight)
      + card('upgrade-job', msgid('Upgrade job and progress'), job)
      + card('upgrade-history', msgid('Upgrade history'), history),
    aside: card('upgrade-touches', msgid('What an upgrade touches'), touches)
      + card('upgrade-health', msgid('Health check after the switch'), health)
      + card('upgrade-phases', msgid('How the upgrade runs'), runs),
  }
}
