import type { ComposedRoute } from '../types.ts'

export const xwhm_home: readonly ComposedRoute[] = [
  {
    "route": "/whm/jobs",
    "surface": "xwhm",
    "section": "home",
    "group": [
      "Home",
      "الرئيسية"
    ],
    "title": [
      "Jobs",
      "المهام"
    ],
    "lede": [
      "Job history has not been read. No job status or completion is assumed.",
      "لم يُقرأ سجل المهام. لا تُفترض حالة أي مهمة أو اكتمالها."
    ],
    "layout": "cron",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/support",
    "surface": "xwhm",
    "section": "home",
    "group": [
      "Home",
      "الرئيسية"
    ],
    "title": [
      "Support",
      "الدعم"
    ],
    "lede": [
      "Support requests have not been read. Sending a request is unavailable.",
      "لم تُقرأ طلبات الدعم. إرسال طلب غير متاح."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
