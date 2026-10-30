import { localeDirection } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml } from '../../../html.ts'
import { lifecycleButton, lifecycleCard, lifecycleFacts, lifecycleField, lifecycleHeader, lifecycleStatus, lifecycleTable, text, type LifecycleAccess } from './shared.ts'

export interface V2UpgradePageProps extends LifecycleAccess {
  readonly hostname?: string
}

const CHECKS = [
  ['disk-space', msgid('Free space is at least twice the release')],
  ['os-supported', msgid('Operating system is supported')],
  ['no-active-transfer', msgid('No transfer or queued job is running')],
  ['version-newer', msgid('Target release is newer')],
  ['schema-compatible', msgid('Schema change is forward only')],
] as const

const PHASES = [
  ['precheck', msgid('Precheck')], ['snapshot', msgid('Snapshot')], ['stage', msgid('Stage')],
  ['migrate', msgid('Migrate')], ['switch', msgid('Switch')], ['health-check', msgid('Health')], ['rollback', msgid('Rollback')],
] as const

/** Release and host observations are filled by the authoritative upgrade controller, never prototype values. */
export function renderV2UpgradePage(props: V2UpgradePageProps): string {
  const t = v2Messages.translator(props.locale)
  const button = (key: string, label: string, primary = false): string => lifecycleButton(t, label, { [`data-upgrade-${key}`]: true }, primary)
  const status = (key: string, label: string): string => lifecycleStatus(t, label, { [`data-upgrade-${key}`]: true })
  const fact = (key: string, label: string): { key: string; label: string } => ({ key, label })
  const facts = (rows: readonly { key: string; label: string }[]): string => lifecycleFacts(t, rows, 'data-upgrade-fact')
  const actions = (body: string): string => `<div class="v2-lifecycle__actions">${body}</div>`
  const release = lifecycleCard(t, 'upgrade-release', msgid('Release'), `
<div class="v2-lifecycle__fields"><section class="v2-lifecycle__group" aria-label="${text(t, msgid('Current'))}"><h3>${text(t, msgid('Current'))}</h3>${facts([fact('current-version', msgid('Installed')), fact('current-schema', msgid('Schema')), fact('current-path', msgid('Release folder')), fact('current-since', msgid('Since (UTC)'))])}</section>
<section class="v2-lifecycle__group" aria-label="${text(t, msgid('Available'))}"><h3>${text(t, msgid('Available'))}</h3>${facts([fact('available-version', msgid('Version')), fact('available-schema', msgid('Schema')), fact('available-bytes', msgid('Unpacked size')), fact('available-signature', msgid('Signature'))])}</section></div>
${lifecycleField(t, 'v2-upgrade-target', msgid('Target release'), `<select id="v2-upgrade-target" name="targetRelease" data-upgrade-target disabled><option value="">${text(t, msgid('No verified staged release has been read'))}</option></select>`, msgid('Only releases staged on this server whose Ed25519 signature verifies against the root-held release keys are listed.'))}
${facts([fact('trust-keys', msgid('Trusted release keys')), fact('trust-source', msgid('Key file')), fact('staged-directory', msgid('Staging folder')), fact('coordinator', msgid('Upgrade coordinator'))])}
${lifecycleTable(t, msgid('Staged releases'), [msgid('Manifest'), msgid('Version'), msgid('Schema'), msgid('Signature')], { 'data-upgrade-staged': true }, msgid('No staged release has been read.'))}
<h3>${text(t, msgid('What changes'))}</h3>
${status('notes', msgid('Release notes are not part of the signed release manifest, so none are shown as evidence.'))}
${status('migrations', msgid('Migrations in this release: the schema range is read from the signed manifest; individual migrations are checked by the upgrade machine after unpacking and must be expand only.'))}
${actions(button('refresh', msgid('Read release state')) + button('preflight', msgid('Run preflight again')) + button('open-confirm', msgid('Upgrade to selected release'), true))}
<details class="v2-lifecycle__group" data-upgrade-confirm><summary>${text(t, msgid('Confirm upgrade'))}</summary>
<dl class="v2-lifecycle__fields"><div class="v2-lifecycle__field"><dt>${text(t, msgid('Server'))}</dt><dd><bdi dir="ltr">${!props.canRead || props.hostname === undefined ? text(t, msgid('Not read')) : escapeHtml(props.hostname)}</bdi></dd></div></dl>
${facts([fact('confirm-from', msgid('From version')), fact('confirm-to', msgid('To version'))])}
<p>${text(t, msgid('Panel sign-in pauses while the xPanel API and agent restart. Sites, mail and databases keep serving. If the health check fails, the previous release is switched back and the current desired state is reconciled; earlier generations are not replayed.'))}</p>
<div class="v2-lifecycle__field"><label for="v2-upgrade-phrase">${text(t, msgid('Type the confirmation exactly'))} <bdi dir="ltr" data-upgrade-fact="confirm-phrase">upgrade</bdi></label><input id="v2-upgrade-phrase" type="text" dir="ltr" autocomplete="off" spellcheck="false" data-upgrade-confirm-input disabled></div>
${actions(button('cancel', msgid('Cancel')) + button('start', msgid('Start upgrade'), true))}</details>
${status('status', msgid('No upgrade has been requested from this page.'))}
`, { 'data-whm-detail-section': 'upgrade-version' })

  const preflight = lifecycleCard(t, 'upgrade-preflight', msgid('Preflight'), `
${status('preflight-summary', msgid('Preflight has not run. Every value is read from this server when it runs.'))}
<div class="v2-lifecycle__scroll" role="region" tabindex="0" aria-label="${text(t, msgid('Preflight checks'))}"><table class="v2-lifecycle__table"><caption class="v2-sr">${text(t, msgid('Preflight checks'))}</caption><thead><tr>${[msgid('Check'), msgid('Result'), msgid('Observed')].map(label => `<th scope="col">${text(t, label)}</th>`).join('')}</tr></thead><tbody data-upgrade-checks>${CHECKS.map(([key, label]) => `<tr data-upgrade-check="${key}"><th scope="row">${text(t, label)}</th><td data-upgrade-check-result>${text(t, msgid('Not run'))}</td><td><bdi dir="ltr" data-upgrade-check-detail>${text(t, msgid('Not run'))}</bdi></td></tr>`).join('')}</tbody></table></div>
${facts([fact('snapshot-dir', msgid('Control-database snapshot is written to'))])}
<p>${text(t, msgid('Rollback reconciles the current desired state; earlier generations are not replayed.'))}</p>
`, { 'data-whm-detail-section': 'upgrade-preflight' })

  const progress = lifecycleCard(t, 'upgrade-progress', msgid('Upgrade job and progress'), `
<div data-upgrade-progress-state="not-read">${status('progress', msgid('No upgrade job or progress observation has been read.'))}</div>
<div class="v2-lifecycle__scroll" role="region" tabindex="0" aria-label="${text(t, msgid('Upgrade progress'))}"><table class="v2-lifecycle__table"><caption class="v2-sr">${text(t, msgid('Upgrade progress'))}</caption><thead><tr><th scope="col">${text(t, msgid('Phase'))}</th><th scope="col">${text(t, msgid('State'))}</th></tr></thead><tbody data-upgrade-phases>${PHASES.map(([key, label]) => `<tr data-upgrade-phase="${key}"><th scope="row">${text(t, label)}</th><td data-upgrade-phase-state>${text(t, msgid('Not read'))}</td></tr>`).join('')}</tbody></table></div>
${actions(button('cancel-pending', msgid('Cancel pending upgrade')))}
<p class="v2-muted">${text(t, msgid('The upgrade machine has no cancel step. Once handed off it finishes or rolls back on its own.'))}</p>
`, { 'data-whm-detail-section': 'upgrade-job' })

  const history = lifecycleCard(t, 'upgrade-history', msgid('Upgrade history'), `${lifecycleTable(t, msgid('Upgrade history'), [msgid('From → to'), msgid('Schema'), msgid('Started (UTC)'), msgid('Result'), msgid('Actor'), msgid('Reason')], { 'data-upgrade-history': true }, msgid('No records have been read.'))}<a class="v2-btn" href="/whm/audit?lang=${props.locale}">${text(t, msgid('All entries in the audit log'))}</a>`, { 'data-whm-detail-section': 'upgrade-history' })
  const list = (labels: readonly string[]): string => `<ul>${labels.map(label => `<li>${text(t, label)}</li>`).join('')}</ul>`
  const boundaries = lifecycleCard(t, 'upgrade-boundaries', msgid('What an upgrade touches'), `
<h3>${text(t, msgid('Never touched'))}</h3>${list([msgctxt('theme:v2', 'Account homes in /home'), msgid('Mail stores and mailboxes'), msgid('Customer MariaDB databases')])}
<h3>${text(t, msgid('Kept as they are'))}</h3>${list([msgid('UIDs and GIDs of every account'), msgid('Account slices and their limits'), msgid('Disk quotas, IO bandwidth and IOPS caps')])}
<h3>${text(t, msgid('Added'))}</h3>${facts([fact('added-release', msgid('Release folder')), fact('added-schema', msgid('Control-database schema'))])}
<p>${text(t, msgid('A new configuration generation is built from the same desired state after the switch.'))}</p>
`)
  const health = lifecycleCard(t, 'upgrade-health', msgid('Health check after the switch'), `<p>${text(t, msgid('Every check must pass within the health attempts. Any failure starts the automatic rollback.'))}</p>${list([
    msgid('Reconciler equals the desired state and account identities are unchanged'),
    msgid('A canary account is served under its own UID, when a canary is configured'),
    msgid('The control plane services and private IPC are ready'),
  ])}`)
  const process = lifecycleCard(t, 'upgrade-process', msgid('How the upgrade runs'), `<p>${text(t, msgid('Only xPanel’s own services restart. Nginx, Apache, PHP-FPM, MariaDB and mail are reloaded at most.'))}</p><ol>${PHASES.filter(([key]) => key !== 'rollback').map(([, label]) => `<li>${text(t, label)}</li>`).join('')}</ol><p>${text(t, msgid('A healthy host flow stays recorded as retirement pending until the native coordinator settles it. A failed health check switches back to the previous release.'))}</p>`)
  return `<div class="v2-lifecycle" data-whm-detail-route="/whm/server/upgrade" lang="${props.locale}" dir="${localeDirection(props.locale)}">
${lifecycleHeader(t, msgid('Upgrade'), '/whm/server/upgrade', msgctxt('theme:v2', 'Review a verified release, run host preflight and confirm before changing the control plane.'))}
<div class="v2-lifecycle__column" data-whm-upgrade-workspace data-upgrade-can-manage="${props.canRead && props.canManage}">
${status('banner', props.canRead ? msgid('Release state has not been read. Nothing has changed.') : msgctxt('theme:v2', 'Upgrade state is unavailable to this account. Nothing has changed.'))}
<div class="v2-lifecycle__grid"><div class="v2-lifecycle__column">${release}${preflight}${progress}${history}</div><aside class="v2-lifecycle__column" aria-label="${text(t, msgctxt('theme:v2', 'Upgrade behavior and recovery'))}">${boundaries}${health}${process}</aside></div>
</div></div>`
}
