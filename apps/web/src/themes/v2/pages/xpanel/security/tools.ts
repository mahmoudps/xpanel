import type { PanelSurfaceProps } from '../../../../contract.ts'
import { kpiCard } from '../../../components/kpi-card.ts'
import type { IconName } from '../../../icons.ts'
import { sshKeyClientTemplates, virusScanClientTemplates } from '../settings/utility-client-templates.ts'
import { actions, area, button, deniedPage, esc, facts, field, input, link, note, page, section, settingsContext, split, status, table, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

export function renderV2AccountSshPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('SSH access')), description = t(msgid('Manage the public keys that can sign in to this account over SSH.'))
  const unread = t(msgid('Not read'))
  const login = section('v2-ssh-login', t(msgid('SSH login')), facts([{ label: t(msgid('Login')), valueHtml: `<span data-ssh-login>${esc(unread)}</span>` }, { label: t(msgid('Username')), valueHtml: `<bdi dir="ltr">${esc((c.account?.username ?? ''))}</bdi>` }, { label: t(msgid('Port')), valueHtml: `<bdi dir="ltr" data-ssh-port>${esc(unread)}</bdi>` }, { label: t(msgid('Shell (account / plan)')), valueHtml: `<bdi dir="ltr" data-ssh-shell>${esc(unread)}</bdi>` }]) + note(t(msgid('Login follows the saved account and plan shell settings; the host itself is not checked here. Keys you add take effect only while login is enabled.'))))
  const keys = section('v2-ssh-keys', t(msgid('Authorized keys')), note(t(msgctxt('theme:v2', 'Public keys allowed to sign in as this account are stored in its authorized_keys file.')))
    + table('v2-ssh-key-list', t(msgid('Authorized keys')), [t(msgid('Type')), t(msgid('Fingerprint')), t(msgid('Comment')), t(msgid('Notes')), t(msgid('Actions'))], unreadRow(5, t(msgid('The key list has not been read.'))), { 'data-ssh-rows': true })
    + `<p class="v2-muted" data-ssh-file>${esc(t(msgid('File state has not been read.')))}</p>`
    + status(t(msgid('The key list has not been read.')), { 'data-ssh-status': true }), actions(button(t(msgid('Read keys')), { 'data-ssh-refresh': true }, !c.editable)))
  const add = section('v2-ssh-add', t(msgid('Add a public key')), field('v2-ssh-key', t(msgid('Public key line')), area('v2-ssh-key', '', ' dir="ltr" rows="4" maxlength="8192" spellcheck="false" autocomplete="off" data-ssh-key', !c.editable), t(msgctxt('theme:v2', 'Paste one Ed25519, ECDSA or RSA public key line. RSA requires at least 3072 bits. Key option prefixes are refused.'))), actions(button(t(msgid('Add key')), { 'data-ssh-add': true }, !c.editable, true)))
  return page(props, authority, '/security/ssh', title, description, sshKeyClientTemplates() + split(login + keys, add), { 'data-account-ssh': true, 'data-ssh-manage': String(c.editable) })
}

