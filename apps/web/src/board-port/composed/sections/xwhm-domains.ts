import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_domains: readonly ComposedRoute[] = [
  {
    "route": "/whm/dns/more",
    "surface": "xwhm",
    "section": "domains",
    "group": msgid('Domains, DNS & SSL'),
    "title": msgid('More DNS tools'),
    "lede": msgid('More DNS tools data has not been read. Related actions remain unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/ssl/install",
    "surface": "xwhm",
    "section": "domains",
    "group": msgid('Domains, DNS & SSL'),
    "title": msgctxt('xwhm-domains', 'Install certificate'),
    "lede": msgid('Install certificate data has not been read. Related actions remain unavailable.'),
    "layout": "ssl",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/dns/providers",
    "surface": "xwhm",
    "section": "domains",
    "group": msgid('Domains, DNS & SSL'),
    "title": msgid('Cloudflare & DNS providers'),
    "lede": msgid('Cloudflare & DNS providers data has not been read. Related actions remain unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/dns/cluster",
    "surface": "xwhm",
    "section": "domains",
    "group": msgid('Domains, DNS & SSL'),
    "title": msgid('DNS cluster'),
    "lede": msgid('DNS cluster data has not been read. Related actions remain unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
