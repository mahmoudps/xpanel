import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_plans: readonly ComposedRoute[] = [
  {
    "route": "/whm/plans/enhancements",
    "surface": "xwhm",
    "section": "plans",
    "group": msgid('Plans'),
    "title": msgid('Account enhancements'),
    "lede": msgid('No enhancement-assignment state has been read. Assignment and per-reseller entitlement controls are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
