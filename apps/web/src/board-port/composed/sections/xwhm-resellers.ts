import type { ComposedRoute } from '../types.ts'

export const xwhm_resellers: readonly ComposedRoute[] = [
  {
    "route": "/whm/resellers/more",
    "surface": "xwhm",
    "section": "resellers",
    "group": [
      "Resellers",
      "الموزعون"
    ],
    "title": [
      "More reseller tools",
      "أدوات الموزعين الإضافية"
    ],
    "lede": [
      "Only loaded, stored reseller account limits and nameserver records are shown. Usage and bulk ownership changes are unavailable.",
      "تظهر فقط حدود الحسابات وخوادم الأسماء المحفوظة للموزعين التي جرت قراءتها. قياسات الاستخدام وتغييرات الملكية الجماعية غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [
      [
        "Reseller",
        "الموزع"
      ],
      [
        "Account limit",
        "حد الحسابات"
      ],
      [
        "Nameservers",
        "خوادم الأسماء"
      ]
    ],
    "fields": [],
    "bind": "resellers"
  },
  {
    "route": "/whm/resellers/privileges",
    "surface": "xwhm",
    "section": "resellers",
    "group": [
      "Resellers",
      "الموزعون"
    ],
    "title": [
      "Reseller privileges",
      "صلاحيات الموزعين"
    ],
    "lede": [
      "Only loaded, stored reseller ACL values are shown. This view does not change privileges.",
      "تظهر فقط الصلاحيات المحفوظة للموزعين التي جرت قراءتها. لا تغيّر هذه الواجهة الصلاحيات."
    ],
    "layout": "matrix",
    "action": null,
    "columns": [
      [
        "Reseller",
        "الموزع"
      ],
      [
        "Privileges",
        "الصلاحيات"
      ]
    ],
    "fields": [],
    "bind": "reseller-acl"
  },
  {
    "route": "/whm/resellers/ips-nameservers",
    "surface": "xwhm",
    "section": "resellers",
    "group": [
      "Resellers",
      "الموزعون"
    ],
    "title": [
      "IPs & nameservers",
      "عناوين IP وخوادم الأسماء"
    ],
    "lede": [
      "Only loaded reseller nameserver and account-limit records are shown. IP delegation changes are unavailable.",
      "تظهر فقط سجلات خوادم الأسماء وحدود الحسابات للموزعين التي جرت قراءتها. تغييرات تفويض عناوين IP غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [
      [
        "Reseller",
        "الموزع"
      ],
      [
        "Account limit",
        "حد الحسابات"
      ],
      [
        "Nameservers",
        "خوادم الأسماء"
      ]
    ],
    "fields": [],
    "bind": "resellers"
  }
]
