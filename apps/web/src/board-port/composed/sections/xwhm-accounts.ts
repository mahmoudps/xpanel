import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_accounts: readonly ComposedRoute[] = [
  {
    "route": "/whm/accounts/health",
    "surface": "xwhm",
    "section": "accounts",
    "group": msgid('Accounts'),
    "title": msgid('Account health & repair'),
    "lede": msgid('Stored account status can be shown after an authorized read. Health assessments and repairs are unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [
      msgid('Account'),
      msgid('Domain'),
      msgid('Status'),
      msgctxt('xwhm-accounts', 'Reading')
    ],
    "fields": [],
    "bind": "accounts"
  },
  {
    "route": "/whm/accounts/bandwidth",
    "surface": "xwhm",
    "section": "accounts",
    "group": msgid('Accounts'),
    "title": msgid('Bandwidth'),
    "lede": msgid('Stored account names and domains can be shown after an authorized read. Bandwidth is not measured.'),
    "layout": "list",
    "action": null,
    "columns": [
      msgid('Account'),
      msgid('Domain'),
      msgid('Status'),
      msgid('Bandwidth')
    ],
    "fields": [],
    "bind": "accounts"
  },
  {
    "route": "/whm/accounts/announcements",
    "surface": "xwhm",
    "section": "accounts",
    "group": msgid('Accounts'),
    "title": msgid('Announcements'),
    "lede": msgid('Announcement history has not been read. Sending announcements is unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/accounts/templates",
    "surface": "xwhm",
    "section": "accounts",
    "group": msgid('Accounts'),
    "title": msgid('Templates'),
    "lede": msgid('Account templates have not been read. Editing templates is unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
