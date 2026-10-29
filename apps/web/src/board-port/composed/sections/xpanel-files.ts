import '../../../i18n.ts'
import type { ComposedRoute } from '../types.ts'
export const xpanel_files: readonly ComposedRoute[] = [
  {
    "route": "/files/trash",
    "surface": "xpanel",
    "section": "files",
    "group": msgid('Files'),
    "title": msgctxt('xpanel-files', 'Trash'),
    "lede": msgid('Use the existing authorized account screen. This route does not create a second operation controller.'),
    "layout": "files",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "trash"
  },
  {
    "route": "/files/web-disk",
    "surface": "xpanel",
    "section": "files",
    "group": msgid('Files'),
    "title": msgid('Web Disk'),
    "lede": msgid('Stored WebDisk logins and directories are shown only after an authorized read. Access changes are unavailable.'),
    "layout": "files",
    "action": null,
    "columns": [
      msgid('Login'),
      msgid('Directory')
    ],
    "fields": [],
    "bind": "webdisk"
  },
  {
    "route": "/files/ftp",
    "surface": "xpanel",
    "section": "files",
    "group": msgid('Files'),
    "title": msgid('FTP accounts'),
    "lede": msgid('Use the existing authorized account screen. This route does not create a second operation controller.'),
    "layout": "files",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "ftp"
  },
  {
    "route": "/files/git",
    "surface": "xpanel",
    "section": "files",
    "group": msgid('Files'),
    "title": msgid('Git & deployments'),
    "lede": msgid('Git & deployments is unavailable. No operation has been started and no result has been read.'),
    "layout": "settings",
    "action": null,
    "columns": [],
    "fields": [],
    "bind": "soon"
  }
]
