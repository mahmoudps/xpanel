import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
// Source diagnostics only. These tests do not issue a certificate or emulate a trusted CA.
import { ACME_DIRECTORY, DEFAULT_ACCESS, PATHS, assertIsolatedDefaultConfig, gatedListeners, validateAccess, withAccess, awaitReadiness, certbotArguments, mergeApiEnvironment, parseConfigArguments, renderChallenge, renderIngress, renderRenewalUnits, renewalObservation, requiredEnvironment, sameFileVersion, validateConfig } from './management-tls.mjs'
import { ACTIVATION_KIND, ACTIVATION_PATH, activationCommandEvidence } from './management-tls-activation.mjs'
import { NGINX_HTTP2_STYLES, nginxHttp2Style } from './nginx-http2.mjs'
import { SEC_STATE_PATHS } from '../apps/agent/src/sec-policy.ts'
import { renderDefaultSite, renderNginxSite } from '../packages/render/src/edge/nginx.ts'
import { account, cert, domain, serverBlocks, settings } from '../packages/render/src/edge/testkit.ts'

const root = resolve(import.meta.dirname, '..')
const input = () => ({ schemaVersion: 1, hostname: 'panel.example.org', addresses: ['192.0.2.10'], acmeEmail: 'admin@example.org', acceptAcmeTerms: true })
const config = () => validateConfig(input())
const installer = readFileSync(resolve(root, 'scripts/install.sh'), 'utf8')

