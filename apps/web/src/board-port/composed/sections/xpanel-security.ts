import type { ComposedRoute } from '../types.ts'

export const xpanel_security: readonly ComposedRoute[] = [
  {
    "route": "/security/ssl/issue",
    "surface": "xpanel",
    "section": "security",
    "group": [
      "Security",
      "الأمان"
    ],
    "title": [
      "Issue certificate",
      "إصدار شهادة"
    ],
    "lede": [
      "Use the existing authorized account screen. This route does not create a second operation controller.",
      "تُستخدم شاشة الحساب الحالية المصرّح بها. هذا المسار لا ينشئ وحدة تحكم ثانية للعمليات."
    ],
    "layout": "ssl",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "ssl-issue"
  },
  {
    "route": "/security/ssl/files",
    "surface": "xpanel",
    "section": "security",
    "group": [
      "Security",
      "الأمان"
    ],
    "title": [
      "Certificate files",
      "ملفات الشهادات"
    ],
    "lede": [
      "Stored domain certificate assignments can be read. Certificate and private-key contents are unavailable.",
      "يمكن قراءة تعيينات شهادات النطاقات المحفوظة. محتوى الشهادات والمفاتيح الخاصة غير متاح."
    ],
    "layout": "ssl",
    "action": null,
    "columns": [
      [
        "Domain",
        "النطاق"
      ],
      [
        "Certificate assignment",
        "تعيين الشهادة"
      ]
    ],
    "fields": [],
    "bind": "ssl-files"
  },
  {
    "route": "/security/waf",
    "surface": "xpanel",
    "section": "security",
    "group": [
      "Security",
      "الأمان"
    ],
    "title": [
      "Web application firewall",
      "جدار حماية تطبيقات الويب"
    ],
    "lede": [
      "Web application firewall is unavailable. No operation has been started and no result has been read.",
      "جدار حماية تطبيقات الويب غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/ip-blocker",
    "surface": "xpanel",
    "section": "security",
    "group": [
      "Security",
      "الأمان"
    ],
    "title": [
      "IP blocker",
      "حظر عناوين IP"
    ],
    "lede": [
      "IP blocker is unavailable. No operation has been started and no result has been read.",
      "حظر عناوين IP غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/hotlink",
    "surface": "xpanel",
    "section": "security",
    "group": [
      "Security",
      "الأمان"
    ],
    "title": [
      "Hotlink protection",
      "الحماية من الربط المباشر"
    ],
    "lede": [
      "Hotlink protection is unavailable. No operation has been started and no result has been read.",
      "الحماية من الربط المباشر غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/ssh",
    "surface": "xpanel",
    "section": "security",
    "group": [
      "Security",
      "الأمان"
    ],
    "title": [
      "SSH access",
      "الوصول عبر SSH"
    ],
    "lede": [
      "SSH access is unavailable. No operation has been started and no result has been read.",
      "الوصول عبر SSH غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/virus-scanner",
    "surface": "xpanel",
    "section": "security",
    "group": [
      "Security",
      "الأمان"
    ],
    "title": [
      "Virus scanner",
      "فاحص الفيروسات"
    ],
    "lede": [
      "Virus scanner is unavailable. No operation has been started and no result has been read.",
      "فاحص الفيروسات غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
