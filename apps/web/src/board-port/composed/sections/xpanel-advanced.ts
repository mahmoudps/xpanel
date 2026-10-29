import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_advanced: readonly ComposedRoute[] = [
  {
    "route": "/advanced/terminal",
    "surface": "xpanel",
    "section": "advanced",
    "group": msgid('Advanced'),
    "title": msgid('Terminal'),
    "lede": msgid('Use the existing authorized account screen. This route does not create a second operation controller.'),
    "layout": "terminal",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "terminal"
  },
  {
    "route": "/advanced/network-tools",
    "surface": "xpanel",
    "section": "advanced",
    "group": msgid('Advanced'),
    "title": msgid('Network tools'),
    "lede": msgid('Network tools is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/advanced/indexes",
    "surface": "xpanel",
    "section": "advanced",
    "group": msgid('Advanced'),
    "title": msgid('Directory indexes'),
    "lede": msgid('Directory indexes is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/advanced/error-pages",
    "surface": "xpanel",
    "section": "advanced",
    "group": msgid('Advanced'),
    "title": msgid('Error pages'),
    "lede": msgid('Error pages is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/advanced/handlers",
    "surface": "xpanel",
    "section": "advanced",
    "group": msgid('Advanced'),
    "title": msgid('Apache handlers'),
    "lede": msgid('Apache handlers is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/advanced/mime-types",
    "surface": "xpanel",
    "section": "advanced",
    "group": msgid('Advanced'),
    "title": msgid('MIME types'),
    "lede": msgid('MIME types is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/advanced/api-shell",
    "surface": "xpanel",
    "section": "advanced",
    "group": msgid('Advanced'),
    "title": msgid('API shell'),
    "lede": msgid('API shell is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
