import type { Account, Domain, Plan, Principal } from '@xpanel/core'
import type { Locale } from '../../i18n.ts'
import { extensionCard, extensionCollection, extensionDisabled, extensionFact, extensionFrame, extensionText, type ExtensionCopy, type ExtensionRouteSpec, type ReadCollection } from './shared.ts'

const accountTitles: readonly (readonly [string, ExtensionCopy])[] = [
  ['/software/store', ['App catalog', 'كتالوج التطبيقات']],
  ['/software/store/app', ['Application details', 'تفاصيل التطبيق']],
  ['/software/store/install', ['Install application', 'تثبيت تطبيق']],
  ['/software/store/progress', ['Installation progress', 'تقدم التثبيت']],
  ['/software/store/installed', ['Installed applications', 'التطبيقات المثبتة']],
  ['/software/store/updates', ['Application updates', 'تحديثات التطبيقات']],
  ['/software/store/error', ['Installer status', 'حالة المثبّت']],
]
const rootTitles: readonly (readonly [string, ExtensionCopy])[] = [
  ['/whm/software/store', ['Catalog settings', 'إعدادات الكتالوج']],
  ['/whm/software/store/extensions', ['Server extensions', 'إضافات الخادم']],
  ['/whm/software/store/activity', ['Installer activity', 'نشاط المثبّت']],
]

/** Proposed route metadata only; existing navigation admission must register it. */
export const storeRouteSpecs: readonly ExtensionRouteSpec[] = [
  ...accountTitles.map(([route, title]): ExtensionRouteSpec => ({ route, title, surface: 'xpanel', roles: ['owner'], tools: ['app-installer'] })),
  ...rootTitles.map(([route, title]): ExtensionRouteSpec => ({ route, title, surface: 'xwhm', roles: ['root'], tools: ['site-software-catalog', 'site-software-instances'] })),
]

export interface StoreExtensionInput {
  locale: Locale
  route: string
  principal: Principal
  account?: Pick<Account, 'id' | 'status'>
  domains?: ReadCollection<Pick<Domain, 'accountId' | 'name'>>
  plans?: ReadCollection<Pick<Plan, 'name'>>
  platform?: { state: 'unread' } | { state: 'read'; name: string; version: string }
}

