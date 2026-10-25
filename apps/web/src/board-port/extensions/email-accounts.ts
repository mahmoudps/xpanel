import type { Account, Domain, Plan, Principal, ServiceUser } from '@xpanel/core'
import type { Locale } from '../../i18n.ts'
import { escapeHtml } from '../../tokens.ts'
import { extensionCard, extensionCollection, extensionFact, extensionFrame, extensionText, type ExtensionRouteSpec, type ReadCollection } from './shared.ts'

export const emailAccountsRouteSpec: ExtensionRouteSpec = {
  route: '/email/accounts', surface: 'xpanel', roles: ['owner'],
  tools: ['email-accounts', 'email-account-create', 'email-account-manage'],
  title: ['Email accounts', 'حسابات البريد'],
}

export interface EmailAccountsExtensionInput {
  locale: Locale
  principal: Principal
  account: Pick<Account, 'id' | 'planId' | 'username' | 'primaryDomain' | 'status'>
  plan?: Pick<Plan, 'id' | 'name' | 'caps' | 'defaultMailboxQuotaMb'>
  domains?: ReadCollection<Pick<Domain, 'id' | 'accountId' | 'name'>>
  users?: ReadCollection<ServiceUser>
  /** Mutation controls require the existing route and action qualification. */
  mutationsQualified?: boolean
}

const dialogs = (locale: Locale): string => ['password', 'quota'].map(kind => {
  const password = kind === 'password'
  const title = password ? ['New mailbox password', 'كلمة مرور صندوق البريد الجديدة'] as const : ['Mailbox quota (MB)', 'حصة صندوق البريد (MB)'] as const
  return `<dialog class="xp-account-dialog" data-mailbox-${kind}-dialog aria-labelledby="extension-${kind}-title"><form method="dialog"><div class="xp-account-dialog__header"><h2 id="extension-${kind}-title">${extensionText(locale, title)}</h2></div><div class="xp-field"><label for="extension-${kind}-next">${extensionText(locale, title)}</label><input id="extension-${kind}-next" class="xp-input" name="${password ? 'password' : 'mailboxQuotaMb'}" type="${password ? 'password' : 'number'}" ${password ? 'minlength="8" autocomplete="new-password"' : 'min="1" step="1"'} required></div><p data-dialog-status role="status" hidden></p><div class="xp-account-dialog__footer"><button type="button" class="xp-btn" data-dialog-cancel>${extensionText(locale, ['Cancel', 'إلغاء'])}</button><button type="submit" class="xp-btn xp-btn--primary">${extensionText(locale, ['Save', 'حفظ'])}</button></div></form></dialog>`
}).join('')

