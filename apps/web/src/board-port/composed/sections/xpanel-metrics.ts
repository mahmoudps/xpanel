import type { ComposedRoute } from '../types.ts'

export const xpanel_metrics: readonly ComposedRoute[] = [
  {
    "route": "/metrics/logs",
    "surface": "xpanel",
    "section": "metrics",
    "group": [
      "Metrics",
      "المقاييس"
    ],
    "title": [
      "Logs",
      "السجلات"
    ],
    "lede": [
      "Logs is unavailable. No operation has been started and no result has been read.",
      "السجلات غير متاح. لم تبدأ أي عملية ولم تُقرأ نتيجة."
    ],
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/metrics/web-stats",
    "surface": "xpanel",
    "section": "metrics",
    "group": [
      "Metrics",
      "المقاييس"
    ],
    "title": [
      "Web statistics",
      "إحصاءات الويب"
    ],
    "lede": [
      "Use the existing authorized account screen. This route does not create a second operation controller.",
      "تُستخدم شاشة الحساب الحالية المصرّح بها. هذا المسار لا ينشئ وحدة تحكم ثانية للعمليات."
    ],
    "layout": "metrics",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "web-stats"
  }
]
