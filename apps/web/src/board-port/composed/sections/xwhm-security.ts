import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_security: readonly ComposedRoute[] = [
  {
    "route": "/whm/security/intrusion",
    "surface": "xwhm",
    "section": "security",
    "group": msgid('Security center'),
    "title": msgid('Intrusion detection'),
    "lede": msgid('No intrusion-detection report has been read. Ban changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/flood",
    "surface": "xwhm",
    "section": "security",
    "group": msgid('Security center'),
    "title": msgid('Flood protection'),
    "lede": msgid('No connection or flood-protection configuration has been read. Rule changes are unavailable.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/waf",
    "surface": "xwhm",
    "section": "security",
    "group": msgid('Security center'),
    "title": msgid('Web application firewall'),
    "lede": msgid('No web-application firewall configuration has been read. Rule and vendor changes are unavailable.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/isolation",
    "surface": "xwhm",
    "section": "security",
    "group": msgid('Security center'),
    "title": msgid('Account isolation'),
    "lede": msgid('No account-isolation report has been read. Isolation and shell-policy changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/antivirus",
    "surface": "xwhm",
    "section": "security",
    "group": msgid('Security center'),
    "title": msgid('Antivirus'),
    "lede": msgid('No antivirus report or configuration has been read. Scans and configuration changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/panel-access",
    "surface": "xwhm",
    "section": "security",
    "group": msgid('Security center'),
    "title": msgid('Panel access'),
    "lede": msgid('No global panel-access configuration has been read. Listener and access-policy changes are unavailable.'),
    "layout": "security",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/security/sign-in",
    "surface": "xwhm",
    "section": "security",
    "group": msgid('Security center'),
    "title": msgid('Sign-in & 2FA'),
    "lede": msgid('Personal sign-in security remains in the existing account-security view. Global sign-in policy changes are unavailable here.'),
    "layout": "security",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
