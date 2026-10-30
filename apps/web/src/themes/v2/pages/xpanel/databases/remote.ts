import { databaseRemoteTemplates } from '../../../client-templates/data-workspaces.ts'
import { notice } from '../../../components/index.ts'
import { escapeHtml } from '../../../html.ts'
import {
  databaseContext, dbButton, dbCard, dbEmptyRow, dbFacts, dbField, dbPage, dbTable,
  NO_DATABASE_AUTHORITY, technical, type DatabasePageAuthority, type DatabasePageProps,
} from './common.ts'

export function renderV2DatabaseRemotePage(props: DatabasePageProps, authority: DatabasePageAuthority = NO_DATABASE_AUTHORITY): string {
  const { account, canRead, canManage, direction, locale, t } = databaseContext(props, authority)
  const unread = t('Not read')
  // The existing remote controller has one admission flag for both reads and writes.
  const connected = canRead && canManage
  const note = connected ? '' : notice(t, { tone: 'warn', text: t(msgctxt('theme:v2', 'Remote-host policy controls are unavailable for this session. No policy has been read or changed.')) })
  const saved = dbCard('remote-policy', t('Remote database access'), `${note}
<p>${escapeHtml(t('Choose outside addresses that may connect to your MariaDB databases. Each allowed host receives the saved grants for all your database users. Localhost is implicit and cannot be removed here.'))}</p>
<p data-remote-status data-state="unread" role="status">${escapeHtml(t('The remote-host policy has not been read.'))}</p>
${dbFacts([
    { label: t('Account'), valueHtml: account ? technical(account.username) : escapeHtml(unread) },
    { label: t('Applies to'), valueHtml: escapeHtml(unread), hooks: { 'data-remote-scope': true } },
    { label: t('Remote hosts'), valueHtml: `<bdi dir="ltr" data-remote-count>— / 100</bdi>` },
  ])}
${dbTable('v2-db-remote-hosts', t('Remote database hosts'), [t('Host'), t('Comment'), t('Added (UTC)'), t('Firewall'), t('Grants'), t('Actions')], dbEmptyRow(6, t('No host policy has been read.')), { 'data-remote-rows': true })}
<div class="v2-db-actions">${dbButton(t('Refresh'), { 'data-remote-refresh': true }, { disabled: !connected })}</div>`)
  const editor = dbCard('remote-editor', t('Add or edit a host'), `<div data-remote-selected-panel class="v2-db-stack" hidden>
${dbFacts([{ label: t('Selected host'), valueHtml: '<bdi dir="ltr" data-remote-selected></bdi>' }])}
${dbField('v2-db-remote-confirmation', t('Type the selected host to confirm a change or removal'), '<input id="v2-db-remote-confirmation" data-remote-confirmation dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" disabled>')}</div>
<div class="v2-db-fields">${dbField('v2-db-remote-host', t('Host or IPv4 network'), '<input id="v2-db-remote-host" data-remote-host dir="ltr" maxlength="64" aria-describedby="v2-db-remote-host-help" placeholder="192.0.2.0/24" autocomplete="off" autocapitalize="off" spellcheck="false" disabled>')}${dbField('v2-db-remote-comment', t('Comment (optional)'), '<input id="v2-db-remote-comment" data-remote-comment maxlength="200" disabled>')}</div>
<p class="v2-db-notes" id="v2-db-remote-host-help">${escapeHtml(t('Use an exact IPv4 or IPv6 address, or an IPv4 CIDR with zero host bits. A range such as 192.0.2.% is saved as 192.0.2.0/24. DNS names, any-host %, /0 and IPv6 subnets are refused.'))}</p>
<div class="v2-db-actions">${dbButton(t('Add host'), { 'data-remote-save': true }, { primary: true, disabled: true })}${dbButton(t('Remove selected host'), { 'data-remote-remove': true }, { disabled: true })}${dbButton(t('Cancel selection'), { 'data-remote-cancel': true }, { disabled: !connected })}</div>
<p class="v2-db-notes">${escapeHtml(t('Changes require fresh account authorization, exact grant and source-scoped TCP/3306 firewall readback, and verified recovery. An unavailable or unverified provider keeps changes disabled. Removing one host preserves every other host and all localhost grants.'))}</p>`)
  return dbPage(t, '/databases/remote-access', t('Remote database access'), t(msgctxt('theme:v2', 'Review saved outside hosts and verified database and firewall access before making a change.')),
    `<div class="v2-db-workspace" data-account-database-remote data-account="${escapeHtml(account?.id ?? '')}" data-username="${escapeHtml(account?.username ?? '')}" data-remote-manage="${connected}"${canRead ? '' : ' data-capability-unavailable="true"'} lang="${locale}" dir="${direction}"><div class="v2-db-columns"><div>${saved}</div><aside aria-label="${escapeHtml(t('Add or edit a host'))}">${editor}</aside></div>${databaseRemoteTemplates(message => escapeHtml(t(message)))}</div>`)
}
