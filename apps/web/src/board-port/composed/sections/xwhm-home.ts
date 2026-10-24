import type { ComposedRoute } from '../types.ts'

export const xwhm_home: readonly ComposedRoute[] = [
  {
    route: "/whm/jobs",
    surface: "xwhm",
    section: "home",
    group: ["Home", "الرئيسية"],
    title: ["Jobs", "المهام"],
    lede: ["Every long operation as a job with steps, progress, heartbeat, log and result, for root and for a reseller's own jobs.", "المهام. لا مهمة تعمل من قائمة فارغة. النموذج المعطّل لا يحفظ جدولاً."],
    template: "Advanced · Cron jobs/PanelCron.dc.html",
    layout: "cron",
    action: null,
    columns: [["Setting", "الإعداد"], ["Value", "القيمة"]],
    fields: [["Minute", "الدقيقة"], ["Hour", "الساعة"], ["Command", "الأمر"]],
    bind: "soon",
  },
  {
    route: "/whm/support",
    surface: "xwhm",
    section: "home",
    group: ["Home", "الرئيسية"],
    title: ["Support", "الدعم"],
    lede: ["Help resources the provider configured, documentation links and error-report sharing settings.", "الدعم. الجدول يعرض ما أعادته القراءة فقط. الإجراءات غير الموصولة تبقى معطّلة."],
    template: "Home · Dashboard/WhmDashboard.dc.html",
    layout: "list",
    action: null,
    columns: [["Name", "الاسم"], ["Status", "الحالة"]],
    fields: [["Name", "الاسم"], ["Value", "القيمة"]],
    bind: "soon",
  },
]
