import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_software: readonly ComposedRoute[] = [
  {
    "route": "/software/installer",
    "surface": "xpanel",
    "section": "software",
    "group": msgid('Software'),
    "title": msgid('App installer'),
    "lede": msgid('App installer is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/software/apps",
    "surface": "xpanel",
    "section": "software",
    "group": msgid('Software'),
    "title": msgid('Applications'),
    "lede": msgid('Application management is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/software/containers",
    "surface": "xpanel",
    "section": "software",
    "group": msgid('Software'),
    "title": msgid('Containers'),
    "lede": msgid('Container management is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/software/cache",
    "surface": "xpanel",
    "section": "software",
    "group": msgid('Software'),
    "title": msgid('Redis & Memcached'),
    "lede": msgid('Redis & Memcached management is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/software/optimize",
    "surface": "xpanel",
    "section": "software",
    "group": msgid('Software'),
    "title": msgid('Optimize website'),
    "lede": msgid('Website optimization is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/software/packages",
    "surface": "xpanel",
    "section": "software",
    "group": msgid('Software'),
    "title": msgid('Packages & modules'),
    "lede": msgid('Packages & modules is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
