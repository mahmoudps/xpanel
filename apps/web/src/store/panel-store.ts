import type { Domain } from '@xpanel/core'
import type { Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import {
  crumb, disabledButton, emptyState, progressTrack, section, soonHint, storeNav, storeNote, storeStyle, tx, unread,
} from './layout.ts'

export const PANEL_STORE_ROUTES = [
  '/software/store',
  '/software/store/app',
  '/software/store/install',
  '/software/store/progress',
  '/software/store/installed',
  '/software/store/updates',
  '/software/store/error',
] as const

const NAV = [
  { href: '/software/store', label: ['Discover', 'استكشاف'] },
  { href: '/software/store/app', label: ['Application', 'التطبيق'] },
  { href: '/software/store/install', label: ['Install', 'تثبيت'] },
  { href: '/software/store/progress', label: ['Progress', 'التقدّم'] },
  { href: '/software/store/installed', label: ['Installed', 'المثبتة'] },
  { href: '/software/store/updates', label: ['Updates', 'التحديثات'] },
  { href: '/software/store/error', label: ['Status', 'الحالة'] },
] as const

const NOTE = [
  'Install, update, and removal stay off until a signed catalog and the installer are connected.',
  'يبقى التثبيت والتحديث والإزالة متوقفة إلى أن يُوصل كتالوج موقَّع والمثبّت.',
] as const

const frame = (locale: Locale, route: string, title: readonly [string, string], lede: readonly [string, string], screen: string, body: string): string => `
${storeStyle()}
<div class="xp-design-page xp-store" data-store="account" data-store-screen="${screen}">
  <header class="xp-board-head">
    <div>
      ${crumb(locale, route === '/software/store'
        ? [{ label: ['Software', 'البرمجيات'] }, { label: ['App store', 'متجر التطبيقات'], current: true }]
        : [{ label: ['Software', 'البرمجيات'] }, { label: ['App store', 'متجر التطبيقات'], href: '/software/store' }, { label: title, current: true }])}
      <h1 class="xp-page-title">${tx(locale, title[0], title[1])}</h1>
      <p class="xp-design-page__lede">${tx(locale, lede[0], lede[1])}</p>
    </div>
  </header>
  ${storeNav(locale, ['App store', 'متجر التطبيقات'], route, NAV)}
  ${storeNote(locale, NOTE)}
  ${body}
</div>`

const home = (locale: Locale): string => frame(locale, '/software/store', ['App store', 'متجر التطبيقات'], [
  'Install open-source applications from the signed catalog your provider enables. Nothing is installed from this screen until that catalog and the installer are connected.',
  'ثبّت تطبيقات مفتوحة المصدر من الكتالوج الموقَّع الذي يفعّله مزوّدك. لا يُثبَّت شيء من هذه الشاشة إلى أن يُوصل ذلك الكتالوج والمثبّت.',
], 'home', `
${section(['Featured', 'المميز'], locale, `
  <div class="xp-store-hero">
    ${emptyState(locale, ['No featured application was read', 'لم يُقرأ تطبيق مميز'], ['The featured place stays empty until a signed catalog names one.', 'يبقى مكان التطبيق المميز فارغًا إلى أن يسمّيه كتالوج موقَّع.'])}
    <div class="xp-store-shot">${tx(locale, 'No screenshot was read', 'لم تُقرأ لقطة')}</div>
  </div>`, 'store-featured')}
${section(['Find an application', 'ابحث عن تطبيق'], locale, `
  <form class="xp-store-toolbar" role="search" method="get" action="/software/store">
    <div class="xp-field">
      <label class="xp-label" for="store-search">${tx(locale, 'Search', 'بحث')}</label>
      <input id="store-search" class="xp-input" type="search" name="q" autocomplete="off" placeholder="${tx(locale, 'Search the catalog', 'ابحث في الكتالوج')}">
    </div>
    <div class="xp-field">
      <label class="xp-label" for="store-filter">${tx(locale, 'Filter', 'تصفية')}</label>
      <select id="store-filter" class="xp-select" disabled data-wiring="soon">
        <option>${tx(locale, 'No filters were read', 'لم تُقرأ مرشحات')}</option>
      </select>
      ${soonHint(locale)}
    </div>
    <button type="submit" class="xp-btn">${tx(locale, 'Search', 'بحث')}</button>
  </form>`, 'store-find')}
${section(['Categories', 'التصنيفات'], locale, emptyState(locale,
  ['No categories were read', 'لم تُقرأ تصنيفات'],
  ['Categories appear when a signed catalog provides them.', 'تظهر التصنيفات عندما يوفّرها كتالوج موقَّع.'],
), 'store-categories')}
${section(['Catalog', 'الكتالوج'], locale, emptyState(locale,
  ['The signed catalog was not read', 'لم يُقرأ الكتالوج الموقَّع'],
  ['Applications are not listed until a trusted catalog is connected.', 'لا تُعرض التطبيقات إلى أن يُوصل كتالوج موثوق.'],
), 'store-catalog')}`)

const detail = (locale: Locale): string => frame(locale, '/software/store/app', ['Application', 'التطبيق'], [
  'Description, version, requirements, permissions, and changelog for one catalog application.',
  'الوصف والإصدار والمتطلبات والأذونات وسجل التغييرات لتطبيق واحد من الكتالوج.',
], 'app', `
${section(['Description', 'الوصف'], locale, emptyState(locale,
  ['No application was selected', 'لم يُحدَّد تطبيق'],
  ['No description was read.', 'لم يُقرأ وصف.'],
), 'store-description')}
${section(['Screenshots', 'لقطات الشاشة'], locale, `<div class="xp-store-shot">${tx(locale, 'No screenshot was read', 'لم تُقرأ لقطة')}</div>`, 'store-shots')}
${section(['Details', 'التفاصيل'], locale, `
  <dl class="xp-store-facts">
    <div><dt>${tx(locale, 'Version', 'الإصدار')}</dt><dd>${tx(locale, unread[0], unread[1])}</dd></div>
    <div><dt>${tx(locale, 'Requirements', 'المتطلبات')}</dt><dd>${tx(locale, 'No requirement was read', 'لم يُقرأ متطلب')}</dd></div>
  </dl>`, 'store-details')}
${section(['Permissions it requests', 'الأذونات التي يطلبها'], locale, emptyState(locale,
  ['No permission request was read', 'لم يُقرأ طلب إذن'],
  ['Permission names appear with the application, before any install.', 'تظهر أسماء الأذونات مع التطبيق، قبل أي تثبيت.'],
), 'store-permissions')}
${section(['Changelog', 'سجل التغييرات'], locale, emptyState(locale,
  ['No changelog was read', 'لم يُقرأ سجل تغييرات'],
  ['The changelog stays empty until the catalog provides one.', 'يبقى سجل التغييرات فارغًا إلى أن يوفّره الكتالوج.'],
), 'store-changelog')}
<div class="xp-store-actions">${disabledButton(locale, ['Install', 'تثبيت'], 'primary')}${soonHint(locale)}</div>`)

const install = (locale: Locale, domains: readonly Domain[]): string => {
  const options = domains.length
    ? domains.map(domain => `<option value="${escapeHtml(domain.name)}">${escapeHtml(domain.name)}</option>`).join('')
    : `<option value="">${tx(locale, 'No domain was read', 'لم يُقرأ نطاق')}</option>`
  return frame(locale, '/software/store/install', ['Install', 'تثبيت'], [
    'Choose a domain and path, a database, an administrator, and the permissions you agree to.',
    'اختر نطاقًا ومسارًا وقاعدة بيانات ومديرًا والأذونات التي توافق عليها.',
  ], 'install', `
<form class="xp-design-page" data-store-install="true" method="post" action="/software/store/install" novalidate>
  ${section(['Target', 'الوجهة'], locale, `
    <div class="xp-field">
      <label class="xp-label" for="store-domain">${tx(locale, 'Domain', 'النطاق')}</label>
      <select id="store-domain" name="domain" class="xp-select" dir="ltr"${domains.length ? '' : ' disabled'}>${options}</select>
    </div>
    <div class="xp-field">
      <label class="xp-label" for="store-path">${tx(locale, 'Path', 'المسار')}</label>
      <input id="store-path" name="path" class="xp-input" dir="ltr" value="" disabled data-wiring="soon" autocomplete="off">
    </div>
    ${domains.length ? '' : `<p class="xp-help">${tx(locale, 'No domain was read.', 'لم يُقرأ نطاق.')}</p>`}`, 'store-target')}
  ${section(['Database', 'قاعدة البيانات'], locale, `
    <label class="xp-store-check"><input type="checkbox" name="createDatabase" disabled data-wiring="soon"> ${tx(locale, 'Create a database for this install', 'أنشئ قاعدة بيانات لهذا التثبيت')}</label>
    ${soonHint(locale)}`, 'store-database')}
  ${section(['Administrator', 'المدير'], locale, `
    <div class="xp-field">
      <label class="xp-label" for="store-admin">${tx(locale, 'Admin user', 'مستخدم المدير')}</label>
      <input id="store-admin" name="adminUser" class="xp-input" dir="ltr" value="" disabled data-wiring="soon" autocomplete="off">
    </div>
    <div class="xp-field">
      <label class="xp-label" for="store-admin-email">${tx(locale, 'Email', 'البريد')}</label>
      <input id="store-admin-email" name="adminEmail" class="xp-input" type="email" dir="ltr" value="" disabled data-wiring="soon" autocomplete="off">
    </div>
    <div class="xp-field">
      <label class="xp-label" for="store-admin-password">${tx(locale, 'Password', 'كلمة المرور')}</label>
      <input id="store-admin-password" name="adminPassword" class="xp-input" type="password" value="" disabled data-wiring="soon" autocomplete="off">
    </div>`, 'store-admin')}
  ${section(['Permissions', 'الأذونات'], locale, `
    ${emptyState(locale, ['No permission request was read', 'لم يُقرأ طلب إذن'], ['Consent stays off until an application lists the permissions it requests.', 'تبقى الموافقة متوقفة إلى أن يسرد تطبيق الأذونات التي يطلبها.'])}
    <label class="xp-store-check"><input type="checkbox" name="consent" disabled data-wiring="soon"> ${tx(locale, 'I agree to the permissions this application requests', 'أوافق على الأذونات التي يطلبها هذا التطبيق')}</label>`, 'store-consent')}
  <div class="xp-store-actions">
    <button type="submit" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${tx(locale, 'Install', 'تثبيت')}</button>
    ${soonHint(locale)}
  </div>
</form>`)
}

const STEPS = [
  ['Read the signed catalog', 'قراءة الكتالوج الموقَّع'],
  ['Check requirements', 'التحقق من المتطلبات'],
  ['Prepare the target', 'تجهيز الوجهة'],
  ['Create the database', 'إنشاء قاعدة البيانات'],
  ['Write the application files', 'كتابة ملفات التطبيق'],
  ['Record the install', 'تسجيل التثبيت'],
] as const

const progress = (locale: Locale): string => frame(locale, '/software/store/progress', ['Progress', 'التقدّم'], [
  'A running install shows its steps, a measured bar, and the installer log. No install is running.',
  'يعرض التثبيت الجاري خطواته وشريطًا مقاسًا وسجل المثبّت. لا تثبيت يعمل.',
], 'progress', `
${section(['Steps', 'الخطوات'], locale, `
  <ol class="xp-store-steps">
    ${STEPS.map((step, index) => `<li data-step="pending"><span><bdi dir="ltr">${index + 1}</bdi> ${tx(locale, step[0], step[1])}</span><span>${tx(locale, 'Not started', 'لم يبدأ')}</span></li>`).join('')}
  </ol>
  ${progressTrack(locale, ['No install is running', 'لا تثبيت يعمل'])}
  <div class="xp-store-actions">${disabledButton(locale, ['Cancel', 'إلغاء'])}${soonHint(locale)}</div>`, 'store-steps')}
${section(['Installer log', 'سجل المثبّت'], locale, `
  <pre class="xp-store-log xp-mono" dir="ltr" data-store-log="empty">${tx(locale, 'No installer log was read.', 'لم يُقرأ سجل للمثبّت.')}</pre>`, 'store-log')}
<div class="xp-store-outcomes">
  ${section(['Success', 'نجاح'], locale, `
    ${emptyState(locale, ['No successful install was reported', 'لم يُبلَّغ عن تثبيت ناجح'], ['Retry stays off until the installer reports an outcome.', 'تبقى إعادة المحاولة متوقفة إلى أن يبلّغ المثبّت عن نتيجة.'])}
    <div class="xp-store-actions">${disabledButton(locale, ['Retry', 'إعادة المحاولة'])}${soonHint(locale)}</div>`, 'store-success')}
  ${section(['Failure', 'فشل'], locale, `
    ${emptyState(locale, ['No failed install was reported', 'لم يُبلَّغ عن تثبيت فاشل'], ['Logs and retry stay off until the installer reports a failure.', 'يبقى السجل وإعادة المحاولة متوقفين إلى أن يبلّغ المثبّت عن فشل.'])}
    <div class="xp-store-actions">${disabledButton(locale, ['Retry', 'إعادة المحاولة'])}${disabledButton(locale, ['View logs', 'عرض السجل'])}${soonHint(locale)}</div>`, 'store-failure')}
</div>`)

const installed = (locale: Locale): string => frame(locale, '/software/store/installed', ['Installed', 'المثبتة'], [
  'Applications installed in this account, with version, updates, and removal.',
  'التطبيقات المثبتة في هذا الحساب، مع الإصدار والتحديثات والإزالة.',
], 'installed', `
${section(['Installed applications', 'التطبيقات المثبتة'], locale, `
  <div class="xp-table-wrap">
    <table class="xp-table">
      <thead><tr>
        <th>${tx(locale, 'Application', 'التطبيق')}</th>
        <th>${tx(locale, 'Version', 'الإصدار')}</th>
        <th>${tx(locale, 'Update', 'التحديث')}</th>
        <th>${tx(locale, 'Auto-update', 'التحديث التلقائي')}</th>
        <th>${tx(locale, 'Backup before update', 'نسخ احتياطي قبل التحديث')}</th>
        <th>${tx(locale, 'Open', 'فتح')}</th>
      </tr></thead>
      <tbody><tr><td colspan="6">${tx(locale, 'No installed application was read.', 'لم يُقرأ تطبيق مثبت.')}</td></tr></tbody>
    </table>
  </div>
  <label class="xp-store-check"><input type="checkbox" role="switch" disabled data-wiring="soon"> ${tx(locale, 'Auto-update', 'التحديث التلقائي')}</label>
  <label class="xp-store-check"><input type="checkbox" disabled data-wiring="soon"> ${tx(locale, 'Backup before update', 'نسخ احتياطي قبل التحديث')}</label>
  <div class="xp-store-actions">${disabledButton(locale, ['Open', 'فتح'])}${disabledButton(locale, ['Admin', 'الإدارة'])}${soonHint(locale)}</div>`, 'store-installed')}
<section class="xp-store-danger" aria-labelledby="store-uninstall">
  <h2 id="store-uninstall">${tx(locale, 'Remove an application', 'إزالة تطبيق')}</h2>
  <p>${tx(locale, 'No installed application was selected.', 'لم يُحدَّد تطبيق مثبت.')}</p>
  ${disabledButton(locale, ['Remove', 'إزالة'], 'danger')}
  ${soonHint(locale)}
</section>`)

const updates = (locale: Locale): string => frame(locale, '/software/store/updates', ['Updates', 'التحديثات'], [
  'Update installed applications, or roll one back to the previous version.',
  'حدّث التطبيقات المثبتة، أو ارجع بأحدها إلى الإصدار السابق.',
], 'updates', `
${section(['Available updates', 'التحديثات المتاحة'], locale, `
  <div class="xp-table-wrap">
    <table class="xp-table">
      <thead><tr>
        <th>${tx(locale, 'Application', 'التطبيق')}</th>
        <th>${tx(locale, 'Installed version', 'الإصدار المثبت')}</th>
        <th>${tx(locale, 'Available version', 'الإصدار المتاح')}</th>
        <th>${tx(locale, 'Progress', 'التقدّم')}</th>
        <th>${tx(locale, 'Rollback', 'الرجوع')}</th>
      </tr></thead>
      <tbody><tr><td colspan="5">${tx(locale, 'No update was read.', 'لم يُقرأ تحديث.')}</td></tr></tbody>
    </table>
  </div>
  ${progressTrack(locale, ['No update is running', 'لا تحديث يعمل'])}
  <div class="xp-store-actions">
    ${disabledButton(locale, ['Update all', 'تحديث الكل'], 'primary')}
    ${disabledButton(locale, ['Roll back to the previous version', 'الرجوع إلى الإصدار السابق'])}
    ${soonHint(locale)}
  </div>`, 'store-updates')}`)

const errorScreen = (locale: Locale): string => frame(locale, '/software/store/error', ['Status', 'الحالة'], [
  'The store reports a missing catalog or a disconnected installer without inventing an application.',
  'يبّلغ المتجر عن كتالوج غير مقروء أو مثبّت غير متصل من غير اختلاق تطبيق.',
], 'error', `
${section(['Catalog', 'الكتالوج'], locale, `
  ${emptyState(locale, ['The signed catalog was not read', 'لم يُقرأ الكتالوج الموقَّع'], ['Search and install stay unavailable until a trusted catalog responds.', 'يبقى البحث والتثبيت غير متاحين إلى أن يرد كتالوج موثوق.'])}
  <div class="xp-store-actions">${disabledButton(locale, ['Retry', 'إعادة المحاولة'])}${soonHint(locale)}</div>`, 'store-catalog-error')}
${section(['Installer', 'المثبّت'], locale, `
  ${emptyState(locale, ['The installer is not connected', 'المثبّت غير متصل'], ['Progress, logs, and retry stay off until an installer session exists.', 'يبقى التقدّم والسجل وإعادة المحاولة متوقفة إلى أن توجد جلسة مثبّت.'])}
  <div class="xp-store-actions">${disabledButton(locale, ['Retry', 'إعادة المحاولة'])}${disabledButton(locale, ['View logs', 'عرض السجل'])}${soonHint(locale)}</div>`, 'store-installer-error')}`)

export const renderAccountStore = (input: { locale: Locale; route: string; domains: readonly Domain[] }): string => {
  switch (input.route) {
    case '/software/store': return home(input.locale)
    case '/software/store/app': return detail(input.locale)
    case '/software/store/install': return install(input.locale, input.domains)
    case '/software/store/progress': return progress(input.locale)
    case '/software/store/installed': return installed(input.locale)
    case '/software/store/updates': return updates(input.locale)
    case '/software/store/error': return errorScreen(input.locale)
    default: return ''
  }
}
