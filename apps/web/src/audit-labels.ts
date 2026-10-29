import { localeDirection, translator, type Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

/**
 * Human copy (source messages) for every action the panel writes. The target stays a separate line or
 * column. An unknown code becomes a generic sentence so the raw dotted code never appears in the
 * dashboard or the audit log.
 */
export const AUDIT_LABELS: Readonly<Record<string, string>> = {
  'developer.explorer.read': msgid('Read an approved API operation'),
  'panel.branding.favicon_removed': msgid('Removed the favicon'),
  'panel.branding.favicon_uploaded': msgid('Uploaded the favicon'),
  'panel.branding.logo_removed': msgid('Removed the panel logo'),
  'panel.branding.logo_uploaded': msgid('Uploaded the panel logo'),
  'panel.branding.updated': msgid('Updated branding'),
  'panel.languages.catalog_removed': msgid('Removed an uploaded translation catalog'),
  'panel.languages.catalog_uploaded': msgid('Uploaded a translation catalog'),
  'panel.languages.updated': msgid('Updated the offered languages'),
  'panel.settings.updated': msgid('Updated panel settings'),
  'server.trusted_proxies.saved': msgid('Saved the trusted proxy policy'),
  'server.trusted_proxies.applied': msgid('Activated the trusted proxy policy'),
  'configuration.health.repair.requested': msgid('Requested a managed configuration repair'),
  'configuration.health.repair.verified': msgid('Verified a managed configuration repair'),
  'database.remote_access.add': msgid('Added a remote database host'),
  'database.remote_access.edit': msgid('Edited a remote database host'),
  'database.remote_access.remove': msgid('Removed a remote database host'),
  'webmail.spam_preferences.updated': msgid('Saved own mailbox spam preferences'),
  'webmail.mailing_list.subscribed': msgid('Subscribed the mailbox to a mailing list'),
  'webmail.mailing_list.unsubscribed': msgid('Unsubscribed the mailbox from a mailing list'),
  'backup.destination.test': msgid('Tested a backup destination'),
  'backup.destination.activate': msgid('Activated a verified backup destination'),
  'backup.destination.revoke': msgid('Revoked backup destination activation'),
  'admin.preferences.updated': msgid('Updated own display preferences'),
  'server.default_index.updated': msgid('Updated site index filename ordering'),
  'server.default_index.reset': msgid('Reset site index filename ordering'),
  'services.manager.requested': msgid('Requested a service management job'),
  'server.benchmark.run': msgid('Requested a bounded server benchmark'),
  'dns.dynamic.created': msgid('Created a Dynamic DNS credential'),
  'dns.dynamic.rotated': msgid('Rotated a Dynamic DNS credential'),
  'dns.dynamic.deleted': msgid('Removed a Dynamic DNS credential'),
  'dns.dynamic.updated': msgid('Updated a Dynamic DNS record'),
  'domain.site_publisher.publish': msgid('Published a site template'),
  'domain.site_publisher.rollback': msgid('Restored previous site index files'),
  'account.git.init': msgid('Initialized an account repository'),
  'account.git.clone': msgid('Cloned an account repository'),
  'account.git.pull': msgid('Requested a repository update'),
  'account.git.checkout': msgid('Changed a repository branch'),
  'account.git.remove': msgid('Removed a repository registration'),
  'account.pgp.generate': msgid('Generated account OpenPGP keys'),
  'account.pgp.import': msgid('Imported account OpenPGP keys'),
  'account.pgp.delete': msgid('Removed account OpenPGP keys'),
  'account.contact.updated': msgid('Updated an account contact'),
  'account.create.configuration_failed': msgid('Account creation failed on the host'),
  'account.desired.created': msgid('Requested an account'),
  'account.desired.suspended': msgid('Requested a suspension'),
  'account.desired.unsuspended': msgid('Requested an unsuspension'),
  'account.desired.updated': msgid('Requested an account update'),
  'account.owner_changed': msgid('Changed an account owner'),
  'account.password.changed': msgid('Changed an account password'),
  'account.bandwidth_limit_lifted': msgid('Lifted the bandwidth limit page for an account'),
  'account.bandwidth_limited': msgid('Served the bandwidth limit page for an account over its monthly limit'),
  'account.plan_changed': msgid('Changed an account plan'),
  'account.provisioned': msgid('Provisioned an account'),
  'account.suspended': msgid('Suspended an account'),
  'account.suspend.configuration_failed': msgid('Account suspension failed on the host'),
  'account.terminated': msgid('Terminated an account'),
  'account.unsuspended': msgid('Unsuspended an account'),
  'account.unsuspend.configuration_failed': msgid('Account unsuspension failed on the host'),
  'account.update.configuration_failed': msgid('Account update failed on the host'),
  'agent.access_denied': msgid('Denied agent access'),
  'agent.internal_error': msgid('Recorded an agent error'),
  'agent.peer_denied': msgid('Agent refused a request from an unauthorized local user'),
  'api.internal_error': msgid('Recorded an internal error'),
  'app.installed': msgid('Installed an application'),
  'app.staging.cloned': msgid('Cloned a staging site'),
  'app.staging.pushed': msgid('Pushed a staging site'),
  'auth.2fa_disabled': msgid('Disabled two-factor authentication'),
  'auth.2fa_enabled': msgid('Enabled two-factor authentication'),
  'auth.api_token.created': msgid('Created an API token'),
  'auth.api_token.revoked': msgid('Revoked an API token'),
  'auth.csrf_rejected': msgid('Rejected a forged request'),
  'auth.identity_authority_restored': msgid('Restored the identity authority'),
  'auth.lockout': msgid('Locked sign-in'),
  'auth.login': msgid(msgctxt('audit-labels', 'Signed in')),
  'auth.login_denied_suspended': msgid('Refused a suspended sign-in'),
  'auth.login_failed': msgid('Failed sign-in'),
  'auth.login_locked': msgid('Refused a locked sign-in'),
  'auth.logout': msgid(msgctxt('audit-labels', 'Signed out')),
  'auth.mfa_seal_key_loss_recovered': msgid('Recovered a lost two-factor seal'),
  'auth.mfa_seal_key_rotated': msgid('Rotated the two-factor seal key'),
  'auth.origin_rejected': msgid('Rejected the request origin'),
  'auth.password_changed': msgid('Changed a password'),
  'auth.password_reset': msgid('Reset a password'),
  'auth.root_initialized': msgid('Initialized the root account'),
  'backup.account.completed': msgid('Finished an account backup'),
  'backup.destination.created': msgid('Created a backup destination'),
  'backup.schedule.updated': msgid('Updated a backup schedule'),
  'backup.snapshot.created': msgid('Created a backup snapshot'),
  'certificate.issued': msgid('Issued a certificate'),
  'cli.reindex': msgid('Rebuilt the index'),
  'cluster.node.added': msgid('Added a cluster node'),
  'cpanel.import.completed': msgid('Finished a «cPanel» import'),
  'database.created': msgid('Created a database'),
  'database.maintenance.check': msgid('Checked a database'),
  'database.maintenance.optimize': msgid('Optimized a database'),
  'database.maintenance.repair': msgid('Repaired a database'),
  'database.postgresql.created': msgid('Created a «PostgreSQL» database'),
  'database.postgresql.purged': msgid('Purged a database'),
  'database.postgresql.restored': msgid('Restored a database'),
  'database.postgresql.trashed': msgid('Moved a database to trash'),
  'database.purged': msgid('Purged a database'),
  'database.remote_hosts.updated': msgid('Updated remote database hosts'),
  'database.restored': msgid('Restored a database'),
  'database.trashed': msgid('Moved a database to trash'),
  'database_user.created': msgid('Created a database user'),
  'database_user.deleted': msgid('Deleted a database user'),
  'database_user.postgresql.created': msgid('Created a «PostgreSQL» user'),
  'database_user.postgresql.deleted': msgid('Deleted a database user'),
  'database_user.postgresql.password_changed': msgid('Changed a password'),
  'dns.cleanup': msgid('Cleaned «DNS» records'),
  'dns.cluster.updated': msgid('Updated the «DNS» cluster'),
  'dns.email_auth.batch_provisioned': msgid('Provisioned email authentication'),
  'dns.template.applied': msgid('Applied a «DNS» template'),
  'dns.zone.deleted': msgid('Deleted a «DNS» zone'),
  'dns.zone.saved': msgid('Saved a «DNS» zone'),
  'dns.tools.check_submitted': msgid('Queued «DNS» zone checks'),
  'domain.created': msgid('Created a domain'),
  'domain.custom_config.deleted': msgid('Deleted domain configuration'),
  'domain.custom_config.rollback': msgid('Rolled back domain configuration'),
  'domain.custom_config.updated': msgid('Updated domain configuration'),
  'domain.deleted': msgid('Deleted a domain'),
  'domain.updated': msgid('Updated a domain'),
  'feature_list.created': msgid('Created a feature list'),
  'file.chmod': msgid('Changed file permissions'),
  'file.empty_trash': msgid('Emptied the trash'),
  'file.mkdir': msgid('Created a directory'),
  'file.purge_trash': msgid('Permanently deleted a trashed file'),
  'file.restore': msgid('Restored a file'),
  'file.trash': msgid('Moved a file to trash'),
  'file.write': msgid('Wrote a file'),
  'firewall.rule.created': msgid('Created a firewall rule'),
  'git.repo.created': msgid('Created a «Git» repository'),
  'git.repo.deployed': msgid('Deployed a «Git» repository'),
  'handoff.consumed': msgid('Opened a panel with a one-time sign-in'),
  'handoff.issued': msgid('Issued a one-time panel sign-in'),
  'handoff.refused': msgid('Refused a one-time panel sign-in'),
  'ip.deleted': msgid('Deleted an address'),
  'ip.saved': msgid('Saved an address'),
  'lifecycle.cpanel_import': msgid('Imported from «cPanel»'),
  'lifecycle.transfer': msgid('Started a transfer'),
  'upgrade.start_requested': msgid('Requested an upgrade start'),
  'upgrade.start_accepted': msgid('Upgrade start was accepted'),
  'upgrade.handoff_requested': msgid('Requested an upgrade handoff'),
  'upgrade.handoff_accepted': msgid('Handed an upgrade to the coordinator'),
  'upgrade.handoff_failed': msgid('Upgrade handoff was not confirmed'),
  'upgrade.retirement_pending': msgid('Upgrade awaits lifecycle retirement'),
  'server.notifications.updated': msgid('Updated notification settings'),
  'server.notifications.webhook_key_created': msgid('Created a webhook signing key'),
  'server.notifications.tested': msgid('Sent a test notification'),
  'server.alerts.updated': msgid('Updated alert rules'),
  'server.support.bundle_downloaded': msgid('Downloaded a support bundle'),
  'server.announcement.created': msgid('Published an announcement'),
  'server.announcement.updated': msgid('Updated an announcement'),
  'server.announcement.archived': msgid('Archived an announcement'),
  'account.announcement.dismissed': msgid('Dismissed an announcement'),
  'auth.session_revoked': msgid('Revoked a session'),
  'auth.sessions_revoked_others': msgid('Revoked other sessions'),
  'certificate.candidate_written': msgid('Saved a certificate candidate'),
  'cron.host_run_requested': msgid('Requested a cron job run'),
  'generation.restore_requested': msgid('Requested a configuration restore'),
  'mail.quarantine.agent.change_requested': msgid('Requested a quarantine change'),
  'security.ssh.key.change_requested': msgid('Requested an SSH key change'),
  'server.upgrade.preflight': msgid('Ran upgrade preflight'),
  'server.upgrade.read': msgid('Read upgrade status'),
  'server.upgrade.start': msgid('Requested an upgrade'),
  'webmail.attachment.downloaded': msgid('Downloaded an attachment'),
  'webmail.contact.metadata_written': msgid('Saved contact details'),
  'webmail.draft.saved': msgid('Saved a draft'),
  'mail.caldav_carddav.updated': msgid('Updated calendar and contacts'),
  'mail.delivery_report.logged': msgid('Logged a delivery report'),
  'mail.default_address.updated': msgid('Updated a default address'),
  'mail.autoresponder.updated': msgid('Saved an autoresponder'),
  'mail.autoresponder.deleted': msgid('Deleted an autoresponder'),
  'mail.domain_forwarder.created': msgid('Created a domain forwarder'),
  'mail.domain_forwarder.deleted': msgid('Deleted a domain forwarder'),
  'mail.filter.created': msgid('Created a mail filter'),
  'mail.filter.deleted': msgid('Deleted a mail filter'),
  'mail.forwarder.created': msgid('Created a forwarder'),
  'mail.forwarder.deleted': msgid('Deleted a forwarder'),
  'mail.import_csv': msgid('Imported mail from a «CSV»'),
  'mail.ips.updated': msgid('Updated mail addresses'),
  'mail.mailing_list.created': msgid('Created a mailing list'),
  'mail.mailing_list.deleted': msgid('Deleted a mailing list'),
  'mail.routing.rolled_back': msgid('Restored mail routing after a failed apply'),
  'mail.spam_settings.updated': msgid('Updated spam settings'),
  'mailbox.deleted': msgid('Deleted a mailbox'),
  'plan.created': msgid('Created a plan'),
  'plan.deleted': msgid('Deleted a plan'),
  'plan.updated': msgid('Updated a plan'),
  'rbac.denied': msgid('Denied by a role'),
  'reconcile.applied': msgid('Applied a generation'),
  'reconcile.attention_resolved': msgid('Resolved reconciler attention'),
  'reconcile.failed': msgid('Reconcile failed'),
  'reconcile.recovered': msgid('Recovered a generation'),
  'reconcile.rolled_back': msgid('Rolled back a generation'),
  'reseller.created': msgid('Created a reseller'),
  'reseller.deleted': msgid('Deleted a reseller'),
  'reseller.updated': msgid('Updated a reseller'),
  'restore.completed': msgid('Finished a restore'),
  'server.fine_settings.updated': msgid('Updated fine settings'),
  'server.hostname_change': msgid('Changed the hostname'),
  'server.quota_init': msgid('Initialized quotas'),
  'server.settings.updated': msgid('Updated server settings'),
  'service_user.created': msgid('Created service user'),
  'service_user.deleted': msgid('Deleted service user'),
  'setup.wizard.completed': msgid('Finished the setup wizard'),
  'transfer.completed': msgid('Finished a transfer'),
  'upgrade.failed': msgid('Upgrade failed'),
  'upgrade.recovered': msgid('Recovered an upgrade'),
  'upgrade.recovery_observed': msgid('Observed an upgrade recovery state'),
  'upgrade.refused': msgid('Refused an upgrade'),
  'upgrade.rollback_failed': msgid('Upgrade rollback failed'),
  'upgrade.rolled_back': msgid('Rolled back an upgrade'),
  'upgrade.started': msgid('Started an upgrade'),
  'upgrade.succeeded': msgid('Finished an upgrade'),
  'web_features.directory_privacy.updated': msgid('Updated directory privacy'),
  'web_features.extras.updated': msgid('Updated web extras'),
  'web_features.hotlink_protection.updated': msgid('Updated hotlink protection'),
  'web_features.web_disk.updated': msgid('Updated web disk'),
  'webmail.calendar.share_revoked': msgid('Revoked a calendar share'),
  'webmail.calendar.shared': msgid('Shared a calendar'),
  'webmail.identity.created': msgid('Created a mail identity'),
  'webmail.message.sent': msgid('Sent a message'),
  'webmail.vacation.updated': msgid('Updated a vacation reply'),
  'whmcs.provision.change_package': msgid('«WHMCS» changed an account package'),
  'whmcs.provision.create': msgid('«WHMCS» created an account'),
  'whmcs.provision.refused': msgid('Refused a «WHMCS» call'),
  'whmcs.provision.suspend': msgid('«WHMCS» suspended an account'),
  'whmcs.provision.terminate': msgid('«WHMCS» terminated an account'),
  'whmcs.provision.test': msgid('«WHMCS» tested the connection'),
  'whmcs.provision.unsuspend': msgid('«WHMCS» unsuspended an account'),
  'whmcs.settings.updated': msgid('Updated «WHMCS» settings'),
  'whmcs.token.rotated': msgid('Created a new «WHMCS» API token'),
}

const RECORDED = msgid('Recorded event')

export interface AuditLabelSource {
  actor?: string
  detail?: Record<string, unknown>
}

const peerUid = (source?: AuditLabelSource): string | null => {
  const recorded = source?.detail?.peerUid
  if (typeof recorded === 'number' && Number.isInteger(recorded) && recorded >= 0 && recorded <= 4_294_967_295) return String(recorded)
  const match = /^uid:(\d+)$/.exec(source?.actor?.trim() ?? '')
  return match ? match[1]! : null
}

export const auditActionLabel = (action: string, locale: Locale, source?: AuditLabelSource): string => {
  if (action === 'agent.peer_denied') {
    const uid = peerUid(source)
    const base = translator(locale)(AUDIT_LABELS[action] ?? RECORDED)
    return uid === null ? base : `${base} (uid ${uid})`
  }
  return translator(locale)(AUDIT_LABELS[action] ?? RECORDED)
}

const OPAQUE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mbx[0-9a-f]{8,})$/i