// Execute the actual selected declaration bodies with an isolated kernel/service
// model. This proves control flow only; no model response qualifies a CA or host.
// The override is test-only and allows retained RED execution against old source.
const diagnosticSource = readFileSync(process.env.XPANEL_TLS_DIAGNOSTIC_SOURCE ?? resolve(root, 'scripts/management-tls.mjs'), 'utf8')
const loadDeclarations = (names: string[], bindings: Record<string, unknown>) => {
  // These owned declarations use a column0 closing brace. This deliberately
  // extracts only their exact bodies, not a general JavaScript parser or a
  // production loader. Compilation below rejects a malformed extraction.
  const found = names.flatMap(name => {
    const start = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function|class) ${name}\\b`, 'm').exec(diagnosticSource)
    if (!start) return []
    const tail = diagnosticSource.slice(start.index), end = /\r?\n}\r?\n/.exec(tail)
    if (!end) throw new Error(`Diagnostic declaration is incomplete: ${name}`)
    return [{ name, text: tail.slice(0, end.index + end[0].length).replace(/^export\s+/, '') }]
  })
  const present = found.map(node => node.name)
  const parameters = Object.keys(bindings).filter(key => !present.includes(key))
  const code = found.map(node => node.text).join('\n')
  return new Function(...parameters, `${code}\nreturn {${present.join(',')}};`)(...parameters.map(key => bindings[key]))
}
const codedFailure = (code: string): never => { throw Object.assign(new Error(code), { code }) }
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const modelFilesystem = () => {
  let serial = 1
  const files = new Map<string, any>(), descriptors = new Map<number, string>()
  const get = (path: string) => {
    const value = files.get(path)
    return value ? { bytes: Buffer.from(value.bytes), st: { ...value.st } } : null
  }
  const put = (path: string, bytes: Buffer | string, mode = 0o600, gid = 0, published = (_value: unknown) => {}) => {
    const data = Buffer.from(bytes), id = serial++
    files.set(path, { bytes: data, st: { dev: 1, ino: id, uid: 0, gid, mode: 0o100000 | mode, size: data.length, mtimeMs: id, ctimeMs: id } })
    published(get(path))
  }
  return {
    files, get, put,
    readRootFile: (path: string) => get(path) ?? codedFailure('ENOENT'),
    existing: get, replaceFile: put, syncParent: () => {}, fsyncSync: () => {}, closeSync: () => {},
    openSync: (path: string, flags: number) => {
      if ((flags & constants.O_EXCL) && files.has(path)) codedFailure('EEXIST')
      if (!files.has(path)) put(path, '')
      const fd = serial++; descriptors.set(fd, path); return fd
    },
    writeFileSync: (fd: number, bytes: Buffer | string) => put(descriptors.get(fd)!, bytes),
    unlinkSync: (path: string) => { files.delete(path) }, existsSync: (path: string) => files.has(path),
  }
}
const transactionBindings = (fs: ReturnType<typeof modelFilesystem>) => ({ ...fs, constants, PATHS, sha: digest, fail: codedFailure, sameFileVersion, stamp: () => String(Math.random()).slice(2), command: async (_operation: string, _executable: string, args: string[]) => { const original = fs.get(args[2])!; fs.put(args[3], original.bytes, original.st.mode & 0o777, original.st.gid) } })

const OLD_CERTIFICATE = 'old certificate bytes'
// As releases up to 0.1.23 wrote it: fc2b082f added the HTTP/2 styles, bf326620 the TLS policy include.
const oldStyleIngress = (value: ReturnType<typeof config>, generation: string) => renderIngress(value, generation, 'directive').replace(/    # These paths carry a credential[^\n]*\n    location ~ [^\n]*\n[^}]*\n    \}\n/g, '').replaceAll('\n    http2 on;', '').replaceAll(`include ${PATHS.tlsPolicy};`, 'ssl_protocols TLSv1.2 TLSv1.3;')
const accountVhost = (http2: 'listen' | 'directive') => renderNginxSite(account(), [domain()], { ...settings(), edge: { http2 } }, cert())
const INGRESS_DEPRECATION = `nginx: [warn] the "listen ... http2" directive is deprecated, use the "http2" directive instead in ${PATHS.ingress}:4\n`
const PROTOCOLS_REDEFINED = 'nginx: [warn] protocol options redefined for 0.0.0.0:443 in /etc/nginx/sites-enabled/account.conf:3\n'

const lifecycleModel = (options: { expired?: boolean; rejectCandidate?: boolean; rejectActivation?: boolean; rejectStatus?: boolean; mutate?: 'api' | 'secret' | 'config' | 'timer'; http2?: 'listen' | 'directive'; ingress?: (value: ReturnType<typeof config>, generation: string) => string; account?: string; warning?: string; notDue?: boolean } = {}) => {
  const fs = modelFilesystem(), value = config(), operations: string[] = [], statuses: any[] = [], testedIngress: string[] = []
  const oldFingerprint = digest(OLD_CERTIFICATE), newFingerprint = 'b'.repeat(64)
  fs.put(PATHS.config, JSON.stringify(value), 0o600)
  fs.put(PATHS.secret, '1'.repeat(64) + '\n', 0o640, 100)
  fs.put(PATHS.apiEnv, Object.entries(requiredEnvironment(value)).map(([key, item]) => `${key}=${item}\n`).join(''), 0o640, 100)
  fs.put(PATHS.challenge, renderChallenge(value), 0o644)
  fs.put(PATHS.ingress, (options.ingress ?? ((selected, generation) => renderIngress(selected, generation, 'listen')))(value, oldFingerprint), 0o644)
  fs.put(`${PATHS.certs}/${oldFingerprint}/fullchain.pem`, OLD_CERTIFICATE)
  fs.put(PATHS.include, '# Managed by xPanel management TLS lifecycle v1.\ninclude\n', 0o600)
  fs.put(PATHS.service, '# Managed by xPanel management TLS lifecycle v1.\nservice\n', 0o644)
  fs.put(PATHS.timer, '# Managed by xPanel management TLS lifecycle v1.\ntimer\n', 0o644)
  let timer = { LoadState: 'loaded', ActiveState: 'active', SubState: 'waiting', UnitFileState: 'enabled', InvocationID: '1'.repeat(32), FragmentPath: PATHS.timer, DropInPaths: '' }
  const timerRead = async () => ({ ...timer, references: new Map([[PATHS.timer, fs.get(PATHS.timer)], [PATHS.service, fs.get(PATHS.service)]]) })
  // nginx compares the protocol options of every server on one socket, as parsed from the files on disk at that moment.
  const nginxWarnings = () => {
    const ingress = fs.get(PATHS.ingress)!.bytes.toString()
    const seen = new Set([ingress, options.account ?? ''].flatMap(text => [...text.matchAll(/^ *listen 443((?: [a-z0-9_]+)*);$/gm)].map(match => match[1]!.replace(' default_server', ''))))
    return (seen.size > 1 ? PROTOCOLS_REDEFINED : '') + (options.http2 === 'directive' && ingress.includes('listen 443 ssl http2;') ? INGRESS_DEPRECATION : '') + (options.warning ?? '')
  }
  const command = async (operation: string, _executable: string, args: string[]) => {
    operations.push(operation)
    if (operation === 'nginx-config-test') testedIngress.push(fs.get(PATHS.ingress)!.bytes.toString())
    if (operation === 'backup-managed-file') { const original = fs.get(args[2])!; fs.put(args[3], original.bytes, original.st.mode & 0o777, original.st.gid) }
    if (operation === 'certbot-management-issuance-or-renewal') {
      if (options.mutate === 'api') fs.put(PATHS.apiEnv, fs.get(PATHS.apiEnv)!.bytes.toString() + 'OPERATOR_CHANGED=preserve\n', 0o640, 100)
      if (options.mutate === 'secret') fs.put(PATHS.secret, '2'.repeat(64) + '\n', 0o640, 100)
      if (options.mutate === 'config') fs.put(PATHS.config, JSON.stringify({ ...value, acmeEmail: 'changed@example.org' }))
      if (options.mutate === 'timer') timer = { ...timer, InvocationID: '2'.repeat(32) }
    }
    return { stdout: operation === 'read-api-reader-group' ? 'xpanel:x:100:\n' : '', stderr: ['nginx-config-test', 'read-nginx-configuration-digest'].includes(operation) ? nginxWarnings() : '', exitCode: 0 }
  }
  const bindings = {
    ...transactionBindings(fs), command, MARKER: '# Managed by xPanel management TLS lifecycle v1.\n', validateConfig, mergeApiEnvironment, certbotArguments, baseConfig: (selected: unknown) => selected,
    renewalTimerState: timerRead, nginxState: async () => ({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', InvocationID: 'a'.repeat(32), MainPID: '10' }), dnsPreflight: async () => {},
    preflightUnusedListeners: async () => {}, assertNginxInvocation: async () => {}, activationCommandEvidence, assertNoCertbotHooks: () => {},
    observeNginxHttp2: async () => options.http2 ?? 'listen',
    X509Certificate: class { raw: Buffer; constructor(bytes: Buffer) { this.raw = bytes } }, NGINX_HTTP2_STYLES,
    servedReady: async (_config: unknown, certificate: { generation: string }) => { if (options.expired && certificate.generation === oldFingerprint) codedFailure('CERT_HAS_EXPIRED'); if (options.rejectCandidate && certificate.generation === newFingerprint) codedFailure('CANDIDATE_NOT_TRUSTED'); return { attempts: 1 } },
    readCertificate: () => ({ generation: options.notDue ? oldFingerprint : newFingerprint, fullchain: options.notDue ? OLD_CERTIFICATE : 'diagnostic bytes', key: 'diagnostic bytes', expiresAt: '2030-01-01T00:00:00.000Z' }),
    rootDirectory: () => {}, renderChallenge, renderIngress, renderRenewalUnits: () => ({ service: '# Managed by xPanel management TLS lifecycle v1.\nservice\n', timer: '# Managed by xPanel management TLS lifecycle v1.\ntimer\n' }),
    randomBytes, awaitReadiness: options.rejectActivation ? async (probe: () => Promise<unknown>) => { try { return { attempts: 1, result: await probe() } } catch { return codedFailure('SERVED_READINESS_FAILED') } } : awaitReadiness,
    request: async (_address: string, _point: unknown, path: string) => ({ status: 200, body: fs.get(PATHS.webroot + path)!.bytes.toString() }),
    profiles: (selected: any) => [{ host: selected.hostname }, { host: `whm.${selected.hostname}` }, { host: `mail.${selected.hostname}` }],
    renewalObservation, saveStatus: (status: any) => { if (options.rejectStatus && status.status === 'tls-ready') codedFailure('STATUS_WRITE_FAILED'); statuses.push(status) }, ACTIVATION_KIND, ACTIVATION_PATH,
    observeManagementActivation: () => ({ files: {} }),
    completeManagementActivation: () => { if (options.rejectActivation) codedFailure('ACTIVATION_NEW_WORKERS_UNOBSERVED'); return { kind: ACTIVATION_KIND, diagnosticModelOnly: true } },
  }
  const loaded = loadDeclarations(['OwnedTransaction', 'assertOriginalReferences', 'assertTimerSnapshot', 'lifecycle', 'nginxRefuses', 'nginxReload', 'nginxConfigurationDigest', 'installedCertificate', 'releasedIngress', 'managedIngress'], bindings)
  return { fs, value, statuses, operations, testedIngress, invoke: (phase = 'prepare') => loaded.lifecycle(value, phase, fs.get(PATHS.config)), oldFingerprint }
}

describe('management TLS source diagnostics (not public CA or installed-host qualification)', () => {
  it('requires installer input and invokes the actual lifecycle before claiming TLS preparation', () => {
    expect(installer).toContain('--management-hostname=')
    expect(installer).toContain('--management-address=')
    expect(installer).toContain('--acme-email=')
    expect(installer).toContain('--accept-acme-terms')
    expect(installer).toContain('management-tls.mjs" plan')
    expect(installer).toContain('management-tls.mjs" configure')
    expect(installer).toContain('management-tls.mjs" prepare')
    expect(installer).not.toContain('echo "xPanel installation complete."')
  })
  it('runs explicit installer TLS planning only in dry-run and refuses partial option bundles', () => {
    const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
    expect(existsSync(bash)).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'xpanel-tls-plan-'))
    try {
      const osRelease = join(dir, 'os-release')
      writeFileSync(osRelease, 'ID=ubuntu\nVERSION_ID="24.04"\n')
      const args = ['scripts/install.sh', '--dry-run', `--os-release=${osRelease.replaceAll('\\', '/')}`]
      const env = { ...process.env, XPANEL_NODE_BIN: process.execPath.replaceAll('\\', '/') }
      const planned = spawnSync(bash, [...args, '--management-hostname=panel.example.org', '--management-address=192.0.2.10', '--acme-email=admin@example.org', '--accept-acme-terms'], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
      expect(planned.status, planned.stderr).toBe(0)
      expect(planned.stdout).toContain('https://mail.panel.example.org:2096')
      expect(planned.stdout).toContain('no CA or service operation')
      expect(planned.stdout).toContain('setfacl -m u:nginx:x /var/lib/xpanel')
      const partial = spawnSync(bash, [...args, '--management-hostname=panel.example.org'], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
      expect(partial.status).not.toBe(0)
      expect(partial.stdout).not.toContain('Package List')
    } finally {
      expect(dirname(resolve(dir))).toBe(resolve(tmpdir()))
      expect(basename(dir).startsWith('xpanel-tls-plan-')).toBe(true)
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('keeps application bootstrap explicit and never starts API or agent from TLS', () => {
    const source = readFileSync(resolve(root, 'scripts/management-tls.mjs'), 'utf8')
    expect(source).not.toMatch(/['"]start['"],\s*['"]xpanel-(api|agent)/)
    expect(source).not.toContain('node:sqlite')
    expect(source).not.toContain('rejectUnauthorized: false')
    expect(source).not.toMatch(/--(?:insecure|staging|test-cert|force-renewal)/)
    expect(source).toContain('applicationBootstrap: \'pending\'')
  })
  it('lets a synchronous account provisioning answer through every management entry point', () => {
    const rendered = renderIngress(config(), 'a'.repeat(64), 'listen')
    expect(rendered.match(/proxy_pass http:\/\/127\.0\.0\.1:120(83|87|96);/g)).toHaveLength(6)
    expect(rendered.match(/^ {8}proxy_read_timeout 300s;$/gm)).toHaveLength(6)
    expect(rendered.match(/^ {8}access_log off;$/gm)).toHaveLength(3)
  })
  it('keeps every managed directory under root-only ancestors, never the group-writable /var/log', () => {
    for (const path of [PATHS.webroot, PATHS.acme, PATHS.logs, PATHS.certs]) expect(path.startsWith('/var/log/')).toBe(false)
    expect(PATHS.logs.startsWith(PATHS.state + '/')).toBe(true)
  })
  it('uses only the delegated management name and its two children, never its parent or a wildcard', () => {
    const value = config(), args = certbotArguments(value)
    expect(args.filter((_, index) => args[index - 1] === '-d')).toEqual(['panel.example.org', 'whm.panel.example.org', 'mail.panel.example.org'])
    expect(args).not.toContain('example.org')
    expect(args.some(arg => arg.includes('*.'))).toBe(false)
    expect(args).toContain(ACME_DIRECTORY)
    expect(args).toContain('--webroot')
    expect(args).toContain('--non-interactive')
    expect(args).toContain('--agree-tos')
    expect(args).toContain('--no-directory-hooks')
    expect(args).not.toContain('--nginx')
    expect(args).not.toContain('--standalone')
  })
  it.each(['https://panel.example.org', '*.panel.example.org', 'panel.example.org/path', 'Panel.example.org', 'panel.example.org\nserver{}', '-panel.example.org', 'panel..example.org', '127.0.0.1', 'panel.invalid'])('refuses invalid or nonpublic hostname %s', hostname => {
    expect(() => validateConfig({ ...input(), hostname })).toThrow()
  })
  it.each([false, undefined, 'true', 1])('requires affirmative noninteractive ACME terms consent %s', acceptAcmeTerms => {
    expect(() => validateConfig({ ...input(), acceptAcmeTerms })).toThrow()
  })
  it.each(['admin@example.org\n--server=evil', '--email=bad', '', 'a b@example.org'])('refuses malformed ACME email %s', acmeEmail => {
    expect(() => validateConfig({ ...input(), acmeEmail })).toThrow()
  })
  it.each([['0.0.0.0'], ['127.0.0.1'], ['::'], ['::1'], ['host.example.org'], ['192.0.2.10', '192.0.2.10'], []])('requires exact nonwildcard addresses %j', addresses => {
    expect(() => validateConfig({ ...input(), addresses })).toThrow()
  })
  it('refuses missing, duplicate and unknown installer arguments without mutation', () => {
    expect(() => parseConfigArguments([])).toThrow()
    expect(() => parseConfigArguments(['--management-hostname=panel.example.org', '--management-hostname=other.example.org'])).toThrow('DUPLICATE_ARGUMENT')
    expect(() => parseConfigArguments(['--server=https://other-ca.example.org'])).toThrow('UNKNOWN_ARGUMENT')
    const parsed = parseConfigArguments(['--management-hostname=panel.example.org', '--management-address=192.0.2.10', '--acme-email=admin@example.org', '--accept-acme-terms'])
    expect(parsed).toEqual(config())
  })
  it('preserves unrelated API environment and fills all exact fixed profiles', () => {
    const before = '# Operator configuration\r\nUNRELATED=value\r\nXPANEL_PANEL_PUBLIC_ORIGIN=\r\n'
    const after = mergeApiEnvironment(before, config())
    expect(after).toContain('# Operator configuration\r\nUNRELATED=value\r\n')
    for (const [key, value] of Object.entries(requiredEnvironment(config()))) expect(after).toContain(`${key}=${value}`)
    expect(mergeApiEnvironment(after, config())).toBe(after)
    expect(after).toContain('https://panel.example.org:2083')
    expect(after).toContain('https://whm.panel.example.org:2087')
    expect(after).toContain('https://mail.panel.example.org:2096')
  })
  it.each(['XPANEL_PANEL_PUBLIC_ORIGIN=https://panel.example.org\n', 'XPANEL_WHM_PORT=2087\n', 'XPANEL_HOST=0.0.0.0\n'])('requires explicit migration of existing settings %s', before => {
    expect(() => mergeApiEnvironment(before, config())).toThrow('EXPLICIT_MIGRATION_REQUIRED')
  })
  it('rejects duplicate exact settings instead of letting environment parser ordering decide authority', () => {
    expect(() => mergeApiEnvironment('XPANEL_HOST=127.0.0.1\nXPANEL_HOST=127.0.0.1\n', config())).toThrow('DUPLICATE_SETTING')
  })
  it.each([' XPANEL_HOST=0.0.0.0\n', 'XPANEL_HOST =127.0.0.1\n', 'export XPANEL_HOST=0.0.0.0\n', 'UNRELATED=continued\\\nXPANEL_HOST=127.0.0.1\n'])('refuses ambiguous EnvironmentFile syntax instead of silently replacing an existing origin %s', content => {
    expect(() => mergeApiEnvironment(content, config())).toThrow('EXPLICIT_MIGRATION_REQUIRED')
  })
  it('compares kernel file identity and metadata as well as bytes before replacement or rollback', () => {
    const baseline = { bytes: Buffer.from('original'), st: { dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o100600, size: 8, mtimeMs: 1, ctimeMs: 1 } }
    expect(sameFileVersion(baseline, { ...baseline, st: { ...baseline.st } })).toBe(true)
    expect(sameFileVersion(null, null)).toBe(true)
    expect(sameFileVersion(null, baseline)).toBe(false)
    expect(sameFileVersion(baseline, { ...baseline, bytes: Buffer.from('modified') })).toBe(false)
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs']) expect(sameFileVersion(baseline, { ...baseline, st: { ...baseline.st, [key]: baseline.st[key] + 1 } })).toBe(false)
  })
  it('records a not-due observed check separately from initial issuance or a served rotation', () => {
    expect(renewalObservation(null, 'a'.repeat(64))).toBe('initial-certificate-served')
    expect(renewalObservation('a'.repeat(64), 'a'.repeat(64))).toBe('checked-unchanged')
    expect(renewalObservation('a'.repeat(64), 'b'.repeat(64))).toBe('certificate-rotation-served-observed')
    expect(() => renewalObservation(null, 'not-a-fingerprint')).toThrow()
  })
  it.each(['deploy-hook = /operator-hook\n', 'domains = unrelated.example.org\n', 'server = https://other-ca.example.org\n', 'rsa-key-size=4096\n'])('refuses inherited global Certbot settings instead of assuming --config disables defaults %s', text => {
    expect(() => assertIsolatedDefaultConfig(text)).toThrow('ACME_GLOBAL_CONFIGURATION_REVIEW_REQUIRED')
  })
  it('permits empty and comment-only global Certbot defaults without changing them', () => {
    expect(() => assertIsolatedDefaultConfig('# Defaults\n\n; Comment\n')).not.toThrow()
    expect(() => assertIsolatedDefaultConfig('')).not.toThrow()
  })
  it('permits the packaged Debian, Ubuntu and EL cli.ini and bounds its own logs', () => {
    expect(() => assertIsolatedDefaultConfig('# Because we are using logrotate for greater flexibility, disable the\n# internal certbot logrotation.\nmax-log-backups = 0\n# Adjust interactive output regarding automated renewal\npreconfigured-renewal = True\n')).not.toThrow()
    expect(() => assertIsolatedDefaultConfig('max-log-backups = 0\nrenew-hook = /operator\n')).toThrow('ACME_GLOBAL_CONFIGURATION_REVIEW_REQUIRED')
    const args = certbotArguments(config())
    expect(args[args.indexOf('--max-log-backups') + 1]).toBe('10')
  })
  it('renders scoped HTTP-01 without redirecting challenge tokens or opening unrelated names', () => {
    const text = renderChallenge(config())
    expect(text.match(/^ {4}listen 80;$/gm)).toHaveLength(3)
    expect(text).not.toContain('192.0.2.10:80')
    expect(text.match(/server_name /g)).toHaveLength(3)
    expect(text).toContain('location ~ "^/\\.well-known/acme-challenge/[A-Za-z0-9_-]{1,128}$"')
    expect(text).toContain(`root ${PATHS.webroot};`)
    expect(text).not.toContain('default_server')
    expect(text).not.toContain('server_name example.org')
  })
  it('keeps canonical443 redirects outside API origins and uses one protected ingress include', () => {
    const text = renderIngress(config(), 'a'.repeat(64), 'directive')
    for (const [port, backend] of [[2083, 12083], [2087, 12087], [2096, 12096]]) {
      expect(text).toContain(`listen 192.0.2.10:${port} ssl;`)
      expect(text).toContain(`proxy_pass http://127.0.0.1:${backend};`)
    }
    // Shared with the account edge: an address-specific 443 would capture every account site on the address.
    expect(text.match(/^ {4}listen 443 ssl;$/gm)).toHaveLength(3)
    expect(text.match(/^ {4}http2 on;$/gm)).toHaveLength(3)
    expect(text).not.toContain('192.0.2.10:443')
    expect(text.match(/include \/etc\/nginx\/xpanel-management\/ingress-secret.conf;/g)).toHaveLength(6)
    expect(text.match(/proxy_set_header Upgrade \$http_upgrade;/g)).toHaveLength(6)
    expect(text.match(/proxy_set_header Connection \$xpanel_management_connection_upgrade;/g)).toHaveLength(6)
    expect(text).toContain('if ($http_host != "panel.example.org:2083") { return 421; }')
    expect(text).toContain('proxy_set_header Forwarded "";')
    expect(text).toContain('proxy_set_header X-Forwarded-For $remote_addr;')
    expect(text).not.toContain('0.0.0.0')
    expect(text).not.toContain('proxy_pass https')
    expect(() => renderIngress(config(), '../escape', 'listen')).toThrow()
  })
  it('renders IPv6 exact binds and gives renewal the same reviewed lifecycle', () => {
    const value = validateConfig({ ...input(), addresses: ['192.0.2.10', '2001:db8::10'] })
    expect(renderChallenge(value)).toContain('listen [::]:80;')
    expect(renderChallenge(config())).not.toContain('[::]')
    expect(renderIngress(value, 'b'.repeat(64), 'listen')).toContain('listen [2001:db8::10]:2087 ssl;')
    const units = renderRenewalUnits('/opt/xpanel-runtime/bin/node')
    expect(units.service).toContain('ExecStart=/opt/xpanel-runtime/bin/node /opt/xpanel/scripts/management-tls.mjs renew')
    expect(units.service).toContain('KillMode=control-group')
    expect(units.timer).toContain('Persistent=true')
    expect(() => renderRenewalUnits('/bin/node; bad')).toThrow()
    const current = renderRenewalUnits('/opt/xpanel-runtime/bin/node', 'current')
    expect(current.service).toContain('ExecStart=/opt/xpanel-runtime/bin/node /opt/xpanel/current/scripts/management-tls.mjs renew')
    expect(current.timer).toBe(units.timer)
    expect(() => renderRenewalUnits('/usr/bin/node', 'arbitrary')).toThrow()
  })
  it('renders the shared 443 servers in the listen style nginx before 1.25.1 requires', () => {
    const value = validateConfig({ ...input(), addresses: ['192.0.2.10', '2001:db8::10'] })
    const text = renderIngress(value, 'a'.repeat(64), 'listen')
    expect(text.match(/^ {4}listen 443 ssl http2;$/gm)).toHaveLength(3)
    expect(text.match(/^ {4}listen \[::\]:443 ssl http2;$/gm)).toHaveLength(3)
    expect(text).not.toContain('http2 on;')
    // The exclusive management ports keep their own options in either style.
    expect(text).toContain('listen 192.0.2.10:2083 ssl;')
    expect(renderIngress(value, 'a'.repeat(64), 'directive')).toContain('listen [::]:443 ssl;\n    http2 on;\n')
    for (const http2 of [undefined, 'h2', 'listen http2']) expect(() => renderIngress(value, 'a'.repeat(64), http2)).toThrow('NGINX_HTTP2_STYLE_INVALID')
  })
  it.each(NGINX_HTTP2_STYLES)('gives the management and account servers on the shared 443 socket identical protocol options (%s)', http2 => {
    const value = validateConfig({ ...input(), addresses: ['192.0.2.10', '2001:db8::10'] })
    const edge = { ...settings(), edge: { http2 } }
    const combined = [renderIngress(value, 'a'.repeat(64), http2), renderDefaultSite({ settings: edge }), renderNginxSite(account(), [domain()], edge, cert())].join('\n')
    const options = new Map<string, Set<string>>()
    for (const [, socket, rest] of combined.matchAll(/^ *listen ((?:\[::\]:)?443)((?: [a-z0-9_]+)*);$/gm)) {
      options.set(socket!, (options.get(socket!) ?? new Set()).add(rest!.replace(' default_server', '')))
    }
    expect([...options.keys()].sort()).toEqual(['443', '[::]:443'])
    for (const seen of options.values()) expect([...seen]).toEqual([http2 === 'listen' ? ' ssl http2' : ' ssl'])
    const servers = serverBlocks(combined).filter(block => /listen 443 /.test(block))
    expect(servers).toHaveLength(5)
    for (const server of servers) expect(server.includes('http2 on;')).toBe(http2 === 'directive')
  })
  it('recognizes its own ingress in either style and refuses any other text', () => {
    const { managedIngress } = loadDeclarations(['managedIngress'], { NGINX_HTTP2_STYLES, renderIngress })
    const value = config(), generation = 'a'.repeat(64)
    for (const http2 of NGINX_HTTP2_STYLES) expect(managedIngress(renderIngress(value, generation, http2), value, generation)).toBe(true)
    // The earlier rendering without any HTTP/2 option conflicts with the account edge; it is not adopted.
    expect(managedIngress(renderIngress(value, generation, 'directive').replaceAll('\n    http2 on;', ''), value, generation)).toBe(false)
    expect(managedIngress(renderIngress(value, generation, 'listen') + '# edited\n', value, generation)).toBe(false)
  })
  it('reads the HTTP/2 style from the installed nginx binary and refuses an unreadable version', async () => {
    const calls: unknown[][] = []
    const observe = (stderr: string) => loadDeclarations(['observeNginxHttp2'], {
      command: async (...args: unknown[]) => { calls.push(args); return { stdout: '', stderr } }, nginxHttp2Style, fail: codedFailure,
    }).observeNginxHttp2()
    await expect(observe('nginx version: nginx/1.24.0 (Ubuntu)\n')).resolves.toBe('listen')
    await expect(observe('nginx version: nginx/1.26.3\n')).resolves.toBe('directive')
    await expect(observe('')).rejects.toMatchObject({ code: 'NGINX_VERSION_UNOBSERVED' })
    expect(calls[0]).toEqual(['read-nginx-version', '/usr/sbin/nginx', ['-v'], 5_000])
  })
  it('waits through old-worker certificate mismatch instead of equating successful reload to readiness', async () => {
    let now = 0, count = 0
    const result = await awaitReadiness(async () => { if (++count < 3) throw new Error('old worker'); return 'served expected fingerprint' }, { now: () => now, sleep: async ms => { now += ms }, timeoutMs: 1000, intervalMs: 250 })
    expect(result).toEqual({ attempts: 3, result: 'served expected fingerprint' })
    expect(now).toBe(500)
  })
  it('fails bounded readiness and rejects a positive probe completed after its deadline', async () => {
    let now = 0
    await expect(awaitReadiness(async () => { throw new Error('unavailable') }, { now: () => now, sleep: async ms => { now += ms }, timeoutMs: 500, intervalMs: 250 })).rejects.toThrow('SERVED_READINESS_FAILED')
    expect(now).toBe(500)
    now = 0
    await expect(awaitReadiness(async () => { now = 501; return 'late' }, { now: () => now, sleep: async ms => { now += ms }, timeoutMs: 500 })).rejects.toThrow('SERVED_READINESS_FAILED')
  })
  it('executes an invalid real CLI plan without root operations or leaking a child command', () => {
    const result = spawnSync(process.execPath, ['scripts/management-tls.mjs', 'plan', '--management-hostname=panel.example.org'], { cwd: root, encoding: 'utf8', timeout: 5000 })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('ACME_EXPLICIT_CONSENT_REQUIRED')
    expect(result.stderr).not.toContain('admin@')
  })
  it('executes a valid real CLI plan and reports three exact origins without invoking ACME', () => {
    const result = spawnSync(process.execPath, ['scripts/management-tls.mjs', 'plan', '--management-hostname=panel.example.org', '--management-address=192.0.2.10', '--acme-email=admin@example.org', '--accept-acme-terms'], { cwd: root, encoding: 'utf8', timeout: 5000 })
    expect(result.status, result.stderr).toBe(0)
    const plan = JSON.parse(result.stdout)
    expect(plan.origins).toEqual(requiredEnvironment(config()))
    expect(plan.config).toEqual(config())
    expect(plan.applicationBootstrap).toBe('pending')
    expect(result.stderr).toBe('')
  })
})

