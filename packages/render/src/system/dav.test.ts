import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { Certificate, Domain } from '@xpanel/core'
import {
  DAV_LAUNCHER,
  DAV_LAUNCHER_PATH,
  calDavPruneAction,
  calDavPaths,
  davNamesByCertificate,
  davWellKnownLocations,
  renderCalDavUnits,
  renderDavNginx,
  renderDavNginxDefault,
  renderWebDiskUnits,
  webDiskDirsAction,
  webDiskInstance,
  webDiskPaths,
} from './dav.ts'
import { debianOs, makeAccount, rhelOs, unitValues } from './testkit.ts'

const account = makeAccount()
const USER_ID = '0f0e0d0c-0b0a-4908-8706-050403020100'
const codeOf = (fn: () => unknown): string | undefined => {
  try { fn() } catch (e) { return e instanceof XpanelError ? e.code : 'OTHER' }
  return undefined
}
const fileAt = (files: { path: string; content: string }[], suffix: string): string => files.find(f => f.path.endsWith(suffix))!.content

describe('davWellKnownLocations', () => {
  it('redirects to the first name of the site on the calendar port, and says nothing for a name it does not serve', () => {
    expect(davWellKnownLocations(['b.test'], ['a.test', 'b.test'])).toEqual(['location = /.well-known/caldav { return 301 https://b.test:2080/; }', 'location = /.well-known/carddav { return 301 https://b.test:2080/; }'])
    expect(davWellKnownLocations(['c.test'], ['a.test'])).toEqual([])
    expect(davWellKnownLocations(undefined, ['a.test'])).toEqual([])
  })
})

describe('webDiskInstance', () => {
  it('names a login by subject, directory and access right', () => {
    const main = webDiskInstance({ subject: 'main', dir: '', readOnly: false })
    expect(main).toMatch(/^[0-9a-f]{12}$/)
    expect(webDiskInstance({ subject: 'main', dir: '', readOnly: true })).not.toBe(main)
    expect(webDiskInstance({ subject: USER_ID, dir: '', readOnly: false })).not.toBe(main)
    expect(webDiskInstance({ subject: USER_ID, dir: 'public_html', readOnly: false })).not.toBe(webDiskInstance({ subject: USER_ID, dir: 'docs', readOnly: false }))
    expect(webDiskInstance({ subject: 'main', dir: '', readOnly: false })).toBe(main)
  })

  it('refuses traversal, absolute and blank directories and unknown subjects', () => {
    for (const dir of ['../etc', '/etc', 'a/../b', 'My Docs', 'a\tb', 'x%y']) expect(codeOf(() => webDiskInstance({ subject: 'main', dir, readOnly: false }))).toBe('VALIDATION')
    for (const subject of ['root', '../x', USER_ID.toUpperCase()]) expect(codeOf(() => webDiskInstance({ subject, dir: '', readOnly: false }))).toBe('VALIDATION')
  })
})

