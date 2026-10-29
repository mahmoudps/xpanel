import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_databases: readonly ComposedRoute[] = [
  {
    "route": "/databases/phpmyadmin",
    "surface": "xpanel",
    "section": "databases",
    "group": msgid('Databases'),
    "title": "phpMyAdmin",
    "lede": msgid('phpMyAdmin is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/databases/insights",
    "surface": "xpanel",
    "section": "databases",
    "group": msgid('Databases'),
    "title": msgid('Database insights'),
    "lede": msgid('Database insights is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/databases/remote-access",
    "surface": "xpanel",
    "section": "databases",
    "group": msgid('Databases'),
    "title": msgctxt('xpanel-databases', 'Remote database access'),
    "lede": msgid('Remote database access is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/databases/postgresql",
    "surface": "xpanel",
    "section": "databases",
    "group": msgid('Databases'),
    "title": msgid('PostgreSQL databases'),
    "lede": msgid('PostgreSQL database management is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/databases/phppgadmin",
    "surface": "xpanel",
    "section": "databases",
    "group": msgid('Databases'),
    "title": "phpPgAdmin",
    "lede": msgid('phpPgAdmin is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
