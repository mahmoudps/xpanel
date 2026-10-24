import type { ComposedRoute } from '../types.ts'

export const xpanel_files: readonly ComposedRoute[] = [
  {
    "route": "/files/trash",
    "surface": "xpanel",
    "section": "files",
    "group": [
      "Files",
      "الملفات"
    ],
    "title": [
      "Trash",
      "سلة المحذوفات"
    ],
    "lede": [
      "Use the existing authorized account screen. This route does not create a second operation controller.",
      "تُستخدم شاشة الحساب الحالية المصرّح بها. هذا المسار لا ينشئ وحدة تحكم ثانية للعمليات."
    ],
    "layout": "files",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "trash"
  },
  {
    "route": "/files/web-disk",
    "surface": "xpanel",
    "section": "files",
    "group": [
      "Files",
      "الملفات"
    ],
    "title": [
      "Web Disk",
      "القرص الشبكي"
    ],
    "lede": [
      "Stored WebDisk logins and directories are shown only after an authorized read. Access changes are unavailable.",
      "تُعرض أسماء دخول WebDisk ومجلداتها المحفوظة بعد قراءة مصرّح بها فقط. تغيير الوصول غير متاح."
    ],
    "layout": "files",
    "action": null,
    "columns": [
      [
        "Login",
        "اسم الدخول"
      ],
      [
        "Directory",
        "المجلد"
      ]
    ],
    "fields": [],
    "bind": "webdisk"
  },
  {
    "route": "/files/ftp",
    "surface": "xpanel",
    "section": "files",
    "group": [
      "Files",
      "الملفات"
    ],
    "title": [
      "FTP accounts",
      "حسابات FTP"
    ],
    "lede": [
      "Use the existing authorized account screen. This route does not create a second operation controller.",
      "تُستخدم شاشة الحساب الحالية المصرّح بها. هذا المسار لا ينشئ وحدة تحكم ثانية للعمليات."
    ],
    "layout": "files",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "ftp"
  },
  {
    "route": "/files/git",
    "surface": "xpanel",
    "section": "files",
    "group": [
      "Files",
      "الملفات"
    ],
    "title": [
      "Git & deployments",
      "Git والنشر"
    ],
    "lede": [
      "Git & deployments is unavailable. No operation has been started and no result has been read.",
      "Git والنشر غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
