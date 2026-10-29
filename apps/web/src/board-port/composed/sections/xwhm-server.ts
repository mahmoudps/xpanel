import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_server: readonly ComposedRoute[] = [
  {
    "route": "/whm/server/terminal",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('Terminal'),
    "lede": msgid('Server terminal access is unavailable until a dedicated server session is connected and qualified. No command is sent from this screen.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/file-sharing",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('File sharing links'),
    "lede": msgid('No server file-sharing inventory has been read. Creating or changing sharing links is unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/networking",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('Networking'),
    "lede": msgid('No network configuration has been read. Hostname, resolver and tunnel changes are unavailable.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/ips",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('IP addresses'),
    "lede": msgid('IP address management remains in the existing authorized IP view. This composition does not enable address changes.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/trusted-proxies",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('Trusted proxies'),
    "lede": msgid('No trusted-proxy configuration has been read. Proxy and client-address trust changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/cron",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('Scheduled tasks'),
    "lede": msgid('No server schedule has been read. Creating schedules or running server commands is unavailable.'),
    "layout": "cron",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/nodes",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('Server nodes'),
    "lede": msgid('No linked-node inventory has been read. Node registration, transfer and configuration changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/server/role",
    "surface": "xwhm",
    "section": "server",
    "group": msgid('Server'),
    "title": msgid('Server role'),
    "lede": msgid('No server-role configuration has been read. Role changes are unavailable.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
