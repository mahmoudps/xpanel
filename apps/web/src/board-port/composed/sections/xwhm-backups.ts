import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xwhm_backups: readonly ComposedRoute[] = [
  {
    "route": "/whm/backups/destinations",
    "surface": "xwhm",
    "section": "backups",
    "group": msgid('Backups & transfers'),
    "title": msgid('Backup destinations'),
    "lede": msgid('Backup destinations data has not been read. Related actions remain unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/backups/restore",
    "surface": "xwhm",
    "section": "backups",
    "group": msgid('Backups & transfers'),
    "title": msgid('Restore accounts'),
    "lede": msgid('Select an account to read its available backup files. Restore actions require an authorized server response.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "backups"
  },
  {
    "route": "/whm/backups/restore-more",
    "surface": "xwhm",
    "section": "backups",
    "group": msgid('Backups & transfers'),
    "title": msgid('More restore tools'),
    "lede": msgid('More restore tools data has not been read. Related actions remain unavailable.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/backups/files",
    "surface": "xwhm",
    "section": "backups",
    "group": msgid('Backups & transfers'),
    "title": msgid('Restore files'),
    "lede": msgid('Backup files appear only after an authorized read for the selected account.'),
    "layout": "list",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "backups"
  },
  {
    "route": "/whm/transfers/convert-addon",
    "surface": "xwhm",
    "section": "backups",
    "group": msgid('Backups & transfers'),
    "title": msgid('Convert addon domain'),
    "lede": msgid('Convert addon domain data has not been read. Related actions remain unavailable.'),
    "layout": "wizard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  },
  {
    "route": "/whm/transfers/server",
    "surface": "xwhm",
    "section": "backups",
    "group": msgid('Backups & transfers'),
    "title": msgid('Server migration'),
    "lede": msgid('Server migration data has not been read. Related actions remain unavailable.'),
    "layout": "wizard",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
