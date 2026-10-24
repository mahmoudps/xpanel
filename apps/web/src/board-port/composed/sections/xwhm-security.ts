import type { ComposedRoute } from '../types.ts'

export const xwhm_security: readonly ComposedRoute[] = [
  {
    "route": "/whm/security/intrusion",
    "surface": "xwhm",
    "section": "security",
    "group": [
      "Security center",
      "مركز الأمان"
    ],
    "title": [
      "Intrusion detection",
      "كشف التسلل"
    ],
    "lede": [
      "No intrusion-detection report has been read. Ban changes are unavailable.",
      "لم يُقرأ تقرير اكتشاف التسلل. تغييرات الحظر غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/flood",
    "surface": "xwhm",
    "section": "security",
    "group": [
      "Security center",
      "مركز الأمان"
    ],
    "title": [
      "Flood protection",
      "الحماية من الإغراق"
    ],
    "lede": [
      "No connection or flood-protection configuration has been read. Rule changes are unavailable.",
      "لم تُقرأ إعدادات حماية الاتصالات أو الإغراق. تغييرات القواعد غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/waf",
    "surface": "xwhm",
    "section": "security",
    "group": [
      "Security center",
      "مركز الأمان"
    ],
    "title": [
      "Web application firewall",
      "جدار حماية تطبيقات الويب"
    ],
    "lede": [
      "No web-application firewall configuration has been read. Rule and vendor changes are unavailable.",
      "لم تُقرأ إعدادات جدار حماية تطبيقات الويب. تغييرات القواعد والمزوّدين غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/isolation",
    "surface": "xwhm",
    "section": "security",
    "group": [
      "Security center",
      "مركز الأمان"
    ],
    "title": [
      "Account isolation",
      "عزل الحسابات"
    ],
    "lede": [
      "No account-isolation report has been read. Isolation and shell-policy changes are unavailable.",
      "لم يُقرأ تقرير عزل الحسابات. تغييرات العزل وسياسات الطرفية غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/antivirus",
    "surface": "xwhm",
    "section": "security",
    "group": [
      "Security center",
      "مركز الأمان"
    ],
    "title": [
      "Antivirus",
      "مكافحة الفيروسات"
    ],
    "lede": [
      "No antivirus report or configuration has been read. Scans and configuration changes are unavailable.",
      "لم يُقرأ تقرير أو إعداد لمكافحة الفيروسات. الفحص وتغييرات الإعدادات غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/panel-access",
    "surface": "xwhm",
    "section": "security",
    "group": [
      "Security center",
      "مركز الأمان"
    ],
    "title": [
      "Panel access",
      "الوصول إلى اللوحة"
    ],
    "lede": [
      "No global panel-access configuration has been read. Listener and access-policy changes are unavailable.",
      "لم تُقرأ إعدادات الوصول العامة للوحة. تغييرات منافذ الاستماع وسياسات الوصول غير متاحة."
    ],
    "layout": "security",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/sign-in",
    "surface": "xwhm",
    "section": "security",
    "group": [
      "Security center",
      "مركز الأمان"
    ],
    "title": [
      "Sign-in & 2FA",
      "تسجيل الدخول والتحقق بخطوتين"
    ],
    "lede": [
      "Personal sign-in security remains in the existing account-security view. Global sign-in policy changes are unavailable here.",
      "تبقى حماية تسجيل الدخول الشخصية في واجهة أمان الحساب الحالية. تغييرات سياسات الدخول العامة غير متاحة هنا."
    ],
    "layout": "security",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
