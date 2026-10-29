import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_services: readonly ComposedRoute[] = [
  {
    "route": "/whm/services/more",
    "surface": "xwhm",
    "section": "services",
    "group": msgid('Services'),
    "title": msgctxt('xwhm-services', 'More service tools'),
    "lede": msgid('No extended service inventory has been read. Startup, supervision and reboot operations are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/health",
    "surface": "xwhm",
    "section": "services",
    "group": msgid('Services'),
    "title": msgctxt('xwhm-services', 'Configuration health'),
    "lede": msgid('Configuration-health checks are unavailable. A running service is not a configuration-drift result, and no repair is performed here.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/ftp",
    "surface": "xwhm",
    "section": "services",
    "group": msgid('Services'),
    "title": msgid('FTP server'),
    "lede": msgid('No FTP-service configuration has been read. Daemon, port and access changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/dns",
    "surface": "xwhm",
    "section": "services",
    "group": msgid('Services'),
    "title": msgid('DNS server'),
    "lede": msgid('No DNS-service configuration has been read. Daemon changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/certificates",
    "surface": "xwhm",
    "section": "services",
    "group": msgid('Services'),
    "title": msgid('Service certificates'),
    "lede": msgid('No service-certificate inventory has been read. Certificate and TLS-policy changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/ftp-log-analysis",
    "surface": "xwhm",
    "section": "services",
    "group": msgid('Services'),
    "title": msgid('FTP log analysis'),
    "lede": msgid('No FTP activity report has been read. Log analysis is unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/services/default-index",
    "surface": "xwhm",
    "section": "services",
    "group": msgid('Services'),
    "title": msgid('Default index files'),
    "lede": msgid('No default-index configuration has been read. File and ordering changes are unavailable.'),
    "layout": "editor",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
