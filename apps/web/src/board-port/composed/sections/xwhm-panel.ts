import type { ComposedRoute } from '../types.ts'

export const xwhm_panel: readonly ComposedRoute[] = [
  {
    "route": "/whm/panel/settings",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "Panel settings",
      "إعدادات اللوحة"
    ],
    "lede": [
      "No global panel settings have been read. Configuration changes are unavailable.",
      "لم تُقرأ إعدادات اللوحة العامة. تغييرات الإعدادات غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/data",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "Panel data & recovery",
      "بيانات اللوحة واستعادتها"
    ],
    "lede": [
      "Generation history remains in the existing authorized view. This composition does not execute rollback.",
      "يبقى سجل الأجيال في واجهته الحالية المصرح بها. لا تنفذ هذه الشاشة تراجعًا."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/branding",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "Branding & themes",
      "الهوية البصرية والسمات"
    ],
    "lede": [
      "No branding configuration has been read. Uploads and appearance changes are unavailable.",
      "لم تُقرأ إعدادات الهوية البصرية. رفع الملفات وتغييرات المظهر غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/languages",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "Languages",
      "اللغات"
    ],
    "lede": [
      "No locale configuration has been read. Import, export and locale changes are unavailable.",
      "لم تُقرأ إعدادات اللغات. الاستيراد والتصدير وتغييرات اللغات غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/notifications",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "Notifications",
      "الإشعارات"
    ],
    "lede": [
      "No notification configuration has been read. Channel changes and test delivery are unavailable.",
      "لم تُقرأ إعدادات الإشعارات. تغييرات القنوات والإرسال التجريبي غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/integrations",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "Integrations",
      "التكاملات"
    ],
    "lede": [
      "No integration inventory has been read. Connecting or changing external services is unavailable.",
      "لم يُقرأ مخزون التكاملات. وصل الخدمات الخارجية أو تغييرها غير متاح."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/whmcs",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "WHMCS",
      "WHMCS"
    ],
    "lede": [
      "No billing integration configuration has been read. Provisioning and connection changes are unavailable.",
      "لم تُقرأ إعدادات تكامل الفوترة. التزويد وتغييرات الاتصال غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/api-tokens",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "API tokens",
      "رموز API"
    ],
    "lede": [
      "No API-token inventory has been read. Token creation, changes and revocation are unavailable.",
      "لم يُقرأ مخزون رموز API. إنشاء الرموز وتغييرها وإلغاؤها غير متاح."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/panel/developer",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "Developer tools",
      "أدوات المطورين"
    ],
    "lede": [
      "No developer-tool configuration has been read. Hooks, app registration and API-console operations are unavailable.",
      "لم تُقرأ إعدادات أدوات المطورين. عمليات الخطافات وتسجيل التطبيقات وواجهة API غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/preferences",
    "surface": "xwhm",
    "section": "panel",
    "group": [
      "Panel & integrations",
      "اللوحة والتكاملات"
    ],
    "title": [
      "My preferences",
      "تفضيلاتي"
    ],
    "lede": [
      "No persisted preference record has been read. Existing language and theme navigation remains available without saving a preference here.",
      "لم يُقرأ سجل تفضيلات محفوظ. يبقى التنقل الحالي بين اللغة والسمة متاحًا دون حفظ تفضيل هنا."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
