import type { ComposedRoute } from '../types.ts'

export const xpanel_metrics: readonly ComposedRoute[] = [
  {
    route: "/metrics/logs",
    surface: "xpanel",
    section: "metrics",
    group: ["Metrics", "المقاييس"],
    title: ["Logs", "السجلات"],
    lede: ["Search, filter, tail and download your sites' access and error logs, scan them for attacks, and trace mail delivery.", "السجلات. لا تُعرض زيارات أو أخطاء أو نطاق قبل وجود سجلات، ولا تُملأ بالصفر."],
    template: "Metrics · Traffic & bandwidth/PanelMetrics.dc.html",
    layout: "metrics",
    action: null,
    columns: [["Path", "المسار"], ["Requests", "الطلبات"], ["Last seen (UTC)", "آخر ظهور (UTC)"]],
    fields: [["Name", "الاسم"], ["Value", "القيمة"]],
    bind: "soon",
  },
  {
    route: "/metrics/web-stats",
    surface: "xpanel",
    section: "metrics",
    group: ["Metrics", "المقاييس"],
    title: ["Web statistics", "إحصاءات الويب"],
    lede: ["Read monthly, daily and hourly traffic reports per domain and for FTP, and choose which log analyzers run for each domain.", "إحصاءات الويب. لا تُعرض زيارات أو أخطاء أو نطاق قبل وجود سجلات، ولا تُملأ بالصفر."],
    template: "Metrics · Traffic & bandwidth/PanelMetrics.dc.html",
    layout: "metrics",
    action: null,
    columns: [["Path", "المسار"], ["Requests", "الطلبات"], ["Last seen (UTC)", "آخر ظهور (UTC)"]],
    fields: [["Name", "الاسم"], ["Value", "القيمة"]],
    bind: "web-stats",
  },
]