describe('renderWebDiskUnits', () => {
  const login = { subject: USER_ID, dir: 'public_html/docs', readOnly: false }
  const r = renderWebDiskUnits(account, login, debianOs)
  const name = `alice-${r.instance}`

  it('serves the login directory with lighttpd as the account behind root-owned nginx sockets', () => {
    expect(r.paths).toEqual(webDiskPaths('alice', r.instance))
    expect(r.files.map(f => f.path).sort()).toEqual([
      `/etc/systemd/system/xpanel-webdisk-${name}.service`,
      `/etc/systemd/system/xpanel-webdisk-${name}.socket`,
      `/etc/systemd/system/xpanel-webdiskd-${name}.service`,
      `/etc/systemd/system/xpanel-webdiskd-${name}.socket`,
      `/etc/xpanel/runtime/alice/webdisk-${r.instance}.conf`,
    ])
    const service = fileAt(r.files, `xpanel-webdiskd-${name}.service`)
    expect(unitValues(service, 'ExecStart')).toEqual(['/usr/sbin/lighttpd -D -f %d/webdisk.conf'])
    expect(unitValues(service, 'LoadCredential')).toEqual([`webdisk.conf:/etc/xpanel/runtime/alice/webdisk-${r.instance}.conf`])
    expect(unitValues(service, 'User')).toEqual(['alice'])
    expect(unitValues(service, 'Slice')).toEqual(['xpanel-1001.slice'])
    expect(unitValues(service, 'StopWhenUnneeded')).toEqual(['yes'])
    expect(unitValues(service, 'BindPaths')).toEqual(['/home/alice/public_html/docs'])
    expect(unitValues(service, 'ReadWritePaths')).toEqual([`/home/alice/public_html/docs /run/xpanel-webdisk-state/${name}`])
    expect(unitValues(service, 'SocketBindDeny')).toEqual(['any'])
    const front = fileAt(r.files, `xpanel-webdisk-${name}.socket`)
    expect(unitValues(front, 'ListenStream')).toEqual([`/run/xpanel-webdisk/${name}.sock`])
    expect([unitValues(front, 'SocketUser'), unitValues(front, 'SocketGroup'), unitValues(front, 'SocketMode')]).toEqual([['root'], ['www-data'], ['0660']])
    const backend = fileAt(r.files, `xpanel-webdiskd-${name}.socket`)
    expect([unitValues(backend, 'SocketUser'), unitValues(backend, 'SocketMode')]).toEqual([['alice'], ['0600']])
    const proxy = fileAt(r.files, `xpanel-webdisk-${name}.service`)
    expect(unitValues(proxy, 'ExecStart')).toEqual([`/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=10min /run/xpanel-webdiskd/${name}/dav.sock`])
    expect(unitValues(proxy, 'Requires')).toEqual([`xpanel-webdisk-${name}.socket xpanel-webdiskd-${name}.service`])
    expect(r.sockets).toEqual([`xpanel-webdiskd-${name}.socket`, `xpanel-webdisk-${name}.socket`])
    const config = fileAt(r.files, `webdisk-${r.instance}.conf`)
    expect(config).toContain('server.document-root = "/home/alice/public_html/docs"')
    expect(config).toContain('server.systemd-socket-activation = "enable"')
    expect(config).not.toContain('is-readonly')
    expect(r.files.find(f => f.path.endsWith('.conf'))!.mode).toBe(0o600)
  })

  it('binds a read-only login read-only and tells lighttpd so', () => {
    const ro = renderWebDiskUnits(account, { ...login, readOnly: true }, rhelOs)
    const service = fileAt(ro.files, `xpanel-webdiskd-alice-${ro.instance}.service`)
    expect(unitValues(service, 'BindReadOnlyPaths')).toEqual(['/home/alice/public_html/docs'])
    expect(unitValues(service, 'BindPaths')).toEqual([])
    expect(unitValues(service, 'ReadWritePaths')).toEqual([`/run/xpanel-webdisk-state/alice-${ro.instance}`])
    expect(fileAt(ro.files, '.conf')).toContain('webdav.is-readonly = "enable"')
    expect(unitValues(fileAt(ro.files, `xpanel-webdisk-alice-${ro.instance}.socket`), 'SocketGroup')).toEqual(['nginx'])
  })

  it('gives the main account login the whole home', () => {
    const main = renderWebDiskUnits(account, { subject: 'main', dir: '', readOnly: false }, debianOs)
    expect(unitValues(fileAt(main.files, `xpanel-webdiskd-alice-${main.instance}.service`), 'BindPaths')).toEqual(['/home/alice'])
  })
})