/** Read-only presentation. It has no signed-catalog reader or installer transport. */
export const renderStoreExtension = (input: StoreExtensionInput): string => {
  const { locale, principal } = input
  const route = input.route === '/software/installer' ? '/software/store'
    : input.route === '/whm/software/site-software' ? '/whm/software/store' : input.route
  const spec = storeRouteSpecs.find(item => item.route === route)
  if (!spec) return ''
  const root = spec.surface === 'xwhm'
  const account = input.account
  if (root ? principal.kind !== 'root' : !account || principal.kind !== 'user' || principal.accountId !== account.id || account.status !== 'active') return ''
  const viewNavigation = `<nav class="xp-extension__actions" aria-label="${extensionText(locale, ['Store views', 'صفحات المتجر'])}">${storeRouteSpecs.filter(item => item.surface === spec.surface).map(item => `<a class="xp-btn" href="${item.route}" data-nav-route="${item.route}"${item.route === route ? ' aria-current="page"' : ''}>${extensionText(locale, item.title)}</a>`).join('')}</nav>`
  const unavailable = extensionCard(locale, ['Installer unavailable', 'المثبّت غير متاح'], `<p data-installer-state="unavailable">${extensionText(locale, ['A signed catalog and installer are not connected to this view. Installation, update and rollback controls are unavailable; job state has not been read.', 'الكتالوج الموقّع والمثبّت غير متصلين بهذه الصفحة. عناصر التثبيت والتحديث والتراجع غير متاحة؛ لم تُقرأ حالة العمليات.'])}</p><dl class="xp-extension__facts">${extensionFact(locale, ['Catalog', 'الكتالوج'], undefined)}${extensionFact(locale, ['Installed applications', 'التطبيقات المثبتة'], undefined)}${extensionFact(locale, ['Platform', 'المنصة'], input.platform?.state === 'read' ? input.platform.name : undefined)}${extensionFact(locale, ['Platform version', 'إصدار المنصة'], input.platform?.state === 'read' ? input.platform.version : undefined, true)}</dl>`)
  let details = ''
  if (root) {
    if (route.endsWith('/activity')) {
      details = extensionCard(locale, ['Installer activity', 'نشاط المثبّت'], `<p data-collection-state="unread">${extensionText(locale, ['Installer activity was not read. General audit events are not installer activity.', 'لم يُقرأ نشاط المثبّت. أحداث التدقيق العامة ليست نشاطًا للمثبّت.'])}</p>`)
    } else {
      details = extensionCard(locale, ['Catalog authority', 'إدارة الكتالوج'], `<dl class="xp-extension__facts">${extensionFact(locale, ['Catalog sources', 'مصادر الكتالوج'], undefined)}${extensionFact(locale, ['Trusted signing keys', 'مفاتيح التوقيع الموثوقة'], undefined)}${extensionFact(locale, ['Extensions', 'الإضافات'], undefined)}</dl><p>${extensionText(locale, ['Private signing keys are never shown here.', 'لا تُعرض مفاتيح التوقيع الخاصة هنا.'])}</p>${extensionCollection(locale, input.plans, ['The read returned no plans.', 'لم تُرجع القراءة أي خطة.'], plan => `<dl class="xp-extension__facts">${extensionFact(locale, ['Plan', 'الخطة'], plan.name)}${extensionFact(locale, ['Application feature key', 'مفتاح ميزة التطبيق'], undefined)}</dl>`)}<div class="xp-extension__actions">${extensionDisabled(locale, ['Add source', 'إضافة مصدر'])}${extensionDisabled(locale, ['Save feature keys', 'حفظ مفاتيح الميزات'])}${extensionDisabled(locale, ['Install extension', 'تثبيت إضافة'])}</div>`)
    }
  } else {
    const domains = input.domains?.state === 'read' ? { state: 'read' as const, items: input.domains.items.filter(domain => domain.accountId === input.account?.id) } : undefined
    details = extensionCard(locale, ['Installation target', 'وجهة التثبيت'], extensionCollection(locale, domains, ['The read returned no domains.', 'لم تُرجع القراءة أي نطاق.'], domain => `<dl class="xp-extension__facts">${extensionFact(locale, ['Domain', 'النطاق'], domain.name, true)}</dl>`))
    if (route.endsWith('/app')) details += extensionCard(locale, ['Application metadata', 'بيانات التطبيق'], `<dl class="xp-extension__facts">${extensionFact(locale, ['Version', 'الإصدار'], undefined)}${extensionFact(locale, ['Requirements', 'المتطلبات'], undefined)}${extensionFact(locale, ['Requested permissions', 'الأذونات المطلوبة'], undefined)}${extensionFact(locale, ['Changelog', 'سجل التغييرات'], undefined)}</dl>`)
    if (route.endsWith('/progress') || route.endsWith('/updates')) details += extensionCard(locale, ['Job state', 'حالة العملية'], `<p data-installer-progress="unread">${extensionText(locale, ['Job state, progress and logs have not been read.', 'لم تُقرأ حالة العملية أو بيانات التقدم أو السجلات.'])}</p>`)
  }
  const actions = extensionCard(locale, ['Available actions', 'الإجراءات المتاحة'], `<div class="xp-extension__actions">${extensionDisabled(locale, ['Install', 'تثبيت'])}${extensionDisabled(locale, ['Update', 'تحديث'])}${extensionDisabled(locale, ['Roll back', 'التراجع'])}${extensionDisabled(locale, ['Uninstall', 'إلغاء التثبيت'])}${extensionDisabled(locale, ['Retry', 'إعادة المحاولة'])}</div>`)
  return extensionFrame(locale, spec.title, `${viewNavigation}${unavailable}${details}${actions}`)
}