/** Body-only renderer; the existing shell and client own navigation and mutations. */
export const renderEmailAccountsExtension = (input: EmailAccountsExtensionInput): string => {
  const { locale, account, principal } = input
  if (principal.kind !== 'user' || principal.accountId !== account.id || account.status !== 'active') return ''
  const plan = input.plan?.id === account.planId ? input.plan : undefined
  const users = input.users?.state === 'read' ? { state: 'read' as const, items: input.users.items.filter(user => user.accountId === account.id) } : undefined
  const domains = input.domains?.state === 'read' ? input.domains.items.filter(domain => domain.accountId === account.id) : []
  const canManage = input.mutationsQualified === true
  const stats = extensionCard(locale, ['Account and plan', 'الحساب والخطة'], `<dl class="xp-extension__facts">${extensionFact(locale, ['Account', 'الحساب'], account.username, true)}${extensionFact(locale, ['Primary domain', 'النطاق الرئيسي'], account.primaryDomain, true)}${extensionFact(locale, ['Plan', 'الخطة'], plan?.name)}${extensionFact(locale, ['Mailboxes', 'صناديق البريد'], users ? String(users.items.filter(user => user.services.email).length) : undefined, true)}${extensionFact(locale, ['Mailbox limit', 'حد صناديق البريد'], plan ? String(plan.caps.mailboxes) : undefined, true)}</dl>`)
  const list = extensionCard(locale, ['Service users', 'مستخدمو الخدمة'], extensionCollection(locale, users, ['No service users were returned.', 'لم تُرجع القراءة أي مستخدم خدمة.'], user => {
    const services = [user.services.email ? extensionText(locale, ['Email', 'البريد']) : '', user.services.ftp ? 'FTP' : '', user.services.webdisk ? 'Web Disk' : ''].filter(Boolean).join(' / ')
    return `<dl class="xp-extension__facts">${extensionFact(locale, ['Login', 'اسم الدخول'], user.login, true)}${extensionFact(locale, ['Services', 'الخدمات'], services)}${extensionFact(locale, ['Mailbox quota (MB)', 'حصة صندوق البريد (MB)'], user.services.email ? String(user.mailboxQuotaMb) : undefined, true)}${extensionFact(locale, ['File directory', 'مجلد الملفات'], user.services.ftp || user.services.webdisk ? user.ftpDir : undefined, true)}${extensionFact(locale, ['Last sign-in', 'آخر دخول'], undefined)}</dl>${canManage && user.services.email ? `<div class="xp-extension__actions"><button type="button" class="xp-btn" data-mailbox-password="${escapeHtml(user.id)}">${extensionText(locale, ['Password', 'كلمة المرور'])}</button>${user.services.email ? `<button type="button" class="xp-btn" data-mailbox-quota="${escapeHtml(user.id)}"${typeof user.mailboxQuotaMb === 'number' ? ` data-mailbox-quota-value="${user.mailboxQuotaMb}"` : ''}>${extensionText(locale, ['Quota', 'الحصة'])}</button>` : ''}<button type="button" class="xp-btn" data-remove-mailbox="${escapeHtml(user.id)}">${extensionText(locale, ['Delete', 'حذف'])}</button></div>` : ''}`
  }))
  const quota = typeof plan?.defaultMailboxQuotaMb === 'number' ? plan.defaultMailboxQuotaMb : 1024
  const form = canManage ? extensionCard(locale, ['Create mailbox', 'إنشاء صندوق بريد'], `<p>${extensionText(locale, ['Creates an email mailbox using the existing account service. FTP and Web Disk creation are not configured here.', 'ينشئ صندوق بريد باستخدام خدمة الحساب الحالية. إنشاء FTP وWeb Disk غير متاح هنا.'])}</p><form class="xp-form-group" data-mailbox-form="true"><div class="xp-field"><label for="mailbox-local">${extensionText(locale, ['Local name', 'الاسم المحلي'])}</label><input id="mailbox-local" class="xp-input" name="localPart" dir="ltr" required pattern="[a-z0-9][a-z0-9._-]{0,31}" maxlength="32" autocomplete="off"></div><div class="xp-field"><label for="mailbox-domain">${extensionText(locale, ['Domain', 'النطاق'])}</label><select id="mailbox-domain" class="xp-select" name="domainId" required${domains.length ? '' : ' disabled'}>${domains.map(domain => `<option value="${escapeHtml(domain.id)}">${escapeHtml(domain.name)}</option>`).join('')}</select></div><div class="xp-field"><label for="mailbox-password">${extensionText(locale, ['Password', 'كلمة المرور'])}</label><input id="mailbox-password" class="xp-input" name="password" type="password" required minlength="8" autocomplete="new-password"><button type="button" class="xp-btn" data-password-generate data-password-target="mailbox-password"${domains.length ? '' : ' disabled'}>${extensionText(locale, ['Generate password', 'توليد كلمة مرور'])}</button></div><div class="xp-field"><label for="mailbox-quota">${extensionText(locale, ['Requested quota (MB)', 'الحصة المطلوبة (MB)'])}</label><input id="mailbox-quota" class="xp-input" name="mailboxQuotaMb" type="number" min="1" step="1" required value="${quota}"></div>${domains.length ? '' : `<p>${extensionText(locale, ['No authorized domain was read. Creation is unavailable.', 'لم يُقرأ نطاق مصرح به. الإنشاء غير متاح.'])}</p>`}<p data-mailbox-status role="status" hidden></p><button type="submit" class="xp-btn xp-btn--primary"${domains.length ? '' : ' disabled'}>${extensionText(locale, ['Create mailbox', 'إنشاء صندوق بريد'])}</button></form>${dialogs(locale)}`) : ''
  return extensionFrame(locale, emailAccountsRouteSpec.title, `${stats}${list}${form}${extensionCard(locale, ['Connection information', 'معلومات الاتصال'], `<p>${extensionText(locale, ['Connection hosts, ports, mailbox usage and delivery health were not read.', 'لم تُقرأ مضيفات الاتصال أو المنافذ أو استخدام البريد أو حالة التسليم.'])}</p>`)}`)
}
