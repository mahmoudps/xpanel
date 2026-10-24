import type { ComposedRoute } from '../types.ts'

export const xwhm_services: readonly ComposedRoute[] = [
  {
    "route": "/whm/services/more",
    "surface": "xwhm",
    "section": "services",
    "group": [
      "Services",
      "الخدمات"
    ],
    "title": [
      "More service tools",
      "خدمات إضافية"
    ],
    "lede": [
      "No extended service inventory has been read. Startup, supervision and reboot operations are unavailable.",
      "لم يُقرأ مخزون الخدمات الموسع. عمليات بدء التشغيل والإشراف وإعادة التشغيل غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/health",
    "surface": "xwhm",
    "section": "services",
    "group": [
      "Services",
      "الخدمات"
    ],
    "title": [
      "Configuration health",
      "صحة إعداد الخدمات"
    ],
    "lede": [
      "Configuration-health checks are unavailable. A running service is not a configuration-drift result, and no repair is performed here.",
      "فحوص صحة الإعدادات غير متاحة. تشغيل الخدمة ليس نتيجة فحص لانحراف الإعدادات، ولا تُنفذ إصلاحات هنا."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/ftp",
    "surface": "xwhm",
    "section": "services",
    "group": [
      "Services",
      "الخدمات"
    ],
    "title": [
      "FTP server",
      "خادم FTP"
    ],
    "lede": [
      "No FTP-service configuration has been read. Daemon, port and access changes are unavailable.",
      "لم تُقرأ إعدادات خدمة FTP. تغييرات الخادم والمنفذ والوصول غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/dns",
    "surface": "xwhm",
    "section": "services",
    "group": [
      "Services",
      "الخدمات"
    ],
    "title": [
      "DNS server",
      "خادم DNS"
    ],
    "lede": [
      "No DNS-service configuration has been read. Daemon changes are unavailable.",
      "لم تُقرأ إعدادات خدمة DNS. تغييرات الخادم غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/certificates",
    "surface": "xwhm",
    "section": "services",
    "group": [
      "Services",
      "الخدمات"
    ],
    "title": [
      "Service certificates",
      "شهادات الخدمات"
    ],
    "lede": [
      "No service-certificate inventory has been read. Certificate and TLS-policy changes are unavailable.",
      "لم يُقرأ مخزون شهادات الخدمات. تغييرات الشهادات وسياسات TLS غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/ftp-log-analysis",
    "surface": "xwhm",
    "section": "services",
    "group": [
      "Services",
      "الخدمات"
    ],
    "title": [
      "FTP log analysis",
      "تحليل سجلات FTP"
    ],
    "lede": [
      "No FTP activity report has been read. Log analysis is unavailable.",
      "لم يُقرأ تقرير نشاط FTP. تحليل السجلات غير متاح."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/default-index",
    "surface": "xwhm",
    "section": "services",
    "group": [
      "Services",
      "الخدمات"
    ],
    "title": [
      "Default index files",
      "ملفات الفهرس الافتراضية"
    ],
    "lede": [
      "No default-index configuration has been read. File and ordering changes are unavailable.",
      "لم تُقرأ إعدادات ملفات الفهرس الافتراضية. تغييرات الملفات وترتيبها غير متاحة."
    ],
    "layout": "editor",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
