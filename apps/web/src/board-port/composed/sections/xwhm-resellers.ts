import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_resellers: readonly ComposedRoute[] = [
  {
    "route": "/whm/resellers/more",
    "surface": "xwhm",
    "section": "resellers",
    "group": msgid('Resellers'),
    "title": msgid('More reseller tools'),
    "lede": msgid('Only loaded, stored reseller account limits and nameserver records are shown. Usage and bulk ownership changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [
      msgid('Reseller'),
      msgid('Account limit'),
      msgid('Nameservers')
    ],
    "fields": [],
    "bind": "resellers"
  },
  {
    "route": "/whm/resellers/privileges",
    "surface": "xwhm",
    "section": "resellers",
    "group": msgid('Resellers'),
    "title": msgid('Reseller privileges'),
    "lede": msgid('Only loaded, stored reseller ACL values are shown. This view does not change privileges.'),
    "layout": "matrix",
    "action": null,
    "columns": [
      msgid('Reseller'),
      msgid('Privileges')
    ],
    "fields": [],
    "bind": "reseller-acl"
  },
  {
    "route": "/whm/resellers/ips-nameservers",
    "surface": "xwhm",
    "section": "resellers",
    "group": msgid('Resellers'),
    "title": msgid('IPs & nameservers'),
    "lede": msgid('Only loaded reseller nameserver and account-limit records are shown. IP delegation changes are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [
      msgid('Reseller'),
      msgid('Account limit'),
      msgid('Nameservers')
    ],
    "fields": [],
    "bind": "resellers"
  }
]
