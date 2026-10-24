import type { Account, Domain, Plan, Principal, ServiceUser } from '@xpanel/core'
import type { Locale } from '../../i18n.ts'
import { extensionCard, extensionCollection, extensionDisabled, extensionFact, extensionFrame, extensionText, type ExtensionRouteSpec, type ReadCollection } from './shared.ts'

export const accountPageRouteSpecs: readonly ExtensionRouteSpec[] = [
  { route: '/email/forwarders', surface: 'xpanel', roles: ['owner'], tools: ['forwarders', 'domain-forwarders', 'default-address', 'autoresponders'], title: ['Forwarders', 'إعادة توجيه البريد'] },
  { route: '/email/deliverability', surface: 'xpanel', roles: ['owner'], tools: ['email-deliverability', 'email-routing'], title: ['Deliverability', 'تسليم البريد'] },
  { route: '/email/filters', surface: 'xpanel', roles: ['owner'], tools: ['global-email-filters', 'email-filters', 'connect-devices', 'email-disk-usage', 'address-importer'], title: ['Email filters', 'مرشحات البريد'] },
  { route: '/email/spam-filters', surface: 'xpanel', roles: ['owner'], tools: ['spam-filters', 'greylisting', 'sender-verification'], title: ['Spam filters', 'مرشحات الرسائل المزعجة'] },
  { route: '/email/spam-quarantine', surface: 'xpanel', roles: ['owner'], tools: ['spam-quarantine'], title: ['Spam quarantine', 'حجر الرسائل المزعجة'] },
  { route: '/email/mailing-lists', surface: 'xpanel', roles: ['owner'], tools: ['mailing-lists'], title: ['Mailing lists', 'القوائم البريدية'] },
  { route: '/email/archive', surface: 'xpanel', roles: ['owner'], tools: ['email-archive'], title: ['Email archive', 'أرشيف البريد'] },
  { route: '/email/encryption', surface: 'xpanel', roles: ['owner'], tools: ['email-encryption'], title: ['Email encryption', 'تشفير البريد'] },
  { route: '/email/calendars-contacts', surface: 'xpanel', roles: ['owner'], tools: ['calendars-contacts-management', 'calendars-contacts-sharing', 'calendars-contacts-config'], title: ['Calendars and contacts', 'التقويمات وجهات الاتصال'] },
  { route: '/preferences', surface: 'xpanel', roles: ['owner'], tools: ['account-preferences', 'change-style'], title: ['Account preferences', 'تفضيلات الحساب'] },
  { route: '/preferences/language', surface: 'xpanel', roles: ['owner'], tools: ['change-language'], title: ['Language', 'اللغة'] },
  { route: '/preferences/users', surface: 'xpanel', roles: ['owner'], tools: ['user-manager'], title: ['Service users', 'مستخدمو الخدمة'] },
  { route: '/preferences/team', surface: 'xpanel', roles: ['owner'], tools: ['manage-team'], title: ['Account team', 'فريق الحساب'] },
  { route: '/health', surface: 'xpanel', roles: ['owner'], tools: ['account-health-overview'], title: ['Site health', 'صحة الموقع'] },
]

/** Entries come from a route-specific authorized read, never from mailbox count. */
export interface AccountCollectionEntry {
  name: string
  address?: string
  destination?: string
}

export interface AccountPagesExtensionInput {
  locale: Locale
  route: string
  principal: Principal
  account: Pick<Account, 'id' | 'planId' | 'status' | 'contactEmail'>
  plan?: Pick<Plan, 'id' | 'caps'>
  theme?: 'light' | 'dark'
  domains?: ReadCollection<Pick<Domain, 'accountId' | 'name'>>
  users?: ReadCollection<Pick<ServiceUser, 'accountId' | 'login' | 'services'>>
  collections?: Readonly<Partial<Record<string, ReadCollection<AccountCollectionEntry>>>>
}

const entries = (locale: Locale, value: ReadCollection<AccountCollectionEntry> | undefined): string => extensionCollection(locale, value,
  ['The read returned no records.', 'لم تُرجع القراءة أي سجلات.'], item => `<dl class="xp-extension__facts">${extensionFact(locale, ['Name', 'الاسم'], item.name)}${extensionFact(locale, ['Address', 'العنوان'], item.address, true)}${extensionFact(locale, ['Destination', 'الوجهة'], item.destination, true)}</dl>`)

