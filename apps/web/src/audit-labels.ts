import type { Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

/** Human copy for one audit action. The target stays a separate line or column. */
interface AuditCopy {
  en: string
  ar: string
}

const copy = (en: string, ar: string): AuditCopy => ({ en, ar })

/**
 * Every action the panel writes. An unknown code becomes a generic sentence so the
 * raw dotted code never appears in the dashboard or the audit log.
 */
export const AUDIT_LABELS: Readonly<Record<string, AuditCopy>> = {
  'account.contact.updated': copy('Updated an account contact', 'حدّث جهة اتصال حساب'),
  'account.create.configuration_failed': copy('Account creation failed on the host', 'فشل إنشاء الحساب على المضيف'),
  'account.desired.created': copy('Requested an account', 'طلب حساباً'),
  'account.desired.suspended': copy('Requested a suspension', 'طلب إيقاف حساب'),
  'account.desired.unsuspended': copy('Requested an unsuspension', 'طلب إعادة تفعيل حساب'),
  'account.desired.updated': copy('Requested an account update', 'طلب تحديث حساب'),
  'account.owner_changed': copy('Changed an account owner', 'غيّر مالك حساب'),
  'account.password.changed': copy('Changed an account password', 'غيّر كلمة مرور حساب'),
  'account.plan_changed': copy('Changed an account plan', 'غيّر خطة حساب'),
  'account.provisioned': copy('Provisioned an account', 'وفّر حساباً'),
  'account.suspended': copy('Suspended an account', 'أوقف حساباً'),
  'account.suspend.configuration_failed': copy('Account suspension failed on the host', 'فشل إيقاف الحساب على المضيف'),
  'account.terminated': copy('Terminated an account', 'أنهى حساباً'),
  'account.unsuspended': copy('Unsuspended an account', 'أعاد تفعيل حساب'),
  'account.unsuspend.configuration_failed': copy('Account unsuspension failed on the host', 'فشل إعادة تفعيل الحساب على المضيف'),
  'account.update.configuration_failed': copy('Account update failed on the host', 'فشل تحديث الحساب على المضيف'),
  'agent.access_denied': copy('Denied agent access', 'رفض وصول الوكيل'),
  'agent.internal_error': copy('Recorded an agent error', 'سجّل خطأ في الوكيل'),
  'agent.peer_denied': copy('Denied an agent peer', 'رفض نظير الوكيل'),
  'api.internal_error': copy('Recorded an internal error', 'سجّل خطأ داخلياً'),
  'app.installed': copy('Installed an application', 'ثبّت تطبيقاً'),
  'app.staging.cloned': copy('Cloned a staging site', 'استنسخ موقع تجهيز'),
  'app.staging.pushed': copy('Pushed a staging site', 'دفع موقع تجهيز'),
  'auth.2fa_disabled': copy('Disabled two-factor authentication', 'عطّل التحقق بخطوتين'),
  'auth.2fa_enabled': copy('Enabled two-factor authentication', 'فعّل التحقق بخطوتين'),
  'auth.csrf_rejected': copy('Rejected a forged request', 'رفض طلباً مزوراً'),
  'auth.identity_authority_restored': copy('Restored the identity authority', 'استعاد سلطة الهوية'),
  'auth.lockout': copy('Locked sign-in', 'أقفل تسجيل الدخول'),
  'auth.login': copy('Signed in', 'سجّل الدخول'),
  'auth.login_denied_suspended': copy('Refused a suspended sign-in', 'رفض دخول حساب موقوف'),
  'auth.login_failed': copy('Failed sign-in', 'فشل تسجيل الدخول'),
  'auth.login_locked': copy('Refused a locked sign-in', 'رفض دخولاً مقفلاً'),
  'auth.logout': copy('Signed out', 'سجّل الخروج'),
  'auth.mfa_seal_key_loss_recovered': copy('Recovered a lost two-factor seal', 'استعاد ختماً مفقوداً للتحقق'),
  'auth.mfa_seal_key_rotated': copy('Rotated the two-factor seal key', 'دوّر مفتاح ختم التحقق'),
  'auth.origin_rejected': copy('Rejected the request origin', 'رفض أصل الطلب'),
  'auth.password_changed': copy('Changed a password', 'غيّر كلمة المرور'),
  'auth.password_reset': copy('Reset a password', 'أعاد ضبط كلمة المرور'),
  'auth.root_initialized': copy('Initialized the root account', 'هيّأ حساب الجذر'),
  'backup.account.completed': copy('Finished an account backup', 'أكمل نسخ حساب'),
  'backup.destination.created': copy('Created a backup destination', 'أنشأ وجهة نسخ'),
  'backup.schedule.updated': copy('Updated a backup schedule', 'حدّث جدول النسخ'),
  'backup.snapshot.created': copy('Created a backup snapshot', 'أنشأ لقطة نسخ'),
  'branding.updated': copy('Updated branding', 'حدّث الهوية'),
  'cache.updated': copy('Updated the cache', 'حدّث الذاكرة المؤقتة'),
  'certificate.issued': copy('Issued a certificate', 'أصدر شهادة'),
  'cli.reindex': copy('Rebuilt the index', 'أعاد بناء الفهرس'),
  'cluster.node.added': copy('Added a cluster node', 'أضاف عقدة عنقود'),
  'container.created': copy('Created a container', 'أنشأ حاوية'),
  'cpanel.import.completed': copy('Finished a «cPanel» import', 'أكمل استيراد «cPanel»'),
  'database.created': copy('Created a database', 'أنشأ قاعدة بيانات'),
  'database.maintenance.check': copy('Checked a database', 'فحص قاعدة بيانات'),
  'database.maintenance.optimize': copy('Optimized a database', 'حسّن قاعدة بيانات'),
  'database.maintenance.repair': copy('Repaired a database', 'أصلح قاعدة بيانات'),
  'database.mongo.created': copy('Created a «MongoDB» database', 'أنشأ قاعدة «MongoDB»'),
  'database.postgres.created': copy('Created a «PostgreSQL» database', 'أنشأ قاعدة «PostgreSQL»'),
  'database.postgres.user.created': copy('Created a «PostgreSQL» user', 'أنشأ مستخدم «PostgreSQL»'),
  'database.purged': copy('Purged a database', 'مسح قاعدة بيانات'),
  'database.remote_hosts.updated': copy('Updated remote database hosts', 'حدّث مضيفي قواعد البيانات البعيدة'),
  'database.restored': copy('Restored a database', 'استعاد قاعدة بيانات'),
  'database.trashed': copy('Moved a database to trash', 'نقل قاعدة بيانات إلى المحذوفات'),
  'database_user.created': copy('Created a database user', 'أنشأ مستخدم قاعدة بيانات'),
  'database_user.deleted': copy('Deleted a database user', 'حذف مستخدم قاعدة بيانات'),
  'dns.cleanup': copy('Cleaned «DNS» records', 'نظّف سجلات «DNS»'),
  'dns.cluster.updated': copy('Updated the «DNS» cluster', 'حدّث عنقود «DNS»'),
  'dns.email_auth.batch_provisioned': copy('Provisioned email authentication', 'وفّر مصادقة البريد'),
  'dns.template.applied': copy('Applied a «DNS» template', 'طبّق قالب «DNS»'),
  'dns.zone.deleted': copy('Deleted a «DNS» zone', 'حذف منطقة «DNS»'),
  'dns.zone.saved': copy('Saved a «DNS» zone', 'حفظ منطقة «DNS»'),
  'domain.created': copy('Created a domain', 'أنشأ نطاقاً'),
  'domain.custom_config.deleted': copy('Deleted domain configuration', 'حذف إعداد النطاق'),
  'domain.custom_config.rollback': copy('Rolled back domain configuration', 'تراجع عن إعداد النطاق'),
  'domain.custom_config.updated': copy('Updated domain configuration', 'حدّث إعداد النطاق'),
  'domain.deleted': copy('Deleted a domain', 'حذف نطاقاً'),
  'domain.updated': copy('Updated a domain', 'حدّث نطاقاً'),
  'feature_list.created': copy('Created a feature list', 'أنشأ قائمة ميزات'),
  'file.chmod': copy('Changed file permissions', 'غيّر صلاحيات ملف'),
  'file.empty_trash': copy('Emptied the trash', 'أفرغ المحذوفات'),
  'file.mkdir': copy('Created a directory', 'أنشأ دليلاً'),
  'file.restore': copy('Restored a file', 'استعاد ملفاً'),
  'file.trash': copy('Moved a file to trash', 'نقل ملفاً إلى المحذوفات'),
  'file.write': copy('Wrote a file', 'كتب ملفاً'),
  'firewall.rule.created': copy('Created a firewall rule', 'أنشأ قاعدة جدار ناري'),
  'git.repo.created': copy('Created a «Git» repository', 'أنشأ مستودع «Git»'),
  'git.repo.deployed': copy('Deployed a «Git» repository', 'نشر مستودع «Git»'),
  'ip.deleted': copy('Deleted an address', 'حذف عنواناً'),
  'ip.saved': copy('Saved an address', 'حفظ عنواناً'),
  'language.updated': copy('Updated the language', 'حدّث اللغة'),
  'lifecycle.cpanel_import': copy('Imported from «cPanel»', 'استورد من «cPanel»'),
  'lifecycle.transfer': copy('Started a transfer', 'بدأ نقلاً'),
  'lifecycle.upgrade.preflight_failed': copy('Upgrade preflight failed', 'فشل فحص الترقية'),
  'lifecycle.upgrade.started': copy('Started an upgrade', 'بدأ ترقية'),
  'mail.caldav_carddav.updated': copy('Updated calendar and contacts', 'حدّث التقويم وجهات الاتصال'),
  'mail.delivery_report.logged': copy('Logged a delivery report', 'سجّل تقرير تسليم'),
  'mail.domain_forwarder.created': copy('Created a domain forwarder', 'أنشأ محوّل نطاق'),
  'mail.domain_forwarder.deleted': copy('Deleted a domain forwarder', 'حذف محوّل نطاق'),
  'mail.filter.created': copy('Created a mail filter', 'أنشأ مرشح بريد'),
  'mail.filter.deleted': copy('Deleted a mail filter', 'حذف مرشح بريد'),
  'mail.forwarder.created': copy('Created a forwarder', 'أنشأ محوّلاً'),
  'mail.forwarder.deleted': copy('Deleted a forwarder', 'حذف محوّلاً'),
  'mail.import_csv': copy('Imported mail from a «CSV»', 'استورد بريداً من «CSV»'),
  'mail.ips.updated': copy('Updated mail addresses', 'حدّث عناوين البريد'),
  'mail.mailing_list.created': copy('Created a mailing list', 'أنشأ قائمة بريدية'),
  'mail.mailing_list.deleted': copy('Deleted a mailing list', 'حذف قائمة بريدية'),
  'mail.spam_settings.updated': copy('Updated spam settings', 'حدّث إعدادات البريد المزعج'),
  'plan.created': copy('Created a plan', 'أنشأ خطة'),
  'plan.deleted': copy('Deleted a plan', 'حذف خطة'),
  'plan.updated': copy('Updated a plan', 'حدّث خطة'),
  'rbac.denied': copy('Denied by a role', 'رفضه الدور'),
  'reconcile.applied': copy('Applied a generation', 'طبّق جيلاً'),
  'reconcile.attention_resolved': copy('Resolved reconciler attention', 'حل تنبيه الموفّق'),
  'reconcile.failed': copy('Reconcile failed', 'فشل التوفيق'),
  'reconcile.recovered': copy('Recovered a generation', 'استعاد جيلاً'),
  'reconcile.rolled_back': copy('Rolled back a generation', 'تراجع عن جيل'),
  'reseller.created': copy('Created a reseller', 'أنشأ موزعاً'),
  'reseller.deleted': copy('Deleted a reseller', 'حذف موزعاً'),
  'reseller.updated': copy('Updated a reseller', 'حدّث موزعاً'),
  'restore.completed': copy('Finished a restore', 'أكمل استعادة'),
  'server.fine_settings.updated': copy('Updated fine settings', 'حدّث الإعدادات الدقيقة'),
  'server.hostname_change': copy('Changed the hostname', 'غيّر اسم المضيف'),
  'server.quota_init': copy('Initialized quotas', 'هيّأ الحصص'),
  'server.settings.updated': copy('Updated server settings', 'حدّث إعدادات الخادم'),
  'service_user.created': copy('Created service user', 'أنشأ مستخدم خدمة'),
  'service_user.deleted': copy('Deleted service user', 'حذف مستخدم خدمة'),
  'setup.wizard.completed': copy('Finished the setup wizard', 'أكمل معالج الإعداد'),
  'shell.exec': copy('Ran a shell command', 'نفّذ أمراً في الصدفة'),
  'transfer.completed': copy('Finished a transfer', 'أكمل نقلاً'),
  'upgrade.failed': copy('Upgrade failed', 'فشلت الترقية'),
  'upgrade.recovered': copy('Recovered an upgrade', 'استعاد ترقية'),
  'upgrade.refused': copy('Refused an upgrade', 'رفض ترقية'),
  'upgrade.rollback_failed': copy('Upgrade rollback failed', 'فشل التراجع عن الترقية'),
  'upgrade.rolled_back': copy('Rolled back an upgrade', 'تراجع عن ترقية'),
  'upgrade.started': copy('Started an upgrade', 'بدأ ترقية'),
  'upgrade.succeeded': copy('Finished an upgrade', 'أكمل ترقية'),
  'web_features.directory_privacy.updated': copy('Updated directory privacy', 'حدّث خصوصية دليل'),
  'web_features.extras.updated': copy('Updated web extras', 'حدّث إضافات الويب'),
  'web_features.hotlink_protection.updated': copy('Updated hotlink protection', 'حدّث حماية الروابط المباشرة'),
  'web_features.web_disk.updated': copy('Updated web disk', 'حدّث قرص الويب'),
  'webmail.calendar.share_revoked': copy('Revoked a calendar share', 'ألغى مشاركة تقويم'),
  'webmail.calendar.shared': copy('Shared a calendar', 'شارك تقويماً'),
  'webmail.identity.created': copy('Created a mail identity', 'أنشأ هوية بريد'),
  'webmail.message.sent': copy('Sent a message', 'أرسل رسالة'),
  'webmail.vacation.updated': copy('Updated a vacation reply', 'حدّث رد الإجازة'),
  'whmcs.updated': copy('Updated «WHMCS» settings', 'حدّث إعدادات «WHMCS»'),
}

const RECORDED: AuditCopy = copy('Recorded event', 'حدث مسجّل')

export const auditActionLabel = (action: string, locale: Locale): string => {
  const row = AUDIT_LABELS[action] ?? RECORDED
  return locale === 'ar' ? row.ar : row.en
}

const internalRecord = (locale: Locale): string => locale === 'ar' ? 'سجل داخلي' : 'An internal record'
const mailboxRecord = (locale: Locale): string => locale === 'ar' ? 'صندوق بريد' : 'Mailbox'

/** A target a person can read. Raw principal, generation, and mailbox ids stay off the row. */
export const auditTargetLabel = (target: string, locale: Locale): string => {
  const value = target.trim()
  const generation = /^generation:(\d+)$/.exec(value)
  if (generation) return locale === 'ar' ? `الجيل ${generation[1]}` : `Generation ${generation[1]}`
  const serviceUser = /^service-user:(.+)$/.exec(value)
  if (serviceUser) {
    const login = serviceUser[1] ?? ''
    if (login.length > 0 && !/^mbx/i.test(login) && !/^[0-9a-f-]{32,}$/i.test(login)) return login
    return mailboxRecord(locale)
  }
  if (/^(principal|mbx):/i.test(value) || /\bmbx[0-9a-f]/i.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) {
    return /mbx|mailbox/i.test(value) ? mailboxRecord(locale) : internalRecord(locale)
  }
  return value
}

/** Sign-in is a sign-in. Other successful rows stay Applied. */
export const auditOutcomeLabel = (action: string, outcome: string, locale: Locale): string => {
  if (outcome === 'denied') return locale === 'ar' ? 'مرفوض' : 'Denied'
  if (outcome !== 'ok') return locale === 'ar' ? 'فشل' : 'Failed'
  if (action === 'auth.login') return locale === 'ar' ? 'دخول' : 'Signed in'
  return locale === 'ar' ? 'مطبّق' : 'Applied'
}

/** Escaped action sentence. Arabic isolates Latin tokens marked with «». */
export const auditActionHtml = (action: string, locale: Locale): string => {
  const label = auditActionLabel(action, locale)
  if (locale === 'ar' && label.includes('«')) {
    return label.split(/«([^»]*)»/).map((part, index) => index % 2 === 1 ? `<bdi dir="ltr">${escapeHtml(part)}</bdi>` : escapeHtml(part)).join('')
  }
  return escapeHtml(label)
}
