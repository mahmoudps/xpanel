import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_metrics: readonly ComposedRoute[] = [
  {
    "route": "/metrics/logs",
    "surface": "xpanel",
    "section": "metrics",
    "group": msgid('Metrics'),
    "title": msgid('Logs'),
    "lede": msgid('Logs is unavailable. No operation has been started and no result has been read.'),
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
    "group": msgid('Metrics'),
    "title": msgid('Web statistics'),
    "lede": msgid('Use the existing authorized account screen. This route does not create a second operation controller.'),
    "layout": "metrics",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "web-stats"
  }
]
