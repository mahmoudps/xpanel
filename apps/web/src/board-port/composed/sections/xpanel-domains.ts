import type { ComposedRoute } from '../types.ts'

export const xpanel_domains: readonly ComposedRoute[] = [
  {
    "route": "/domains/site-settings",
    "surface": "xpanel",
    "section": "domains",
    "group": [
      "Domains",
      "النطاقات"
    ],
    "title": [
      "Site settings",
      "إعدادات الموقع"
    ],
    "lede": [
      "Use the existing authorized account screen. This route does not create a second operation controller.",
      "تُستخدم شاشة الحساب الحالية المصرّح بها. هذا المسار لا ينشئ وحدة تحكم ثانية للعمليات."
    ],
    "layout": "site",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "site-settings"
  },
  {
    "route": "/domains/staging",
    "surface": "xpanel",
    "section": "domains",
    "group": [
      "Domains",
      "النطاقات"
    ],
    "title": [
      "Staging sites",
      "مواقع التجهيز"
    ],
    "lede": [
      "Staging sites is unavailable. No operation has been started and no result has been read.",
      "مواقع التجهيز غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/redirects",
    "surface": "xpanel",
    "section": "domains",
    "group": [
      "Domains",
      "النطاقات"
    ],
    "title": [
      "Redirects",
      "إعادة التوجيه"
    ],
    "lede": [
      "Redirects is unavailable. No operation has been started and no result has been read.",
      "إعادة التوجيه غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/reverse-proxy",
    "surface": "xpanel",
    "section": "domains",
    "group": [
      "Domains",
      "النطاقات"
    ],
    "title": [
      "Reverse proxy",
      "الوكيل العكسي"
    ],
    "lede": [
      "Reverse proxy is unavailable. No operation has been started and no result has been read.",
      "الوكيل العكسي غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/dynamic-dns",
    "surface": "xpanel",
    "section": "domains",
    "group": [
      "Domains",
      "النطاقات"
    ],
    "title": [
      "Dynamic DNS",
      "DNS الديناميكي"
    ],
    "lede": [
      "Dynamic DNS is unavailable. No operation has been started and no result has been read.",
      "DNS الديناميكي غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/cloudflare",
    "surface": "xpanel",
    "section": "domains",
    "group": [
      "Domains",
      "النطاقات"
    ],
    "title": [
      "Cloudflare",
      "Cloudflare"
    ],
    "lede": [
      "Cloudflare is unavailable. No operation has been started and no result has been read.",
      "Cloudflare غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/site-publisher",
    "surface": "xpanel",
    "section": "domains",
    "group": [
      "Domains",
      "النطاقات"
    ],
    "title": [
      "Site publisher",
      "ناشر المواقع"
    ],
    "lede": [
      "Site publisher is unavailable. No operation has been started and no result has been read.",
      "ناشر المواقع غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