/** A mailbox principal id is not an address. The address is substituted before display. */
export const auditActorLabel = (actor: string): string => {
  const value = actor.trim()
  const body = value.replace(/^user:/i, '')
  return OPAQUE_ID.test(body) && /^mbx/i.test(body) ? '' : value
}

/** A target a person can read. An opaque id contributes nothing. */
export const auditTargetLabel = (target: string, locale: Locale): string => {
  const value = target.trim()
  if (!value) return ''
  const generation = /^generation:(\d+)$/.exec(value)
  if (generation) return translator(locale)('Generation {generation}', { generation: generation[1]! })
  const prefixed = /^(?:principal|service-user|account|mailbox|mbx):(.+)$/i.exec(value)
  const body = (prefixed ? prefixed[1] ?? '' : value).trim()
  if (!body || OPAQUE_ID.test(body) || /^mbx[0-9a-f]/i.test(body)) return ''
  if (prefixed && /^mbx:/i.test(value)) return body.includes('@') ? body : ''
  return prefixed ? body : value
}

/** Sign-in is a sign-in. Other successful rows stay Applied. */
export const auditOutcomeLabel = (action: string, outcome: string, locale: Locale): string => {
  if (outcome === 'denied') return translator(locale)(msgctxt('audit', 'Denied'))
  if (outcome !== 'ok') return translator(locale)(msgctxt('audit', 'Failed'))
  if (action === 'auth.login') return translator(locale)(msgctxt('audit', 'Signed in'))
  if (action === 'auth.logout') return translator(locale)(msgctxt('audit', 'Done'))
  return translator(locale)('Applied')
}

/** Escaped action sentence. Right-to-left locales isolate Latin tokens marked with «». */
export const auditActionHtml = (action: string, locale: Locale, source?: AuditLabelSource): string => {
  const label = auditActionLabel(action, locale, source)
  const rtl = localeDirection(locale) === 'rtl'
  if (rtl && label.includes('«')) {
    return label.split(/«([^»]*)»/).map((part, index) => index % 2 === 1 ? `<bdi dir="ltr">${escapeHtml(part)}</bdi>` : escapeHtml(part)).join('')
  }
  if (rtl && label.includes('(uid ')) {
    return label.split(/(\(uid \d+\))/).map((part, index) => index % 2 === 1 ? `<bdi dir="ltr">${escapeHtml(part)}</bdi>` : escapeHtml(part)).join('')
  }
  return escapeHtml(label)
}
