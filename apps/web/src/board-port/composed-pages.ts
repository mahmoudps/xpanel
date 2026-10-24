import type { Account, Domain, Limit, Plan, ServiceUser } from '@xpanel/core'
import { escapeHtml } from '../tokens.ts'

type Locale = 'en' | 'ar'

export const COMPOSED_ROUTES = [
  '/email/forwarders',
  '/email/deliverability',
  '/email/filters',
  '/email/spam-filters',
  '/email/spam-quarantine',
  '/email/mailing-lists',
  '/email/archive',
  '/email/encryption',
  '/email/calendars-contacts',
  '/preferences',
  '/preferences/language',
  '/preferences/users',
  '/preferences/team',
  '/health',
] as const

export type ComposedRoute = (typeof COMPOSED_ROUTES)[number]

export const isComposedRoute = (route: string): route is ComposedRoute =>
  (COMPOSED_ROUTES as readonly string[]).includes(route)

interface PageCopy {
  group: [string, string]
  title: [string, string]
  lede: [string, string]
  action: [string, string]
}

const COPY: Record<ComposedRoute, PageCopy> = {
  '/email/forwarders': {
    group: ['Email', 'البريد'],
    title: ['Forwarders', 'إعادة التوجيه'],
    lede: ['Address and domain forwarders for this account.', 'إعادة توجيه العناوين والنطاقات لهذا الحساب.'],
    action: ['Add forwarder', 'أضف إعادة توجيه'],
  },
  '/email/deliverability': {
    group: ['Email', 'البريد'],
    title: ['Deliverability', 'وصول البريد'],
    lede: ['Authentication records for each domain on this account.', 'سجلات توثيق البريد لكل نطاق على هذا الحساب.'],
    action: ['Check records', 'افحص السجلات'],
  },
  '/email/filters': {
    group: ['Email', 'البريد'],
    title: ['Email filters', 'مرشحات البريد'],
    lede: ['Rules that sort mail for the mailboxes on this account.', 'قواعد تفرز البريد لصناديق هذا الحساب.'],
    action: ['Create filter', 'أنشئ مرشحًا'],
  },
  '/email/spam-filters': {
    group: ['Email', 'البريد'],
    title: ['Spam filters', 'مرشحات الرسائل المزعجة'],
    lede: ['Spam policy for this account.', 'سياسة الرسائل المزعجة لهذا الحساب.'],
    action: ['Save', 'حفظ'],
  },
  '/email/spam-quarantine': {
    group: ['Email', 'البريد'],
    title: ['Spam quarantine', 'حجر الرسائل المزعجة'],
    lede: ['Messages held before delivery.', 'رسائل أُوقفت قبل التسليم.'],
    action: ['Release', 'تحرير'],
  },
  '/email/mailing-lists': {
    group: ['Email', 'البريد'],
    title: ['Mailing lists', 'القوائم البريدية'],
    lede: ['Discussion and announcement lists on this account.', 'قوائم النقاش والإعلان على هذا الحساب.'],
    action: ['Create list', 'أنشئ قائمة'],
  },
  '/email/archive': {
    group: ['Email', 'البريد'],
    title: ['Archive', 'الأرشيف'],
    lede: ['Stored copies of mail for this account.', 'نسخ محفوظة من بريد هذا الحساب.'],
    action: ['Search archive', 'ابحث في الأرشيف'],
  },
  '/email/encryption': {
    group: ['Email', 'البريد'],
    title: ['Encryption', 'التشفير'],
    lede: ['Mailbox encryption for this account.', 'تشفير صناديق البريد لهذا الحساب.'],
    action: ['Add key', 'أضف مفتاحًا'],
  },
  '/email/calendars-contacts': {
    group: ['Email', 'البريد'],
    title: ['Calendars and contacts', 'التقويمات وجهات الاتصال'],
    lede: ['Calendars and address books for this account.', 'التقويمات ودفاتر العناوين لهذا الحساب.'],
    action: ['Add calendar', 'أضف تقويمًا'],
  },
  '/preferences': {
    group: ['Preferences', 'التفضيلات'],
    title: ['Account preferences', 'تفضيلات الحساب'],
    lede: ['Contact address and the appearance already chosen for this session.', 'عنوان التواصل والمظهر المختار لهذه الجلسة.'],
    action: ['Save', 'حفظ'],
  },
  '/preferences/language': {
    group: ['Preferences', 'التفضيلات'],
    title: ['Language', 'اللغة'],
    lede: ['The interface language for this session.', 'لغة الواجهة لهذه الجلسة.'],
    action: ['Save', 'حفظ'],
  },
  '/preferences/users': {
    group: ['Preferences', 'التفضيلات'],
    title: ['User manager', 'مستخدمو الخدمة'],
    lede: ['Logins for email, FTP and web disk. They do not open the panel.', 'حسابات البريد ونقل الملفات وقرص الويب. لا تفتح اللوحة.'],
    action: ['Add user', 'أضف مستخدمًا'],
  },
  '/preferences/team': {
    group: ['Preferences', 'التفضيلات'],
    title: ['Manage team', 'فريق الحساب'],
    lede: ['People who can open this panel for the account.', 'أشخاص يمكنهم فتح هذه اللوحة للحساب.'],
    action: ['Add team user', 'أضف فردًا'],
  },
  '/health': {
    group: ['Account', 'الحساب'],
    title: ['Site health', 'صحة الموقع'],
    lede: ['The account state, and the sites that have not been checked from here yet.', 'حالة الحساب، والمواقع التي لم تُفحص من هنا بعد.'],
    action: ['Check again', 'أعد الفحص'],
  },
}