describe('renderCalDavUnits', () => {
  const r = renderCalDavUnits(account, debianOs)

  it('runs Radicale as the account on a root-owned socket with its store in the home', () => {
    expect(r.paths).toEqual(calDavPaths(account))
    const service = fileAt(r.files, 'xpanel-caldav-alice.service')
    expect(unitValues(service, 'ExecStart')).toEqual(['/usr/bin/python3 /etc/xpanel/runtime/dav-radicale.py %d/caldav.conf "/home/alice/.caldav" 60'])
    expect(unitValues(service, 'User')).toEqual(['alice'])
    expect(unitValues(service, 'BindPaths')).toEqual(['/home/alice'])
    const socket = fileAt(r.files, 'xpanel-caldav-alice.socket')
    expect(unitValues(socket, 'ListenStream')).toEqual(['/run/xpanel-caldav/alice.sock'])
    expect(unitValues(socket, 'SocketMode')).toEqual(['0660'])
    const config = fileAt(r.files, 'caldav.conf')
    expect(config).toContain('type = http_x_remote_user')
    expect(config).toContain('type = owner_only')
    expect(config).toContain('filesystem_folder = /home/alice/.caldav')
  })

  it('prunes as the account and refuses a principal that is no identity', () => {
    expect(calDavPruneAction(account, ['main', USER_ID])).toEqual({ kind: 'exec', runAsUser: 'alice', argv: ['/usr/bin/python3', '-I', '-S', DAV_LAUNCHER_PATH, '--prune', '/home/alice/.caldav', 'main', USER_ID] })
    expect(() => calDavPruneAction(account, ['../other'])).toThrow()
    expect(webDiskDirsAction(account, ['public_html/docs'])).toEqual({ kind: 'exec', runAsUser: 'alice', argv: ['/usr/bin/python3', '-I', '-S', DAV_LAUNCHER_PATH, '--webdisk-dirs', '/home/alice', 'public_html/docs'] })
    expect(codeOf(() => webDiskDirsAction(account, ['../etc']))).toBe('VALIDATION')
    expect(DAV_LAUNCHER).toContain("if sys.argv[1] == '--webdisk-dirs':")
    expect(DAV_LAUNCHER).toContain("if sys.argv[1] == '--prune':")
  })

  it('ships a launcher that refuses unverified identities and protects the default collections', () => {
    expect(DAV_LAUNCHER).toContain("os.environ.get('LISTEN_FDS') != '1'")
    expect(DAV_LAUNCHER).toContain("PRINCIPAL = re.compile(r'^(?:main|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')")
    expect(DAV_LAUNCHER).toContain("'The default calendar and address book cannot be deleted.\\n'")
  })
})

const cert = (id: string, names: string[], accountId: string | null = account.id): Certificate => ({ id, names, accountId } as Certificate)
const domain = (name: string, extra: Partial<Domain> = {}): Domain => ({ id: name, accountId: account.id, name, suspended: false, certificateId: null, ...extra } as Domain)

