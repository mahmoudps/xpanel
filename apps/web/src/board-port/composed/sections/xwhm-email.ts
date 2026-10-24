import type { ComposedRoute } from '../types.ts'

export const xwhm_email: readonly ComposedRoute[] = [
  {
    "route": "/whm/email/monitor",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mail monitor",
      "مراقبة البريد"
    ],
    "lede": [
      "Mail monitor data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات مراقبة البريد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/queue",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mail queue",
      "طابور البريد"
    ],
    "lede": [
      "Mail queue data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات طابور البريد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "log",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/delivery",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Delivery reports",
      "تقارير التسليم"
    ],
    "lede": [
      "Delivery reports data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات تقارير التسليم. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "log",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/outbound",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Outbound spam protection",
      "الحماية من البريد المزعج الصادر"
    ],
    "lede": [
      "Outbound mail settings appear only after an authorized configuration read. Unavailable settings cannot be applied.",
      "لا تُعرض إعدادات البريد الصادر إلا بعد قراءة مصرّح بها للإعدادات. لا يمكن تطبيق الإعدادات غير المتاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "mail-ips"
  },
  {
    "route": "/whm/email/spam",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Inbound spam protection",
      "الحماية من البريد المزعج الوارد"
    ],
    "lede": [
      "Inbound spam protection data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات الحماية من البريد المزعج الوارد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/quality",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mail quality",
      "جودة البريد"
    ],
    "lede": [
      "Mail quality data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات جودة البريد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/routing",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mail routing",
      "توجيه البريد"
    ],
    "lede": [
      "Mail routing data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات توجيه البريد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "log",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/relay",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "SMTP relay",
      "مرحّل SMTP"
    ],
    "lede": [
      "SMTP relay data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات مرحّل SMTP. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/server",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mail server",
      "خادم البريد"
    ],
    "lede": [
      "Mail server data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات خادم البريد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/maintenance",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mailbox maintenance",
      "صيانة صناديق البريد"
    ],
    "lede": [
      "Mailbox maintenance data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات صيانة صناديق البريد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "log",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/bcc",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mail BCC copies",
      "نسخ البريد الإدارية BCC"
    ],
    "lede": [
      "Mail BCC copies data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات نسخ البريد الإدارية BCC. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "log",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/email/marketing",
    "surface": "xwhm",
    "section": "email",
    "group": [
      "Email",
      "البريد الإلكتروني"
    ],
    "title": [
      "Mail campaigns & automation",
      "حملات البريد والأتمتة"
    ],
    "lede": [
      "Mail campaigns & automation data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات حملات البريد والأتمتة. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "log",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
