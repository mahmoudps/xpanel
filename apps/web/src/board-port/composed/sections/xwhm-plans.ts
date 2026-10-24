import type { ComposedRoute } from '../types.ts'

export const xwhm_plans: readonly ComposedRoute[] = [
  {
    route: "/whm/plans/enhancements",
    surface: "xwhm",
    section: "plans",
    group: ["Plans", "الخطط"],
    title: ["Account enhancements", "المزايا الإضافية للحسابات"],
    lede: ["Entitlement flags assigned to accounts independently of their plan, with per-reseller caps.", "المزايا الإضافية للحسابات. الجدول يعرض ما أعادته القراءة فقط. الإجراءات غير الموصولة تبقى معطّلة."],
    template: "Plans · Plans/WhmPlans.dc.html",
    layout: "list",
    action: ["Assign enhancement", "إسناد ميزة"],
    columns: [["Name", "الاسم"], ["Status", "الحالة"]],
    fields: [["Name", "الاسم"], ["Value", "القيمة"]],
    bind: "soon",
  },
]