describe('management TLS retained-failure control-flow diagnostics (modeled kernel/services, no native or CA proof)', () => {
  it('publishes the activation record through the same owned transaction only after actual activation ports settle', async () => {
    const model = lifecycleModel()
    await model.invoke()
    const record = model.fs.get(ACTIVATION_PATH)!
    expect(record.st.mode & 0o777).toBe(0o600)
    expect(JSON.parse(record.bytes.toString())).toMatchObject({ kind: ACTIVATION_KIND, diagnosticModelOnly: true })
    expect(model.statuses.at(-1).activationRecordSha256).toBe(digest(record.bytes))
  })
  it('does not create an activation record when the actual observation port never sees replacement workers', async () => {
    const model = lifecycleModel({ rejectActivation: true })
    await expect(model.invoke()).rejects.toMatchObject({ code: 'SERVED_READINESS_FAILED' })
    expect(model.fs.get(ACTIVATION_PATH)).toBeNull()
    expect(model.statuses.at(-1).status).toBe('failed')
  })
  it.each([false, true])('restores the original activation state after post-publication failure (prior record: %s)', async present => {
    const model = lifecycleModel({ rejectStatus: true })
    const original = JSON.stringify({ kind: ACTIVATION_KIND, previousDiagnosticRecord: true }) + '\n'
    if (present) model.fs.put(ACTIVATION_PATH, original, 0o600)
    await expect(model.invoke()).rejects.toMatchObject({ code: 'STATUS_WRITE_FAILED' })
    expect(model.fs.get(ACTIVATION_PATH)?.bytes.toString() ?? null).toBe(present ? original : null)
    expect(model.statuses.at(-1).status).toBe('failed')
  })
  it('preserves an existing activation record byte-for-byte during read-only verification', async () => {
    const model = lifecycleModel()
    const original = JSON.stringify({ kind: ACTIVATION_KIND, previousDiagnosticRecord: true }) + '\n'
    model.fs.put(ACTIVATION_PATH, original, 0o600)
    await model.invoke('verify')
    expect(model.fs.get(ACTIVATION_PATH)!.bytes.toString()).toBe(original)
    expect(model.statuses.at(-1).status).toBe('ingress-observed-ready')
    expect(model.statuses.at(-1)).not.toHaveProperty('activationRecordSha256')
  })
  it('writes the new ingress in the HTTP/2 style observed from the installed nginx', async () => {
    const model = lifecycleModel({ http2: 'directive' })
    await model.invoke('renew')
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(renderIngress(model.value, 'b'.repeat(64), 'directive'))
  })
  it('renews an old-style ingress beside an http2 account vhost by rewriting it before the first reload', async () => {
    const model = lifecycleModel({ ingress: oldStyleIngress, account: accountVhost('listen') })
    await model.invoke('renew')
    expect(model.testedIngress[0]).toBe(renderIngress(model.value, model.oldFingerprint, 'listen'))
    expect(model.operations.indexOf('nginx-config-test')).toBeLessThan(model.operations.indexOf('certbot-management-issuance-or-renewal'))
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(renderIngress(model.value, 'b'.repeat(64), 'listen'))
    expect(model.fs.get(PATHS.tlsPolicy)!.bytes.toString()).toContain('ssl_protocols TLSv1.2 TLSv1.3;')
    expect(model.statuses.at(-1)).toMatchObject({ status: 'tls-ready', priorReadiness: 'trusted-observed' })
    const backups = [...model.fs.files.keys()].filter(path => path.startsWith(`${PATHS.ingress}.bak.`))
    expect(backups.map(path => model.fs.get(path)!.bytes.toString())).toEqual([oldStyleIngress(model.value, model.oldFingerprint)])
  })
  it('keeps the rewritten ingress when certbot finds the certificate not yet due', async () => {
    const model = lifecycleModel({ ingress: oldStyleIngress, account: accountVhost('listen'), notDue: true })
    await model.invoke('renew')
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(renderIngress(model.value, model.oldFingerprint, 'listen'))
    expect(model.statuses.at(-1).status).toBe('tls-ready')
  })
  it('moves an ingress in the listen style to the directive style of a newer nginx', async () => {
    const model = lifecycleModel({ http2: 'directive', account: accountVhost('directive') })
    await model.invoke('renew')
    expect(model.testedIngress[0]).toBe(renderIngress(model.value, model.oldFingerprint, 'directive'))
    expect(model.statuses.at(-1).status).toBe('tls-ready')
  })
  it('restores the old-style ingress when a later step fails, and accepts its known warning on that reload', async () => {
    const model = lifecycleModel({ ingress: oldStyleIngress, account: accountVhost('listen'), rejectCandidate: true })
    await expect(model.invoke('renew')).rejects.toThrow('CANDIDATE_NOT_TRUSTED')
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(oldStyleIngress(model.value, model.oldFingerprint))
    expect(model.fs.get(PATHS.tlsPolicy)).toBeNull()
    expect(model.testedIngress.at(-1)).toBe(oldStyleIngress(model.value, model.oldFingerprint))
    expect(model.statuses.at(-1)).toMatchObject({ status: 'failed', reason: 'CANDIDATE_NOT_TRUSTED', rollback: 'owned-files-restored' })
    expect(model.fs.get(`${PATHS.state}/active-transition.json`)).toBeNull()
  })
  it('refuses the rewritten ingress when the account sites still disagree, then restores it', async () => {
    const model = lifecycleModel({ ingress: oldStyleIngress, account: `${accountVhost('listen')}\nlisten 443 ssl;\n` })
    await expect(model.invoke('renew')).rejects.toThrow('NGINX_CONFIG_CONFLICT')
    expect(model.operations).not.toContain('certbot-management-issuance-or-renewal')
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(oldStyleIngress(model.value, model.oldFingerprint))
    expect(model.statuses.at(-1)).toMatchObject({ status: 'failed', reason: 'NGINX_CONFIG_CONFLICT', rollback: 'owned-files-restored' })
  })
  it.each([
    ['a current ingress with a protocol warning', { account: 'listen 443 ssl;\n' }],
    ['a current ingress with any other warning', { warning: 'nginx: [warn] could not build optimal types_hash\n' }],
    ['an old-style ingress with any other warning', { ingress: oldStyleIngress, account: accountVhost('listen'), warning: 'nginx: [warn] could not build optimal types_hash\n' }],
  ])('keeps refusing %s before it changes a file', async (_name, options) => {
    const model = lifecycleModel(options)
    const original = model.fs.get(PATHS.ingress)!.bytes.toString()
    await expect(model.invoke('renew')).rejects.toThrow('NGINX_CONFIG_CONFLICT')
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(original)
    expect([...model.fs.files.keys()].some(path => path.includes('.bak.'))).toBe(false)
    expect(model.operations).not.toContain('nginx-reload')
  })
  it.each([
    ['edited text under the marker', (value: ReturnType<typeof config>, generation: string) => `${oldStyleIngress(value, generation)}# edited\n`, 'MANAGED_INGRESS_EXPLICIT_MIGRATION_REQUIRED'],
    ['a file without the marker', (value: ReturnType<typeof config>, generation: string) => oldStyleIngress(value, generation).replace('# Managed by xPanel management TLS lifecycle v1.\n', ''), 'UNMANAGED_FILE_MIGRATION_REQUIRED'],
  ])('keeps refusing %s', async (_name, ingress, code) => {
    const model = lifecycleModel({ ingress, account: accountVhost('listen') })
    const original = model.fs.get(PATHS.ingress)!.bytes.toString()
    await expect(model.invoke('renew')).rejects.toThrow(code)
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(original)
  })
  it('reads the warnings nginx prints for a stale ingress and nothing else as tolerable', () => {
    const { nginxRefuses } = loadDeclarations(['nginxRefuses'], {})
    expect(nginxRefuses(PROTOCOLS_REDEFINED, true)).toBe(false)
    expect(nginxRefuses(PROTOCOLS_REDEFINED + INGRESS_DEPRECATION, true)).toBe(false)
    expect(nginxRefuses(PROTOCOLS_REDEFINED)).toBe(true)
    expect(nginxRefuses(PROTOCOLS_REDEFINED.replace(':443', ':2083'), true)).toBe(true)
    expect(nginxRefuses(INGRESS_DEPRECATION.replace(PATHS.ingress, '/etc/nginx/sites-enabled/account.conf'), true)).toBe(true)
    expect(nginxRefuses(`${PROTOCOLS_REDEFINED}nginx: [emerg] host not found\n`, true)).toBe(true)
  })
  it('permits an expired installed baseline to reach repair and never labels it previously observed', async () => {
    const model = lifecycleModel({ expired: true })
    await expect(model.invoke()).resolves.toBeUndefined()
    expect(model.operations).toContain('certbot-management-issuance-or-renewal')
    expect(model.statuses.at(-1)).toMatchObject({ status: 'tls-ready', previousInstalledFingerprint: model.oldFingerprint, previousServedFingerprint: null, priorReadiness: 'baseline-unhealthy', certificateObservation: 'replacement-served-with-unhealthy-baseline' })
  })
  it('keeps post-switch validation mandatory and restores an unhealthy baseline without claiming health', async () => {
    const model = lifecycleModel({ expired: true, rejectCandidate: true })
    await expect(model.invoke()).rejects.toThrow('CANDIDATE_NOT_TRUSTED')
    expect(model.statuses.at(-1)).toMatchObject({ status: 'failed', previousServedFingerprint: null, priorReadiness: 'baseline-unhealthy', rollback: 'owned-files-restored-prior-baseline-unhealthy' })
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(renderIngress(model.value, model.oldFingerprint, 'listen'))
  })
  it.each(['api', 'secret', 'config'] as const)('preserves an original %s reference changed while issuance is pending', async mutate => {
    const model = lifecycleModel({ mutate })
    await expect(model.invoke()).rejects.toThrow()
    expect(model.statuses.at(-1), JSON.stringify(model.statuses)).toMatchObject({ status: 'failed', reason: 'ORIGINAL_REFERENCE_DRIFT', rollback: 'blocked-preserve-concurrent-state' })
    if (mutate === 'api') expect(model.fs.get(PATHS.apiEnv)!.bytes.toString()).toContain('OPERATOR_CHANGED=preserve')
    if (mutate === 'secret') expect(model.fs.get(PATHS.secret)!.bytes.toString()).toBe('2'.repeat(64) + '\n')
    if (mutate === 'config') expect(model.fs.get(PATHS.config)!.bytes.toString()).toContain('changed@example.org')
    expect(model.fs.get(PATHS.include)!.bytes.toString()).toBe('# Managed by xPanel management TLS lifecycle v1.\ninclude\n')
  })
  it('does not adopt and enable a different timer invocation that appeared during issuance', async () => {
    const model = lifecycleModel({ mutate: 'timer' })
    await expect(model.invoke()).rejects.toThrow()
    expect(model.operations).not.toContain('enable-management-renewal')
    expect(model.operations.some(operation => operation.startsWith('rollback-owned-management-timer'))).toBe(false)
    expect(model.statuses.at(-1), JSON.stringify(model.statuses)).toMatchObject({ status: 'failed', reason: 'RENEWAL_TIMER_CONCURRENT_DRIFT', rollback: 'blocked-preserve-concurrent-state' })
  })
  it('compares the original API before-image before adopting a later transaction baseline', async () => {
    const fs = modelFilesystem()
    fs.put(PATHS.apiEnv, 'ORIGINAL=value\n', 0o640, 100)
    const original = fs.get(PATHS.apiEnv)
    fs.put(PATHS.apiEnv, 'OPERATOR_CHANGED=preserve\n', 0o640, 100)
    const { OwnedTransaction } = loadDeclarations(['OwnedTransaction'], transactionBindings(fs))
    const transaction = new OwnedTransaction()
    await expect(transaction.write(PATHS.apiEnv, 'STALE_MERGE=value\n', 0o640, 100, true, original)).rejects.toThrow('ORIGINAL_REFERENCE_DRIFT')
    expect(fs.get(PATHS.apiEnv)!.bytes.toString()).toBe('OPERATOR_CHANGED=preserve\n')
  })
  it.each(['fragment', 'drop-in'])('refuses a timer loaded from an unowned %s configuration', async kind => {
    const fs = modelFilesystem()
    fs.put(PATHS.timer, '# Managed by xPanel management TLS lifecycle v1.\ntimer\n', 0o644)
    fs.put(PATHS.service, '# Managed by xPanel management TLS lifecycle v1.\nservice\n', 0o644)
    const command = async () => ({ stdout: `LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nInvocationID=\nFragmentPath=${kind === 'fragment' ? '/run/systemd/generator/unowned.timer' : PATHS.timer}\nDropInPaths=${kind === 'drop-in' ? '/etc/systemd/system/xpanel-management-tls.timer.d/operator.conf' : ''}\n` })
    const { renewalTimerState } = loadDeclarations(['renewalTimerState'], { ...fs, PATHS, MARKER: '# Managed by xPanel management TLS lifecycle v1.\n', command, fail: codedFailure, sameFileVersion, realpathSync: (path: string) => path })
    await expect(renewalTimerState()).rejects.toThrow('RENEWAL_UNIT_CONFIGURATION_UNOWNED')
  })
  it('accepts only both canonical root-owned unit fragments without drop-ins', async () => {
    const fs = modelFilesystem()
    for (const path of [PATHS.timer, PATHS.service]) fs.put(path, '# Managed by xPanel management TLS lifecycle v1.\nunit\n', 0o644)
    const command = async (_operation: string, _executable: string, args: string[]) => {
      const isTimer = args[1].endsWith('.timer')
      return { stdout: `LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=${isTimer ? 'disabled' : 'static'}\nInvocationID=\nFragmentPath=${isTimer ? PATHS.timer : PATHS.service}\nDropInPaths=\n` }
    }
    const { renewalTimerState } = loadDeclarations(['renewalTimerState'], { ...fs, PATHS, MARKER: '# Managed by xPanel management TLS lifecycle v1.\n', command, fail: codedFailure, sameFileVersion, realpathSync: (path: string) => path })
    const observed = await renewalTimerState()
    expect(observed.FragmentPath).toBe(PATHS.timer)
    expect(observed.references.size).toBe(2)
  })
  it('admits a fresh load of its own unit files before daemon-reload, since systemd loads a not-found unit on its next query', () => {
    const fs = modelFilesystem()
    fs.put(PATHS.timer, '# Managed by xPanel management TLS lifecycle v1.\ntimer\n', 0o644)
    const expected = new Map([[PATHS.timer, fs.get(PATHS.timer)]])
    const { assertTimerSnapshot } = loadDeclarations(['assertTimerSnapshot'], { assertOriginalReferences: () => {}, sameFileVersion, fail: codedFailure })
    const state = (values: Record<string, string>) => ({ LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', UnitFileState: 'disabled', InvocationID: '', FragmentPath: PATHS.timer, DropInPaths: '', ...values, references: new Map([[PATHS.timer, fs.get(PATHS.timer)]]) })
    const notFound = state({ LoadState: 'not-found', UnitFileState: '', FragmentPath: '' })
    expect(() => assertTimerSnapshot(notFound, notFound, expected)).not.toThrow()
    expect(() => assertTimerSnapshot(notFound, state({}), expected)).not.toThrow()
    expect(() => assertTimerSnapshot(notFound, state({ ActiveState: 'active', SubState: 'waiting', InvocationID: 'a'.repeat(32) }), expected)).toThrow('RENEWAL_TIMER_CONCURRENT_DRIFT')
    expect(() => assertTimerSnapshot(notFound, state({ UnitFileState: 'enabled' }), expected)).toThrow('RENEWAL_TIMER_CONCURRENT_DRIFT')
  })
  it('verifies and runs the resolved file of a tool shipped as a symbolic link', async () => {
    const verified: string[] = [], spawned: string[] = []
    const { command } = loadDeclarations(['command'], { PATHS, constants, realpathSync: (path: string) => path === '/usr/bin/certbot' ? '/usr/bin/certbot-3' : path,
      trustedExecutable: (path: string) => { verified.push(path); codedFailure('STOP_AFTER_VERIFY') }, spawn: (path: string) => { spawned.push(path) }, fail: codedFailure })
    await expect(command('read-version', '/usr/bin/certbot', ['--version'])).rejects.toThrow('STOP_AFTER_VERIFY')
    expect(verified).toEqual(['/usr/bin/certbot-3'])
    expect(spawned).toEqual([])
  })
  const commandModel = (neverClose = false, initialGroupPresent = true, knownBirth = true) => {
    const fs = modelFilesystem(), signals: unknown[] = []
    let groupPresent = initialGroupPresent
    const child = Object.assign(new EventEmitter(), { pid: 4200, stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() })
    const spawn = () => { queueMicrotask(() => { child.emit('spawn'); if (!neverClose) child.emit('close', 0, null) }); return child }
    const processModel = { kill: (_pid: number, signal: unknown) => { if (signal !== 0) { signals.push(signal); groupPresent = false } else if (!groupPresent) codedFailure('ESRCH') } }
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[2] = '4200'; fields[3] = '4200'; fields[19] = '123'
    const { command } = loadDeclarations(['command'], { ...fs, PATHS, constants, spawn, process: processModel, performance, delay: async () => {}, trustedExecutable: () => {}, realpathSync: (path: string) => path,
      readRootFile: (path: string) => path.startsWith('/usr/') ? { bytes: Buffer.from('tool'), st: {} } : fs.readRootFile(path),
      readFileSync: () => `4200 (diagnostic) ${fields.join(' ')}`, observeChildBirth: () => knownBirth ? ({ pid: 4200, kernelStartTime: '123', processGroupId: 4200, sessionId: 4200 }) : null, fail: codedFailure, setTimeout, clearTimeout,
    })
    return { fs, signals, child, run: (timeout = 1000) => command('diagnostic-command', '/usr/bin/diagnostic-tool', [], timeout) }
  }
  it('retains unexpected descendants after leader reap and never force-kills them into successful exit0', async () => {
    const model = commandModel()
    await expect(model.run()).rejects.toThrow('ATTENTION')
    expect(model.signals).toEqual([])
    expect(model.fs.files.has(`${PATHS.state}/active-command.json`)).toBe(true)
  })
  it('retires a normal observed child only after its real modeled group has ended', async () => {
    const model = commandModel(false, false)
    const result = await model.run()
    expect(result).toMatchObject({ exitCode: 0, remainingProcessGroup: false, executable: '/usr/bin/diagnostic-tool', birth: { pid: 4200, kernelStartTime: '123' } })
    expect(Date.parse(result.startedAt)).toBeLessThanOrEqual(Date.parse(result.finishedAt))
    expect(Date.parse(result.finishedAt)).toBeLessThanOrEqual(Date.parse(result.retiredAt))
    expect(model.signals).toEqual([])
    expect(model.fs.files.has(`${PATHS.state}/active-command.json`)).toBe(false)
  })
  it('retains an unknown child birth even if its numeric group no longer appears', async () => {
    const model = commandModel(false, false, false)
    await expect(model.run()).rejects.toThrow('CHILD_BIRTH_UNOBSERVED_ATTENTION')
    expect(model.signals).toEqual([])
    expect(model.fs.files.has(`${PATHS.state}/active-command.json`)).toBe(true)
  })
  it('settles a command deadline as attention without a TERM/KILL or child-quiescence claim', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const model = commandModel(true)
      const result = model.run(1).then((value: unknown) => value, (error: unknown) => error)
      await Promise.resolve()
      await vi.runAllTimersAsync()
      expect(await result).toMatchObject({ code: 'CHILD_DEADLINE_ATTENTION', details: { remainingProcessGroup: true, hardTermination: false } })
      expect(model.signals).toEqual([])
      expect(model.child.unref).toHaveBeenCalled()
      expect(model.fs.files.has(`${PATHS.state}/active-command.json`)).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('settles output overflow as attention without signalling a numeric process group', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const model = commandModel(true)
      const result = model.run().then((value: unknown) => value, (error: unknown) => error)
      await Promise.resolve()
      model.child.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1))
      await vi.runAllTimersAsync()
      expect(await result).toMatchObject({ code: 'CHILD_OUTPUT_LIMIT_ATTENTION', details: { remainingProcessGroup: true, hardTermination: false } })
      expect(model.signals).toEqual([])
      expect(model.fs.files.has(`${PATHS.state}/active-command.json`)).toBe(true)
    } finally { vi.useRealTimers() }
  })
})