describe('DAV nginx edge', () => {
  const certA = cert('11111111-1111-4111-8111-111111111111', ['example.com', 'www.example.com'])
  const certB = cert('22222222-2222-4222-8222-222222222222', ['*.example.org'])
  const foreign = cert('33333333-3333-4333-8333-333333333333', ['other.test'], 'someone-else')

  it('serves only names covered by a certificate of this account', () => {
    const groups = davNamesByCertificate(account, [domain('example.com'), domain('shop.example.org'), domain('plain.test'), domain('other.test'), domain('off.example.org', { suspended: true })], [certA, certB, foreign])
    expect(groups.map(g => [g.cert.id, g.names])).toEqual([[certA.id, ['example.com']], [certB.id, ['shop.example.org']]])
  })

  it('verifies every request with the panel and forwards only the verified identity', () => {
    const file = renderDavNginx(account, [{ cert: certA, names: ['example.com'] }], debianOs, { panelHost: 'server.example.com:2083', webDisk: true, calDav: true })
    expect(file.path).toBe('/etc/nginx/conf.d/xpanel-dav-alice.conf')
    const text = file.content
    expect(text).toContain('    listen 2078 ssl;')
    expect(text).toContain('    listen [::]:2080 ssl;')
    expect(text).toContain('    location = /.well-known/caldav { return 301 /; }')
    expect(text).toContain('    location = /.well-known/carddav { return 301 /; }')
    expect(text).toContain('    location ^~ /.xpanel/ { return 404; }')
    expect(text).toContain(`    ssl_certificate /etc/xpanel/ssl/${certA.id}/fullchain.pem;`)
    expect(text).toContain('        proxy_pass http://127.0.0.1:12083/api/dav/authorize;')
    expect(text).toContain('        include /etc/nginx/xpanel-management/ingress-secret.conf;')
    expect(text).toContain('        proxy_set_header Host server.example.com:2083;')
    expect(text).toContain('        proxy_set_header X-Xpanel-Dav-Service webdisk;')
    expect(text).toContain('        proxy_set_header X-Xpanel-Dav-Account alice;')
    expect(text).toContain('        proxy_pass http://unix:/run/xpanel-webdisk/alice-$xpanel_webdisk_target.sock:;')
    expect(text).toContain('        proxy_pass http://unix:/run/xpanel-caldav/alice.sock:;')
    expect(text).toContain('        proxy_set_header X-Remote-User $xpanel_dav_user;')
    expect(text).toContain('        proxy_set_header X-Remote-User "";')
    expect(text.match(/proxy_set_header Authorization "";/g)).toHaveLength(2)
    expect(text.match(/auth_request \/\.xpanel-dav-auth;/g)).toHaveLength(2)
    expect(text).not.toContain('/home/')
  })

  it('renders only the requested services and refuses a malformed panel host', () => {
    const only = renderDavNginx(account, [{ cert: certA, names: ['example.com'] }], debianOs, { panelHost: 'server.example.com:2083', webDisk: true, calDav: false, ipv6: false }).content
    expect(only).not.toContain('2080')
    expect(only).not.toContain('[::]')
    for (const panelHost of ['server.example.com; return 200', 'http://x', '']) {
      expect(codeOf(() => renderDavNginx(account, [{ cert: certA, names: ['example.com'] }], debianOs, { panelHost, webDisk: true, calDav: true }))).toBe('VALIDATION')
    }
  })

  it('refuses unknown names on both ports and admits only a 12-hex instance', () => {
    const text = renderDavNginxDefault(debianOs).content
    expect(text).toContain('    "~^[0-9a-f]{12}$" $xpanel_webdisk_instance;')
    expect(text).toContain('    listen 2078 ssl default_server;')
    expect(text).toContain('    listen 2080 ssl default_server;')
    expect(text).toContain('    return 421;')
  })
})

describe('Web Disk TLS settings', { tags: ['unit'] }, () => {
  const certA = cert('11111111-1111-4111-8111-111111111111', ['example.com', 'www.example.com']), tls = { protocols: ['TLSv1.3'], ciphers: 'ECDHE+AESGCM' }
  it('defaults to TLS 1.2 and later with AEAD ciphers on the site and the default server', () => {
    const site = renderDavNginx(account, [{ cert: certA, names: ['example.com'] }], debianOs, { panelHost: 'server.example.com:2083', webDisk: true, calDav: true }).content, fallback = renderDavNginxDefault(debianOs).content
    for (const text of [site, fallback]) { expect(text).toContain('ssl_protocols TLSv1.2 TLSv1.3;'); expect(text).toContain('ssl_ciphers ECDHE+AESGCM:ECDHE+CHACHA20;') }
  })
  it('renders the saved lists on both, so the listener takes them', () => {
    const site = renderDavNginx(account, [{ cert: certA, names: ['example.com'] }], debianOs, { panelHost: 'server.example.com:2083', webDisk: true, calDav: true, tls }).content, fallback = renderDavNginxDefault(debianOs, true, tls).content
    for (const text of [site, fallback]) { expect(text).toContain('ssl_protocols TLSv1.3;'); expect(text).toContain('ssl_ciphers ECDHE+AESGCM;'); expect(text).not.toContain('TLSv1.2') }
  })
})
