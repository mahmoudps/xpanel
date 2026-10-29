import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_security: readonly ComposedRoute[] = [
  {
    "route": "/security/ssl/issue",
    "surface": "xpanel",
    "section": "security",
    "group": msgid('Security'),
    "title": msgid('Issue certificate'),
    "lede": msgid('Use the existing authorized account screen. This route does not create a second operation controller.'),
    "layout": "ssl",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "ssl-issue"
  },
  {
    "route": "/security/ssl/files",
    "surface": "xpanel",
    "section": "security",
    "group": msgid('Security'),
    "title": msgid('Certificate files'),
    "lede": msgid('Stored domain certificate assignments can be read. Certificate and private-key contents are unavailable.'),
    "layout": "ssl",
    "action": null,
    "columns": [
      msgid('Domain'),
      msgid('Certificate assignment')
    ],
    "fields": [],
    "bind": "ssl-files"
  },
  {
    "route": "/security/waf",
    "surface": "xpanel",
    "section": "security",
    "group": msgid('Security'),
    "title": msgid('Web application firewall'),
    "lede": msgid('Web application firewall is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/ip-blocker",
    "surface": "xpanel",
    "section": "security",
    "group": msgid('Security'),
    "title": msgctxt('xpanel-security', 'IP blocker'),
    "lede": msgid('IP blocker is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/hotlink",
    "surface": "xpanel",
    "section": "security",
    "group": msgid('Security'),
    "title": msgctxt('xpanel-security', 'Hotlink protection'),
    "lede": msgid('Hotlink protection is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/ssh",
    "surface": "xpanel",
    "section": "security",
    "group": msgid('Security'),
    "title": msgid('SSH access'),
    "lede": msgid('SSH access is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/security/virus-scanner",
    "surface": "xpanel",
    "section": "security",
    "group": msgid('Security'),
    "title": msgid('Virus scanner'),
    "lede": msgid('Virus scanner is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