const text = (locale: Locale, pair: [string, string]): string => pair[locale === 'ar' ? 1 : 0]

const capText = (locale: Locale, value: Limit | undefined): string => {
  if (value === undefined) return '—'
  if (value === 'unlimited') return locale === 'ar' ? 'غير محدود' : 'Unlimited'
  return String(value)
}

const card = (body: string): string =>
  `<section class="xp-card" style="display: flex; flex-direction: column; gap: 16px">${body}</section>`

const soon = (locale: Locale): string =>
  `<p style="margin: 0; font-size: 14px; line-height: 1.6; color: #475467">${locale === 'ar' ? 'هذه الأداة غير مربوطة بعد. لا توجد صفوف لعرضها.' : 'This tool is not connected yet. There are no rows to show.'}</p>`

const disabledAction = (locale: Locale, label: [string, string]): string =>
  `<button type="button" disabled style="align-self: flex-start; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #E2E6EC; background: #F0F2F5; color: #5D6B7E; font-family: inherit; font-size: 14px; font-weight: 600">${text(locale, label)}</button>`

const table = (heads: string[], rows: string): string =>
  `<div style="overflow-x: auto"><table style="width: 100%; border-collapse: collapse; font-size: 14px"><thead><tr>${heads.map(head => `<th scope="col" style="text-align: start; padding: 10px 12px; border-bottom: 1px solid #E2E6EC; color: #5D6B7E; font-size: 12.5px; font-weight: 600">${head}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`

const cell = (value: string, mono = false): string =>
  `<td style="padding: 12px; border-bottom: 1px solid #E2E6EC; ${mono ? "font-family: 'IBM Plex Mono', monospace;" : ''}">${value}</td>`

const emptyRow = (locale: Locale, span: number): string =>
  `<tr><td colspan="${span}" style="padding: 16px 12px; color: #475467">${locale === 'ar' ? 'لا توجد صفوف.' : 'No rows.'}</td></tr>`

const fact = (label: string, value: string): string =>
  `<div style="display: flex; justify-content: space-between; gap: 16px; min-height: 44px; align-items: center; border-bottom: 1px solid #E2E6EC"><span style="color: #5D6B7E; font-size: 13px; font-weight: 600">${label}</span><span>${value}</span></div>`

export interface ComposedPageProps {
  locale?: Locale
  route: string
  account: Account
  plan?: Plan
  domains?: readonly Domain[]
  serviceUsers?: readonly ServiceUser[]
  theme?: 'light' | 'dark'
}

export const renderComposedPage = (props: ComposedPageProps): string => {
  if (!isComposedRoute(props.route)) return ''
  const locale: Locale = props.locale === 'ar' ? 'ar' : 'en'
  const copy = COPY[props.route]
  const plan = props.plan && props.plan.id === props.account.planId ? props.plan : undefined
  const domains = props.domains ?? []
  const users = props.serviceUsers ?? []
  const mailboxes = users.filter(user => user.services.email)
  const dash = '—'
  const mono = (value: string): string => `<bdi dir="ltr" style="font-family: 'IBM Plex Mono', monospace">${escapeHtml(value)}</bdi>`
  let state: 'live' | 'partial' | 'empty' = 'empty'
  let body = ''

  if (props.route === '/email/forwarders') {
    state = 'partial'
    body = card(`${fact(locale === 'ar' ? 'حد الخطة' : 'Plan limit', escapeHtml(capText(locale, plan?.caps.forwarders)))}${soon(locale)}${table(
      locale === 'ar' ? ['العنوان', 'الوجهة'] : ['Address', 'Destination'],
      emptyRow(locale, 2),
    )}${disabledAction(locale, copy.action)}`)
  } else if (props.route === '/email/deliverability') {
    state = domains.length ? 'partial' : 'empty'
    const rows = domains.length
      ? domains.map(domain => `<tr>${cell(mono(domain.name), true)}${cell(dash)}${cell(dash)}${cell(locale === 'ar' ? 'لم يُفحص' : 'Not checked')}</tr>`).join('')
      : emptyRow(locale, 4)
    body = card(`${soon(locale)}${table(locale === 'ar' ? ['النطاق', 'SPF', 'DKIM', 'الحالة'] : ['Domain', 'SPF', 'DKIM', 'Status'], rows)}${disabledAction(locale, copy.action)}`)
  } else if (props.route === '/email/filters' || props.route === '/email/spam-filters' || props.route === '/email/encryption' || props.route === '/email/calendars-contacts') {
    state = mailboxes.length ? 'partial' : 'empty'
    const rows = mailboxes.length
      ? mailboxes.map(user => `<tr>${cell(mono(user.login), true)}${cell(locale === 'ar' ? 'لا توجد قواعد' : 'No rules')}</tr>`).join('')
      : emptyRow(locale, 2)
    body = card(`${soon(locale)}${table(locale === 'ar' ? ['صندوق البريد', 'القواعد'] : ['Mailbox', 'Rules'], rows)}${disabledAction(locale, copy.action)}`)
  } else if (props.route === '/email/spam-quarantine' || props.route === '/email/archive') {
    body = card(`${soon(locale)}${table(locale === 'ar' ? ['الرسالة', 'التاريخ'] : ['Message', 'Date'], emptyRow(locale, 2))}${disabledAction(locale, copy.action)}`)
  } else if (props.route === '/email/mailing-lists') {
    state = 'partial'
    body = card(`${fact(locale === 'ar' ? 'حد الخطة' : 'Plan limit', escapeHtml(capText(locale, plan?.caps.mailingLists)))}${soon(locale)}${table(
      locale === 'ar' ? ['القائمة', 'المشتركون'] : ['List', 'Subscribers'],
      emptyRow(locale, 2),
    )}${disabledAction(locale, copy.action)}`)
  } else if (props.route === '/preferences') {
    state = 'partial'
    const themeLabel = props.theme === 'light'
      ? (locale === 'ar' ? 'فاتح' : 'Light')
      : (locale === 'ar' ? 'داكن' : 'Dark')
    body = card(`${fact(locale === 'ar' ? 'بريد التواصل' : 'Contact email', props.account.contactEmail ? mono(props.account.contactEmail) : dash)}${fact(locale === 'ar' ? 'المظهر' : 'Appearance', escapeHtml(themeLabel))}<p style="margin: 0; font-size: 14px; line-height: 1.6; color: #475467">${locale === 'ar' ? 'حفظ عنوان التواصل من هذه الصفحة غير مربوط بعد.' : 'Saving the contact address from this page is not connected yet.'}</p>${disabledAction(locale, copy.action)}`)
  } else if (props.route === '/preferences/language') {
    state = 'live'
    const current = locale === 'ar' ? 'العربية' : 'English'
    body = card(`${fact(locale === 'ar' ? 'اللغة الحالية' : 'Current language', escapeHtml(current))}<div style="display: flex; gap: 8px; flex-wrap: wrap"><a href="?lang=en" lang="en" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid ${locale === 'en' ? '#1D5BD6' : '#D0D5DD'}; color: #101828; text-decoration: none">English</a><a href="?lang=ar" lang="ar" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid ${locale === 'ar' ? '#1D5BD6' : '#D0D5DD'}; color: #101828; text-decoration: none; font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif">العربية</a></div>`)
  } else if (props.route === '/preferences/users') {
    state = users.length ? 'partial' : 'empty'
    const rows = users.length
      ? users.map(user => {
        const services = [
          user.services.email ? (locale === 'ar' ? 'بريد' : 'Email') : '',
          user.services.ftp ? 'FTP' : '',
          user.services.webdisk ? (locale === 'ar' ? 'قرص ويب' : 'Web disk') : '',
        ].filter(Boolean).join(locale === 'ar' ? '، ' : ', ')
        return `<tr>${cell(mono(user.login), true)}${cell(escapeHtml(services || dash))}</tr>`
      }).join('')
      : emptyRow(locale, 2)
    body = card(`${soon(locale)}${table(locale === 'ar' ? ['اسم الدخول', 'الخدمات'] : ['Login', 'Services'], rows)}${disabledAction(locale, copy.action)}`)
  } else if (props.route === '/preferences/team') {
    body = card(`${soon(locale)}${table(locale === 'ar' ? ['الشخص', 'الدور'] : ['Person', 'Role'], emptyRow(locale, 2))}${disabledAction(locale, copy.action)}`)
  } else {
    state = 'partial'
    const statusLabel = props.account.status === 'active'
      ? (locale === 'ar' ? 'نشط' : 'Active')
      : props.account.status === 'suspended'
        ? (locale === 'ar' ? 'موقوف' : 'Suspended')
        : (locale === 'ar' ? 'قيد الإنهاء' : 'Terminating')
    const rows = domains.length
      ? domains.map(domain => `<tr>${cell(mono(domain.name), true)}${cell(locale === 'ar' ? 'لم يُفحص' : 'Not checked')}</tr>`).join('')
      : emptyRow(locale, 2)
    body = card(`${fact(locale === 'ar' ? 'حالة الحساب' : 'Account status', escapeHtml(statusLabel))}${table(locale === 'ar' ? ['الموقع', 'الفحص'] : ['Site', 'Check'], rows)}${disabledAction(locale, copy.action)}`)
  }

  return `<div class="xp-board-port" data-composed-route="${props.route}" data-composed-state="${state}" style="display: flex; flex-direction: column; gap: 16px; max-inline-size: 960px">
    <p style="margin: 0; font-size: 12.5px; font-weight: 600; color: #5D6B7E">${text(locale, copy.group)}</p>
    <div style="display: flex; flex-direction: column; gap: 6px">
      <h1 class="xp-page-title" style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${text(locale, copy.title)}</h1>
      <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #475467">${text(locale, copy.lede)}</p>
    </div>
    ${body}
  </div>`
}