export const renderAccountPagesExtension = (input: AccountPagesExtensionInput): string => {
  const { locale, account, principal, route } = input
  const spec = accountPageRouteSpecs.find(item => item.route === route)
  if (!spec || principal.kind !== 'user' || principal.accountId !== account.id || account.status !== 'active') return ''
  const plan = input.plan?.id === account.planId ? input.plan : undefined
  let body: string
  if (route === '/preferences') {
    body = `<dl class="xp-extension__facts">${extensionFact(locale, ['Contact email', 'بريد التواصل'], account.contactEmail || extensionText(locale, ['Not set', 'غير محدد']), account.contactEmail.length > 0)}${extensionFact(locale, ['Appearance', 'المظهر'], input.theme === undefined ? undefined : extensionText(locale, input.theme === 'dark' ? ['Dark', 'داكن'] : ['Light', 'فاتح']))}</dl>${extensionDisabled(locale, ['Save preferences', 'حفظ التفضيلات'])}`
  } else if (route === '/preferences/language') {
    body = `<dl class="xp-extension__facts">${extensionFact(locale, ['Current language', 'اللغة الحالية'], locale === 'ar' ? 'العربية' : 'English')}${extensionFact(locale, ['Digits', 'الأرقام'], '0-9', true)}</dl><p>${extensionText(locale, ['Use the workspace language control to change the interface language.', 'استخدم عنصر اللغة في مساحة العمل لتغيير لغة الواجهة.'])}</p>`
  } else if (route === '/preferences/users') {
    const users = input.users?.state === 'read' ? { state: 'read' as const, items: input.users.items.filter(user => user.accountId === account.id) } : undefined
    body = extensionCollection(locale, users, ['The read returned no service users.', 'لم تُرجع القراءة أي مستخدم خدمة.'], user => `<dl class="xp-extension__facts">${extensionFact(locale, ['Login', 'اسم الدخول'], user.login, true)}${extensionFact(locale, ['Email enabled', 'البريد مفعّل'], extensionText(locale, user.services.email ? ['Yes', 'نعم'] : ['No', 'لا']))}</dl>`)
  } else if (route === '/health' || route === '/email/deliverability') {
    const domains = input.domains?.state === 'read' ? { state: 'read' as const, items: input.domains.items.filter(domain => domain.accountId === account.id) } : undefined
    body = `<p data-check-state="unread">${extensionText(locale, ['Service check results have not been read. Domain records do not establish DNS, TLS, SMTP or delivery health.', 'لم تُقرأ نتائج فحوص الخدمات. سجلات النطاقات لا تثبت صحة DNS أو TLS أو SMTP أو تسليم البريد.'])}</p>${extensionCollection(locale, domains, ['The read returned no domains.', 'لم تُرجع القراءة أي نطاق.'], domain => `<dl class="xp-extension__facts">${extensionFact(locale, ['Domain', 'النطاق'], domain.name, true)}${extensionFact(locale, ['SPF / DKIM / DMARC', 'SPF / DKIM / DMARC'], extensionText(locale, ['Not read', 'لم تُقرأ البيانات']))}${extensionFact(locale, ['Service health', 'صحة الخدمة'], extensionText(locale, ['Not read', 'لم تُقرأ البيانات']))}</dl>`)}${extensionDisabled(locale, ['Run checks', 'تشغيل الفحوص'])}`
  } else {
    const cap = route === '/email/forwarders' ? plan?.caps.forwarders : route === '/email/mailing-lists' ? plan?.caps.mailingLists : undefined
    body = `${route === '/email/forwarders' || route === '/email/mailing-lists' ? `<dl class="xp-extension__facts">${extensionFact(locale, ['Plan limit', 'حد الخطة'], cap === undefined ? undefined : String(cap), true)}</dl>` : ''}${entries(locale, input.collections?.[route])}${extensionDisabled(locale, ['Manage records', 'إدارة السجلات'])}`
  }
  return extensionFrame(locale, spec.title, extensionCard(locale, spec.title, body))
}