export function renderV2VirusScannerPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('Virus scanner')), description = t(msgid('Scan the files in your home directory for malware with ClamAV.'))
  const unread = t(msgid('Not read')), fact = (key: string, label: string) => ({ label, valueHtml: `<bdi dir="ltr" data-vscan-${key}>${esc(unread)}</bdi>` })
  const kpis = `<div class="v2-panel-settings__kpis">${[
    [t(msgctxt('theme:v2', 'Last scan')), t(msgctxt('theme:v2', 'Latest recorded scan.'))], [t(msgctxt('theme:v2', 'Infected files')), t(msgctxt('theme:v2', 'Files reported in the latest finished scan.'))], [t(msgctxt('theme:v2', 'Signatures')), t(msgctxt('theme:v2', 'Scanner signature database.'))], [t(msgid('Next scan')), t(msgctxt('theme:v2', 'Availability comes from the protected scanner.'))],
  ].map(([label, text], index) => kpiCard({ label: label!, value: '—', note: text!, tone: 'neutral', icon: (['calendar', 'files', 'shield', 'activity'] as readonly IconName[])[index], valueHooks: { 'data-vscan-kpi': ['last-scan', 'infected', 'signatures', 'next-scan'][index] } })).join('')}</div>`
  const engine = section('v2-vscan-engine', t(msgid('Scanner')), facts([fact('engine', t(msgid('ClamAV'))), fact('version', t(msgid('Engine version'))), fact('signatures', t(msgid('Signature database'))), fact('signature-date', t(msgid('Signatures dated')))]) + note(t(msgid('The server administrator installs ClamAV and updates its signatures. Your scan uses the signatures shown here.'))))
  const run = section('v2-vscan-start', t(msgid('Scan your home directory')), note(t(msgid('The scan checks every file in your home directory, including your websites. It runs in the background on the server; refresh to follow it.'))) + facts([fact('next', t(msgid('Next scan')))])
    + note(t(msgid('One scan at a time and one start every 15 minutes. Symbolic links are not followed, files larger than 100 MB are skipped and at most 400 MB is scanned from each archive.')))
    + status(t(msgid('The scanner has not been read.')), { 'data-vscan-status': true }), actions(button(t(msgid('Start scan')), { 'data-vscan-start': true }, !c.editable, true) + button(t(msgid('Refresh')), { 'data-vscan-refresh': true }, !c.editable)))
  const history = section('v2-vscan-history', t(msgid('Scan history')), table('v2-vscan-table', t(msgid('Scan history')), [t(msgid('Started (UTC)')), t(msgid('Status')), t(msgid('Result')), t(msgid('Scanned files')), t(msgctxt('theme:v2', 'Infected files'))], unreadRow(5, t(msgid('The scan history has not been read.'))), { 'data-vscan-rows': true })
    + note(t(msgid('The last 10 scans of this account. Infected file paths are relative to your home directory, and at most 50 are listed per scan.'))))
  const remove = section('v2-vscan-remove', t(msgid('Removing infected files')), note(t(msgid('Quarantine and automatic deletion are not available here; the scan only reports infected files. To remove one, open the File manager, go to the path shown in the scan history and delete the file or replace it with a clean copy. Then start a new scan to confirm.'))), authority.relatedRoutes?.has('/files/manager') ? actions(link(t(msgid('Open File manager')), '/files/manager', { 'data-vscan-files': true })) : undefined)
  return page(props, authority, '/security/virus-scanner', title, description, virusScanClientTemplates() + kpis + split(run + history, engine + remove), { 'data-account-virus-scan': true, 'data-vscan-manage': String(c.editable) })
}

export function renderV2AccountWafPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('Web application firewall')), description = t(msgid('See the protection that applies to your sites and switch ModSecurity per domain.'))
  const read = section('v2-waf-protection', t(msgid('Protection for your sites')), status(t(msgid('Nothing has been read yet.')), { 'data-sec-status': true })
    + facts([['modsec', msgid('ModSecurity')], ['crs-version', msgid('Core Rule Set version')], ['rate', msgid('Requests per address (req/s)')], ['body', msgid('Largest request body (MB)')], ['denied', msgid('Answer for denied requests')], ['lists', msgid('Server deny lists')]].map(([key, label]) => ({ label: t(label!), valueHtml: `<bdi dir="ltr" data-sec-field="${key}">${esc(t(msgid('Not read')))}</bdi>` })))
    + note(t(msgid('These limits are set by the server administrator and apply to every site on this server.'))), actions(button(t(msgid('Refresh')), { 'data-sec-action': 'refresh' }, !c.readable)))
  const domains = section('v2-waf-domains', t(msgid('ModSecurity per domain')), table('v2-waf-table', t(msgid('ModSecurity per domain')), [t(msgid('Domain')), t(msgid('ModSecurity')), t(msgid('Actions'))], unreadRow(3, t(msgid('No domains have been read.'))), { 'data-sec-rows': 'domains' })
    + note(t(msgid('Turning ModSecurity off for a domain stops rule checks for its sites. The server deny lists and limits still apply.'))) + '<p data-sec-result role="status" hidden></p>')
  return page(props, authority, '/security/waf', title, description, read + domains, { 'data-sec-workspace': true, 'data-sec-page': 'account-waf', 'data-sec-can-read': String(c.readable), 'data-sec-can-manage': String(c.editable) })
}