describe('panel access binding', () => {
  it('excuses /login only for an entry point the saved gate hides', () => {
    expect(PATHS.gate.endsWith(SEC_STATE_PATHS['panel-gate'])).toBe(true)
    expect(gatedListeners(JSON.stringify({ version: 1, policy: { entrance: { path: 'x', listeners: ['xwhm'] }, response: {}, basicAuth: { listeners: ['xpanel'] }, stopped: ['xmail'] } }))).toEqual(['xwhm', 'xpanel', 'xmail'])
    expect(gatedListeners(JSON.stringify({ version: 1, policy: { entrance: null, basicAuth: null, stopped: [] } }))).toEqual([])
    expect(gatedListeners('not json')).toEqual([])
    expect(gatedListeners(null)).toEqual([])
  })

  const moved = (ports = {}, hosts = {}) => validateAccess({ schemaVersion: 1, ports: { xpanel: 2083, xwhm: 2087, xmail: 2096, ...ports }, hosts: { xpanel: null, xwhm: null, xmail: null, ...hosts } })

  it('accepts only the grammar the agent writes', () => {
    expect(moved({ xwhm: 18888 }).ports.xwhm).toBe(18888)
    expect(validateAccess(DEFAULT_ACCESS).ports.xwhm).toBe(2087)
    for (const bad of [{ xwhm: 0 }, { xwhm: 65536 }, { xwhm: 443 }, { xwhm: 12087 }, { xwhm: 2083 }]) expect(() => moved(bad)).toThrow()
    expect(() => moved({}, { xwhm: 'not a host' })).toThrow()
    expect(() => moved({}, { xwhm: 'a.example.com', xmail: 'a.example.com' })).toThrow()
  })

  it('moves the listener, the host check and the 443 redirect together and answers 403 for a bound name', () => {
    const value = withAccess(config(), moved({ xwhm: 18888 }, { xwhm: 'admin.example.com' }))
    const text = renderIngress(value, 'a'.repeat(64), 'listen')
    expect(text).toContain(':18888 ssl;')
    expect(text).not.toContain(':2087 ssl;')
    expect(text).toContain('if ($http_host != "admin.example.com:18888") { return 403; }')
    expect(text).toContain('return 308 https://admin.example.com:18888$request_uri;')
    expect(text).toContain('proxy_pass http://127.0.0.1:12087;')
    expect(renderIngress(config(), 'a'.repeat(64), 'listen')).not.toContain('return 403')
  })

  it('leaves the default ingress byte for byte unchanged', () => {
    expect(renderIngress(withAccess(config(), moved()), 'a'.repeat(64), 'listen')).toBe(renderIngress(config(), 'a'.repeat(64), 'listen'))
  })

  it('moves the origins only for a rebind and leaves every other value alone', () => {
    const value = withAccess(config(), moved({ xwhm: 18888 }))
    const current = Object.entries(requiredEnvironment(config())).map(([key, item]) => `${key}=${item}\n`).join('') + 'OTHER=kept\n'
    expect(() => mergeApiEnvironment(current, value)).toThrow('API_ENV_EXPLICIT_MIGRATION_REQUIRED')
    const merged = mergeApiEnvironment(current, value, true)
    expect(merged).toContain(`XPANEL_WHM_PUBLIC_ORIGIN=https://whm.${config().hostname}:18888\n`)
    expect(merged).toContain('OTHER=kept\n')
  })

  it('asks certbot for new names only on a rebind', () => {
    expect(certbotArguments(config())).not.toContain('--renew-with-new-domains')
    const args = certbotArguments(withAccess(config(), moved({}, { xwhm: 'admin.example.com' })), true)
    expect(args).toContain('--renew-with-new-domains')
    expect(args).toContain('admin.example.com')
  })
})
