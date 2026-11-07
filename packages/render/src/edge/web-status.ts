// Web Server Status: Apache mod_status on a secret path and nginx stub_status on a root-only unix socket.
// Hosting accounts can reach the loopback Apache port, and the scoreboard shows other accounts' requests,
// so the path is an unguessable token kept in a file only root and the Apache master read.
import type { OsProfile, RenderedFile } from '@xpanel/core'
import { assertSafeAbsPath, invalid } from './validate.ts'

export const WEB_STATUS_NGINX_SOCKET = '/run/xpanel-nginx-status.sock'
const TOKEN = /^[0-9a-f]{32,128}$/
export const webStatusPath = (token: string): string => TOKEN.test(token) ? `/.xpanel-status-${token}` : invalid('web status token', '<redacted>', 'must be lowercase hexadecimal')

export const renderApacheStatus = (os: OsProfile, token: string): RenderedFile => ({
  path: `${assertSafeAbsPath(os.paths.apacheVhostDir, 'Apache vhost dir')}/000-xpanel-status.conf`,
  content: ['# Managed by xPanel: Web Server Status', '<IfModule mod_status.c>', 'ExtendedStatus On', `<Location "${webStatusPath(token)}">`, 'SetHandler server-status', 'Require local', '</Location>', '</IfModule>', ''].join('\n'),
  mode: 0o640, owner: 'root', group: 'root',
})

export const renderNginxStatus = (os: OsProfile): RenderedFile => ({
  path: `${assertSafeAbsPath(os.paths.nginxVhostDir, 'nginx vhost dir')}/000-xpanel-status.conf`,
  content: ['# Managed by xPanel: Web Server Status', 'server {', `    listen unix:${WEB_STATUS_NGINX_SOCKET};`, '    server_name _;', '    access_log off;', '    location = /status { stub_status; }', '    location / { return 404; }', '}', ''].join('\n'),
  mode: 0o644, owner: 'root', group: 'root',
})
