import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_general: readonly ComposedRoute[] = [
  {
    "route": "/server-information",
    "surface": "xpanel",
    "section": "general",
    "group": msgid('General'),
    "title": msgid('Server information'),
    "lede": msgid('Only explicitly read account information is shown. Missing measurements remain unavailable.'),
    "layout": "dashboard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "panel-usage"
  }
]
