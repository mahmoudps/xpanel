import type { ComposedRoute } from '../types.ts'

export const xwhm_backups: readonly ComposedRoute[] = [
  {
    "route": "/whm/backups/destinations",
    "surface": "xwhm",
    "section": "backups",
    "group": [
      "Backups & transfers",
      "النسخ الاحتياطي والنقل"
    ],
    "title": [
      "Backup destinations",
      "وجهات النسخ الاحتياطي"
    ],
    "lede": [
      "Backup destinations data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات وجهات النسخ الاحتياطي. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/backups/restore",
    "surface": "xwhm",
    "section": "backups",
    "group": [
      "Backups & transfers",
      "النسخ الاحتياطي والنقل"
    ],
    "title": [
      "Restore accounts",
      "استعادة الحسابات"
    ],
    "lede": [
      "Select an account to read its available backup files. Restore actions require an authorized server response.",
      "اختر حسابًا لقراءة ملفات النسخ المتاحة له. تتطلب الاستعادة استجابة مصرّحًا بها من الخادم."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "backups"
  },
  {
    "route": "/whm/backups/restore-more",
    "surface": "xwhm",
    "section": "backups",
    "group": [
      "Backups & transfers",
      "النسخ الاحتياطي والنقل"
    ],
    "title": [
      "More restore tools",
      "أدوات استعادة إضافية"
    ],
    "lede": [
      "More restore tools data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات أدوات استعادة إضافية. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/backups/files",
    "surface": "xwhm",
    "section": "backups",
    "group": [
      "Backups & transfers",
      "النسخ الاحتياطي والنقل"
    ],
    "title": [
      "Restore files",
      "استعادة الملفات"
    ],
    "lede": [
      "Backup files appear only after an authorized read for the selected account.",
      "لا تُعرض ملفات النسخ إلا بعد قراءة مصرّح بها للحساب المحدد."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "backups"
  },
  {
    "route": "/whm/transfers/convert-addon",
    "surface": "xwhm",
    "section": "backups",
    "group": [
      "Backups & transfers",
      "النسخ الاحتياطي والنقل"
    ],
    "title": [
      "Convert addon domain",
      "تحويل نطاق إضافي إلى حساب"
    ],
    "lede": [
      "Convert addon domain data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات تحويل نطاق إضافي إلى حساب. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "wizard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/transfers/server",
    "surface": "xwhm",
    "section": "backups",
    "group": [
      "Backups & transfers",
      "النسخ الاحتياطي والنقل"
    ],
    "title": [
      "Server migration",
      "ترحيل الخادم"
    ],
    "lede": [
      "Server migration data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات ترحيل الخادم. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "wizard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
