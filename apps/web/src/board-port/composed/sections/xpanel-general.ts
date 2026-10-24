import type { ComposedRoute } from '../types.ts'

export const xpanel_general: readonly ComposedRoute[] = [
  {
    "route": "/server-information",
    "surface": "xpanel",
    "section": "general",
    "group": [
      "General",
      "عام"
    ],
    "title": [
      "Server information",
      "معلومات الخادم"
    ],
    "lede": [
      "Only explicitly read account information is shown. Missing measurements remain unavailable.",
      "تُعرض معلومات الحساب المقروءة صراحةً فقط. القياسات المفقودة تبقى غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "panel-usage"
  }
]
