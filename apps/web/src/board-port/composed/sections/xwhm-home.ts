import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_home: readonly ComposedRoute[] = [
  {
    "route": "/whm/jobs",
    "surface": "xwhm",
    "section": "home",
    "group": msgid('Home'),
    "title": msgid('Jobs'),
    "lede": msgid('Job history has not been read. No job status or completion is assumed.'),
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
    "group": msgid('Home'),
    "title": msgid('Support'),
    "lede": msgid('Support requests have not been read. Sending a request is unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
