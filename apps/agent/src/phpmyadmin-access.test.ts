import { describe, expect, it } from 'vitest'
import { profileFor } from '@xpanel/os'
import { readDbSignonStatus } from './db-signon.ts'
import { PMA_ACCESS_DEFAULTS, compilePhpMyAdminAccess, parsePhpMyAdminAccess, phpMyAdminPorts, phpMyAdminRestartActions, renderPhpMyAdminFpm, renderPhpMyAdminNginx } from './phpmyadmin-access.ts'
import type { PhpMyAdminHostObservation } from './phpmyadmin-access.ts'

const debian = profileFor('ID=ubuntu\nVERSION_ID=22.04'), el = profileFor('ID=almalinux\nVERSION_ID=9.4')
const host = (access: Partial<PhpMyAdminHostObservation['access']> = {}, root = '/usr/share/phpmyadmin'): PhpMyAdminHostObservation => ({ access: { ...PMA_ACCESS_DEFAULTS, phpVersion: '8.3', ...access }, root, binary: '/usr/sbin/php-fpm8.3', hostname: 'server.example.test', panelPort: 2087 })

describe('phpMyAdmin access', () => {
  it('limits the server to this host while public access is off', () => {
    const closed = renderPhpMyAdminNginx(host()), open = renderPhpMyAdminNginx(host({ publicAccess: true }))
    expect(closed).toContain('allow 127.0.0.1;\n    allow ::1;\n    deny all;')
    expect(open).not.toContain('deny all;')
  })
  it('asks for the extra password only when one is saved', () => {
    expect(renderPhpMyAdminNginx(host())).not.toContain('auth_basic')
    const auth = host({ basicAuth: { user: 'guard', hash: '$6$saltsalt$' + 'a'.repeat(40) } })
    expect(renderPhpMyAdminNginx(auth)).toContain('auth_basic_user_file /etc/nginx/xpanel-phpmyadmin.htpasswd;')
    const file = compilePhpMyAdminAccess(debian, auth).files.find(row => row.path.endsWith('.htpasswd'))!
    expect(file).toMatchObject({ mode: 0o640, group: 'nginx' })
  })
  it('renders only the listeners that are set', () => {
    expect(renderPhpMyAdminNginx(host({ httpPort: null }))).not.toContain('listen 8008')
    expect(renderPhpMyAdminNginx(host())).toContain('listen 8009 ssl;')
    expect(phpMyAdminPorts(host())).toEqual([8008, 8009])
    expect(phpMyAdminPorts(undefined)).toEqual([])
  })
  it('keeps no worker while idle and opens the socket to nginx only', () => {
    const fpm = renderPhpMyAdminFpm(debian)
    expect(fpm).toContain('pm = ondemand')
    expect(fpm).toContain('listen.mode = 0600')
    expect(fpm).toContain('listen.owner = nginx')
    expect(fpm).toContain('user = www-data')
  })
  it('renders sign-on only while a browser can reach the client', () => {
    expect(compilePhpMyAdminAccess(debian, host()).files.map(row => row.path)).not.toContain('/etc/xpanel/database-web-clients.json')
    const files = compilePhpMyAdminAccess(debian, host({ publicAccess: true })).files.map(row => row.path)
    expect(files).toEqual(expect.arrayContaining(['/etc/xpanel/database-web-clients.json', '/usr/share/phpmyadmin/xpanel-signon.php', '/etc/phpmyadmin/conf.d/90-xpanel-signon.php']))
  })
  it('renders a sign-on setup the existing status check accepts', async () => {
    const plan = compilePhpMyAdminAccess(debian, host({ publicAccess: true })), files = new Map(plan.files.map(row => [row.path, row.content]))
    const fs = { readFile: async (path: string) => path === '/etc/group' ? 'www-data:x:33:\n' : files.get(path) ?? null, lstat: async () => ({ isDirectory: true, isSymbolicLink: false, uid: 0, gid: 33, mode: 0o40730 }), writeTicket: async () => undefined, listTickets: async () => [], removeTicket: async () => undefined }
    expect(await readDbSignonStatus({ installed: true, fs, sql: { query: async () => '' } })).toMatchObject({ state: 'ready' })
    expect(plan.preActions).toContainEqual({ kind: 'ensure-dir', path: '/var/lib/xpanel-phpmyadmin', mode: 0o730, owner: 'root', group: 'www-data' })
  })
  it('owns the whole config file on EL, where there is no conf.d', () => {
    const files = compilePhpMyAdminAccess(el, host({ publicAccess: true }, '/usr/share/phpMyAdmin')).files
    expect(files.find(row => row.path === '/etc/phpMyAdmin/config.inc.php')?.content).toContain("$cfg['TempDir']")
    expect(renderPhpMyAdminFpm(el)).toContain('user = apache')
  })
  it('restarts the pool only when its files changed', () => {
    const files = compilePhpMyAdminAccess(debian, host()).files, sha = (text: string): string => 'h' + text.length
    expect(phpMyAdminRestartActions(files, files.map(row => ({ path: row.path, sha256: sha(row.content) })), sha)).toEqual([])
    expect(phpMyAdminRestartActions(files, [], sha)).toEqual([{ kind: 'systemd', verb: 'restart', unit: 'xpanel-phpmyadmin-fpm.service' }])
  })
  it('refuses a damaged saved file', () => {
    expect(parsePhpMyAdminAccess(PMA_ACCESS_DEFAULTS)).toEqual(PMA_ACCESS_DEFAULTS)
    expect(parsePhpMyAdminAccess({ ...PMA_ACCESS_DEFAULTS, httpPort: 8009 })).toBeNull()
    expect(parsePhpMyAdminAccess({ ...PMA_ACCESS_DEFAULTS, phpVersion: '../x' })).toBeNull()
    expect(parsePhpMyAdminAccess({ ...PMA_ACCESS_DEFAULTS, basicAuth: { user: 'a b', hash: 'x' } })).toBeNull()
  })
})
