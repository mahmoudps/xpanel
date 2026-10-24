import type { ComposedRoute } from '../types.ts'

export const xwhm_server: readonly ComposedRoute[] = [
  {
    "route": "/whm/server/terminal",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "Terminal",
      "الطرفية"
    ],
    "lede": [
      "Server terminal access is unavailable until a dedicated server session is connected and qualified. No command is sent from this screen.",
      "وصول طرفية الخادم غير متاح حتى توصيل جلسة خاصة بالخادم والتحقق منها. لا ترسل هذه الشاشة أوامر."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/file-sharing",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "File sharing links",
      "روابط مشاركة الملفات"
    ],
    "lede": [
      "No server file-sharing inventory has been read. Creating or changing sharing links is unavailable.",
      "لم يُقرأ مخزون مشاركة ملفات الخادم. إنشاء روابط المشاركة أو تغييرها غير متاح."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/networking",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "Networking",
      "الشبكة"
    ],
    "lede": [
      "No network configuration has been read. Hostname, resolver and tunnel changes are unavailable.",
      "لم تُقرأ إعدادات الشبكة. تغييرات اسم المضيف والمحلل والأنفاق غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/ips",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "IP addresses",
      "عناوين IP"
    ],
    "lede": [
      "IP address management remains in the existing authorized IP view. This composition does not enable address changes.",
      "تبقى إدارة عناوين IP في واجهتها الحالية المصرح بها. لا تفعّل هذه الشاشة تغييرات العناوين."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/trusted-proxies",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "Trusted proxies",
      "الوكلاء الموثوقون"
    ],
    "lede": [
      "No trusted-proxy configuration has been read. Proxy and client-address trust changes are unavailable.",
      "لم تُقرأ إعدادات الوكلاء الموثوقين. تغييرات الثقة بالوكلاء وعنوان العميل غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/cron",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "Scheduled tasks",
      "المهام المجدولة"
    ],
    "lede": [
      "No server schedule has been read. Creating schedules or running server commands is unavailable.",
      "لم يُقرأ جدول مهام الخادم. إنشاء الجداول أو تشغيل أوامر الخادم غير متاح."
    ],
    "layout": "cron",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/nodes",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "Server nodes",
      "عُقد الخوادم"
    ],
    "lede": [
      "No linked-node inventory has been read. Node registration, transfer and configuration changes are unavailable.",
      "لم يُقرأ مخزون العقد المرتبطة. تسجيل العقد والنقل وتغييرات الإعدادات غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/role",
    "surface": "xwhm",
    "section": "server",
    "group": [
      "Server",
      "الخادم"
    ],
    "title": [
      "Server role",
      "دور الخادم"
    ],
    "lede": [
      "No server-role configuration has been read. Role changes are unavailable.",
      "لم تُقرأ إعدادات دور الخادم. تغييرات الدور غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
