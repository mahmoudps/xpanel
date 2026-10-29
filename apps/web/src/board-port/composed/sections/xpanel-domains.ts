import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_domains: readonly ComposedRoute[] = [
  {
    "route": "/domains/site-settings",
    "surface": "xpanel",
    "section": "domains",
    "group": msgid('Domains'),
    "title": msgid('Site settings'),
    "lede": msgid('Use the existing authorized account screen. This route does not create a second operation controller.'),
    "layout": "site",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "site-settings"
  },
  {
    "route": "/domains/staging",
    "surface": "xpanel",
    "section": "domains",
    "group": msgid('Domains'),
    "title": msgid('Staging sites'),
    "lede": msgid('Staging sites is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/redirects",
    "surface": "xpanel",
    "section": "domains",
    "group": msgid('Domains'),
    "title": msgid('Redirects'),
    "lede": msgid('Redirects is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/reverse-proxy",
    "surface": "xpanel",
    "section": "domains",
    "group": msgid('Domains'),
    "title": msgid('Reverse proxy'),
    "lede": msgid('Reverse proxy is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/dynamic-dns",
    "surface": "xpanel",
    "section": "domains",
    "group": msgid('Domains'),
    "title": msgid('Dynamic DNS'),
    "lede": msgid('Dynamic DNS is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/cloudflare",
    "surface": "xpanel",
    "section": "domains",
    "group": msgid('Domains'),
    "title": "Cloudflare",
    "lede": msgid('Cloudflare is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/domains/site-publisher",
    "surface": "xpanel",
    "section": "domains",
    "group": msgid('Domains'),
    "title": msgctxt('xpanel-domains', 'Site publisher'),
    "lede": msgid('Site publisher is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
