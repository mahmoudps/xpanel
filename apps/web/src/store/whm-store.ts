import type { Plan } from '@xpanel/core'
import type { Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import {
  crumb, disabledButton, emptyState, fact, progressTrack, section, soonHint, storeNav, storeNote, storeStyle, tx, unread,
} from './layout.ts'

export const WHM_STORE_ROUTES = [
  '/whm/software/store',
  '/whm/software/store/extensions',
  '/whm/software/store/activity',
] as const

const NAV = [
  { href: '/whm/software/store', label: ['Catalog', 'الكتالوج'] },
  { href: '/whm/software/store/extensions', label: ['Extensions', 'الإضافات'] },
  { href: '/whm/software/store/activity', label: ['Activity', 'النشاط'] },
] as const

const NOTE = [
  'Enable, disable, install, update, and rollback stay off until a signed catalog and the installer are connected.',
  'يبقى التفعيل والتعطيل والتثبيت والتحديث والرجوع متوقفة إلى أن يُوصل كتالوج موقَّع والمثبّت.',
] as const

const frame = (locale: Locale, route: string, title: readonly [string, string], lede: readonly [string, string], screen: string, body: string): string => `
${storeStyle()}
<div class="xp-design-page xp-store" data-store="root" data-store-screen="${screen}">
  <header class="xp-board-head">
    <div>
      ${crumb(locale, route === '/whm/software/store'
        ? [{ label: ['Software', 'البرمجيات'] }, { label: ['App store', 'متجر التطبيقات'], current: true }]
        : [{ label: ['Software', 'البرمجيات'] }, { label: ['App store', 'متجر التطبيقات'], href: '/whm/software/store' }, { label: title, current: true }])}
      <h1 class="xp-page-title">${tx(locale, title[0], title[1])}</h1>
      <p class="xp-design-page__lede">${tx(locale, lede[0], lede[1])}</p>
    </div>
  </header>
  ${storeNav(locale, ['App store', 'متجر التطبيقات'], route, NAV)}
  ${storeNote(locale, NOTE)}
  ${body}
</div>`

const emptyRow = (locale: Locale, columns: number, label: readonly [string, string]): string =>
  `<tr><td colspan="${columns}">${tx(locale, label[0], label[1])}</td></tr>`

const catalog = (locale: Locale, plans: readonly Plan[]): string => frame(locale, '/whm/software/store', ['Catalog', 'الكتالوج'], [
  'Sources, trusted signing keys, which applications are offered, and the feature key on each plan.',
  'المصادر ومفاتيح التوقيع الموثوقة والتطبيقات المعروضة ومفتاح الميزة في كل خطة.',
], 'catalog', `
${section(['Sources', 'المصادر'], locale, `
  <div class="xp-table-wrap">
    <table class="xp-table">
      <thead><tr>
        <th>${tx(locale, 'Name', 'الاسم')}</th>
        <th>${tx(locale, 'URL', 'العنوان')}</th>
        <th>${tx(locale, 'Signature', 'التوقيع')}</th>
      </tr></thead>
      <tbody>${emptyRow(locale, 3, ['No catalog source was read.', 'لم يُقرأ مصدر كتالوج.'])}</tbody>
    </table>
  </div>
  <form class="xp-store-toolbar" data-store-source="true" method="post" action="/api/whm/store/sources" novalidate>
    <div class="xp-field">
      <label class="xp-label" for="store-source-url">${tx(locale, 'Catalog URL', 'عنوان الكتالوج')}</label>
      <input id="store-source-url" name="url" class="xp-input" type="url" dir="ltr" value="" disabled data-wiring="soon" autocomplete="off">
    </div>
    <button type="submit" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${tx(locale, 'Add source', 'إضافة مصدر')}</button>
  </form>
  ${soonHint(locale)}`, 'store-sources')}
${section(['Trust and keys', 'الثقة والمفاتيح'], locale, `
  <dl class="xp-store-facts">
    ${fact(locale, ['Algorithm', 'الخوارزمية'], unread)}
    ${fact(locale, ['Fingerprint', 'البصمة'], unread)}
    ${fact(locale, ['Status', 'الحالة'], unread)}
  </dl>
  <p class="xp-help">${tx(locale, 'Private keys stay off this screen.', 'المفاتيح الخاصة تبقى خارج هذه الشاشة.')}</p>`, 'store-trust')}
${section(['Applications', 'التطبيقات'], locale, `
  <div class="xp-table-wrap">
    <table class="xp-table">
      <thead><tr>
        <th>${tx(locale, 'Application', 'التطبيق')}</th>
        <th>${tx(locale, 'Enabled', 'مفعّل')}</th>
      </tr></thead>
      <tbody>${emptyRow(locale, 2, ['No application was read.', 'لم يُقرأ تطبيق.'])}</tbody>
    </table>
  </div>
  <label class="xp-store-check"><input type="checkbox" role="switch" disabled data-wiring="soon"> ${tx(locale, 'Enable application', 'تفعيل التطبيق')}</label>
  <label class="xp-store-check"><input type="checkbox" role="switch" disabled data-wiring="soon"> ${tx(locale, 'Disable application', 'تعطيل التطبيق')}</label>
  ${soonHint(locale)}`, 'store-apps')}
${section(['Per-plan feature keys', 'مفاتيح الميزات لكل خطة'], locale, plans.length ? `
  <div class="xp-table-wrap">
    <table class="xp-table">
      <thead><tr>
        <th>${tx(locale, 'Plan', 'الخطة')}</th>
        <th>${tx(locale, 'Feature key', 'مفتاح الميزة')}</th>
      </tr></thead>
      <tbody>${plans.map(plan => `<tr><td><bdi dir="ltr">${escapeHtml(plan.name)}</bdi></td><td>${tx(locale, unread[0], unread[1])}</td></tr>`).join('')}</tbody>
    </table>
  </div>
  <div class="xp-store-actions">${disabledButton(locale, ['Save feature keys', 'حفظ مفاتيح الميزات'], 'primary')}${soonHint(locale)}</div>` : `
  ${emptyState(locale, ['No plan was read', 'لم تُقرأ خطة'], ['Feature keys appear beside each plan when plans are read.', 'تظهر مفاتيح الميزات بجانب كل خطة عندما تُقرأ الخطط.'])}
  <div class="xp-store-actions">${disabledButton(locale, ['Save feature keys', 'حفظ مفاتيح الميزات'], 'primary')}${soonHint(locale)}</div>`, 'store-features')}
${section(['Status', 'الحالة'], locale, `
  ${emptyState(locale, ['The signed catalog was not read', 'لم يُقرأ الكتالوج الموقَّع'], ['Sources and applications stay empty until a trusted catalog responds.', 'تبقى المصادر والتطبيقات فارغة إلى أن يرد كتالوج موثوق.'])}
  ${emptyState(locale, ['The installer is not connected', 'المثبّت غير متصل'], ['Install, update, and rollback stay off until an installer session exists.', 'يبقى التثبيت والتحديث والرجوع متوقفة إلى أن توجد جلسة مثبّت.'])}
  <div class="xp-store-actions">${disabledButton(locale, ['Retry', 'إعادة المحاولة'])}${disabledButton(locale, ['View logs', 'عرض السجل'])}${soonHint(locale)}</div>`, 'store-status')}`)

const extensions = (locale: Locale): string => frame(locale, '/whm/software/store/extensions', ['Extensions', 'الإضافات'], [
  'Install a root extension, update it, roll it back, and review the permissions it requests.',
  'ثبّت إضافة جذر، حدّثها، ارجع بها، وراجع الأذونات التي تطلبها.',
], 'extensions', `
${section(['Extensions', 'الإضافات'], locale, `
  <div class="xp-table-wrap">
    <table class="xp-table">
      <thead><tr>
        <th>${tx(locale, 'Extension', 'الإضافة')}</th>
        <th>${tx(locale, 'Version', 'الإصدار')}</th>
        <th>${tx(locale, 'Permissions', 'الأذونات')}</th>
      </tr></thead>
      <tbody>${emptyRow(locale, 3, ['No extension was read.', 'لم تُقرأ إضافة.'])}</tbody>
    </table>
  </div>`, 'store-extensions')}
${section(['Install', 'تثبيت'], locale, `
  ${emptyState(locale, ['No extension was selected', 'لم تُحدَّد إضافة'], ['Install stays off until a signed catalog names an extension.', 'يبقى التثبيت متوقفًا إلى أن يسمّي كتالوج موقَّع إضافة.'])}
  <label class="xp-store-check"><input type="checkbox" name="consent" disabled data-wiring="soon"> ${tx(locale, 'I agree to the permissions this extension requests', 'أوافق على الأذونات التي تطلبها هذه الإضافة')}</label>
  <div class="xp-store-actions">${disabledButton(locale, ['Install', 'تثبيت'], 'primary')}${soonHint(locale)}</div>`, 'store-install')}
${section(['Update', 'تحديث'], locale, `
  ${progressTrack(locale, ['No extension job is running', 'لا مهمة إضافة تعمل'])}
  <div class="xp-store-actions">${disabledButton(locale, ['Update', 'تحديث'], 'primary')}${soonHint(locale)}</div>`, 'store-update')}
${section(['Permissions review', 'مراجعة الأذونات'], locale, emptyState(locale,
  ['No permission request was read', 'لم يُقرأ طلب إذن'],
  ['Permission names appear with the extension, before any install.', 'تظهر أسماء الأذونات مع الإضافة، قبل أي تثبيت.'],
), 'store-permissions')}
<section class="xp-store-danger" aria-labelledby="store-rollback">
  <h2 id="store-rollback">${tx(locale, 'Roll back an extension', 'الرجوع بإضافة')}</h2>
  <p>${tx(locale, 'No extension was selected.', 'لم تُحدَّد إضافة.')}</p>
  ${disabledButton(locale, ['Roll back to the previous version', 'الرجوع إلى الإصدار السابق'], 'danger')}
  ${soonHint(locale)}
</section>`)

const activity = (locale: Locale): string => frame(locale, '/whm/software/store/activity', ['Activity', 'النشاط'], [
  'Installer jobs only. This log does not repeat the general server audit.',
  'مهام المثبّت فقط. لا يكرّر هذا السجل تدقيق الخادم العام.',
], 'activity', `
${section(['Installer activity', 'نشاط المثبّت'], locale, `
  <div class="xp-table-wrap">
    <table class="xp-table">
      <thead><tr>
        <th>${tx(locale, 'Time', 'الوقت')}</th>
        <th>${tx(locale, 'Actor', 'الفاعل')}</th>
        <th>${tx(locale, 'Action', 'الإجراء')}</th>
        <th>${tx(locale, 'Target', 'الهدف')}</th>
        <th>${tx(locale, 'Outcome', 'النتيجة')}</th>
      </tr></thead>
      <tbody>${emptyRow(locale, 5, ['No installer activity was read.', 'لم يُقرأ نشاط للمثبّت.'])}</tbody>
    </table>
  </div>
  <div class="xp-store-actions">${disabledButton(locale, ['Retry', 'إعادة المحاولة'])}${soonHint(locale)}</div>`, 'store-activity')}`)

export const renderRootStore = (input: { locale: Locale; route: string; plans: readonly Plan[] }): string => {
  switch (input.route) {
    case '/whm/software/store': return catalog(input.locale, input.plans)
    case '/whm/software/store/extensions': return extensions(input.locale)
    case '/whm/software/store/activity': return activity(input.locale)
    default: return ''
  }
}
