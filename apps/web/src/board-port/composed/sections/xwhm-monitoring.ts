import type { ComposedRoute } from '../types.ts'

export const xwhm_monitoring: readonly ComposedRoute[] = [
  {
    "route": "/whm/monitoring/health",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Server health",
      "صحة الخادم"
    ],
    "lede": [
      "Server health data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات صحة الخادم. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/alerts",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Alerts",
      "التنبيهات"
    ],
    "lede": [
      "Alerts data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات التنبيهات. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/repair",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Repair center",
      "مركز الإصلاح"
    ],
    "lede": [
      "Repair center data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات مركز الإصلاح. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/performance",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Performance history",
      "سجل الأداء"
    ],
    "lede": [
      "Performance history data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات سجل الأداء. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/traffic",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Traffic monitor",
      "مراقبة الحركة"
    ],
    "lede": [
      "Traffic monitor data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات مراقبة الحركة. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/io",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "IO monitor",
      "مراقبة الإدخال والإخراج"
    ],
    "lede": [
      "Disk IO appears only when a measured host sample is available. Missing readings are not shown as zero.",
      "لا تُعرض عمليات القرص إلا عند توفر عينة مقاسة من المضيف. لا تُعرض القراءات المفقودة كصفر."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "io"
  },
  {
    "route": "/whm/monitoring/limits",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Resource limits",
      "حدود الموارد"
    ],
    "lede": [
      "Resource limits data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات حدود الموارد. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/processes",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Processes",
      "العمليات"
    ],
    "lede": [
      "Processes data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات العمليات. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/disk",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Disk usage",
      "استخدام القرص"
    ],
    "lede": [
      "Disk usage data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات استخدام القرص. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/logs",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Logs",
      "السجلات"
    ],
    "lede": [
      "Logs data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات السجلات. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "log",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/monitoring/server-info",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Server information",
      "معلومات الخادم"
    ],
    "lede": [
      "Host information appears only after an authorized server read. Missing readings remain unavailable.",
      "لا تُعرض معلومات المضيف إلا بعد قراءة مصرّح بها من الخادم. تبقى القراءات المفقودة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "host-info"
  },
  {
    "route": "/whm/monitoring/benchmark",
    "surface": "xwhm",
    "section": "monitoring",
    "group": [
      "Monitoring",
      "المراقبة"
    ],
    "title": [
      "Performance benchmark",
      "اختبار الأداء"
    ],
    "lede": [
      "Performance benchmark data has not been read. Related actions remain unavailable.",
      "لم تُقرأ بيانات اختبار الأداء. تبقى الإجراءات المرتبطة غير متاحة."
    ],
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
