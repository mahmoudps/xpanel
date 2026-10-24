import type { ComposedRoute } from '../types.ts'

export const xpanel_general: readonly ComposedRoute[] = [
  {
    route: "/server-information",
    surface: "xpanel",
    section: "general",
    group: ["General", "عام"],
    title: ["Server information", "معلومات الخادم"],
    lede: ["Read your plan, the server's software versions and the live status of each service your sites depend on.", "معلومات الخادم. المقاييس تبقى فارغة إلى أن يبلغ المضيف. لا تُملأ بالصفر."],
    template: "General · Resources & quotas/PanelResources.dc.html",
    layout: "dashboard",
    action: null,
    columns: [["Name", "الاسم"], ["Status", "الحالة"]],
    fields: [["Name", "الاسم"], ["Value", "القيمة"]],
    bind: "panel-usage",
  },
]
