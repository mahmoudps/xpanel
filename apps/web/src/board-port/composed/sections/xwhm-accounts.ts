import type { ComposedRoute } from '../types.ts'

export const xwhm_accounts: readonly ComposedRoute[] = [
  {
    "route": "/whm/accounts/health",
    "surface": "xwhm",
    "section": "accounts",
    "group": [
      "Accounts",
      "الحسابات"
    ],
    "title": [
      "Account health & repair",
      "صحة الحسابات وإصلاحها"
    ],
    "lede": [
      "Stored account status can be shown after an authorized read. Health assessments and repairs are unavailable.",
      "تُعرض حالة الحسابات المحفوظة بعد قراءة مصرّح بها. تقييم الصحة والإصلاح غير متاحين."
    ],
    "layout": "list",
    "action": null,
    "columns": [
      [
        "Account",
        "الحساب"
      ],
      [
        "Domain",
        "النطاق"
      ],
      [
        "Status",
        "الحالة"
      ],
      [
        "Reading",
        "القراءة"
      ]
    ],
    "fields": [],
    "bind": "accounts"
  },
  {
    "route": "/whm/accounts/bandwidth",
    "surface": "xwhm",
    "section": "accounts",
    "group": [
      "Accounts",
      "الحسابات"
    ],
    "title": [
      "Bandwidth",
      "النطاق الترددي"
    ],
    "lede": [
      "Stored account names and domains can be shown after an authorized read. Bandwidth is not measured.",
      "تُعرض أسماء الحسابات ونطاقاتها بعد قراءة مصرّح بها. النطاق الترددي غير مقاس."
    ],
    "layout": "list",
    "action": null,
    "columns": [
      [
        "Account",
        "الحساب"
      ],
      [
        "Domain",
        "النطاق"
      ],
      [
        "Status",
        "الحالة"
      ],
      [
        "Bandwidth",
        "النطاق الترددي"
      ]
    ],
    "fields": [],
    "bind": "accounts"
  },
  {
    "route": "/whm/accounts/announcements",
    "surface": "xwhm",
    "section": "accounts",
    "group": [
      "Accounts",
      "الحسابات"
    ],
    "title": [
      "Announcements",
      "الإعلانات"
    ],
    "lede": [
      "Announcement history has not been read. Sending announcements is unavailable.",
      "لم يُقرأ سجل الإعلانات. إرسال الإعلانات غير متاح."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/accounts/templates",
    "surface": "xwhm",
    "section": "accounts",
    "group": [
      "Accounts",
      "الحسابات"
    ],
    "title": [
      "Templates",
      "القوالب"
    ],
    "lede": [
      "Account templates have not been read. Editing templates is unavailable.",
      "لم تُقرأ قوالب الحسابات. تحرير القوالب غير متاح."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
