import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
// Source diagnostics only. These tests do not issue a certificate or emulate a trusted CA.
import { ACME_DIRECTORY, PATHS, assertIsolatedDefaultConfig, awaitReadiness, certbotArguments, mergeApiEnvironment, parseConfigArguments, renderChallenge, renderIngress, renderRenewalUnits, renewalObservation, requiredEnvironment, sameFileVersion, validateConfig } from './management-tls.mjs'

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

const lifecycleModel = (options: { expired?: boolean; rejectCandidate?: boolean; mutate?: 'api' | 'secret' | 'config' | 'timer' } = {}) => {
  const fs = modelFilesystem(), value = config(), operations: string[] = [], statuses: any[] = []
  const oldFingerprint = 'a'.repeat(64), newFingerprint = 'b'.repeat(64)
  fs.put(PATHS.config, JSON.stringify(value), 0o600)
  fs.put(PATHS.secret, '1'.repeat(64) + '\n', 0o640, 100)
  fs.put(PATHS.apiEnv, Object.entries(requiredEnvironment(value)).map(([key, item]) => `${key}=${item}\n`).join(''), 0o640, 100)
  fs.put(PATHS.challenge, renderChallenge(value), 0o644)
  fs.put(PATHS.ingress, renderIngress(value, oldFingerprint), 0o644)
  fs.put(PATHS.include, '# Managed by xPanel management TLS lifecycle v1.\ninclude\n', 0o600)
  fs.put(PATHS.service, '# Managed by xPanel management TLS lifecycle v1.\nservice\n', 0o644)
  fs.put(PATHS.timer, '# Managed by xPanel management TLS lifecycle v1.\ntimer\n', 0o644)
  let timer = { LoadState: 'loaded', ActiveState: 'active', SubState: 'waiting', UnitFileState: 'enabled', InvocationID: '1'.repeat(32), FragmentPath: PATHS.timer, DropInPaths: '' }
  const timerRead = async () => ({ ...timer, references: new Map([[PATHS.timer, fs.get(PATHS.timer)], [PATHS.service, fs.get(PATHS.service)]]) })
  const command = async (operation: string, _executable: string, args: string[]) => {
    operations.push(operation)
    if (operation === 'backup-managed-file') { const original = fs.get(args[2])!; fs.put(args[3], original.bytes, original.st.mode & 0o777, original.st.gid) }
    if (operation === 'certbot-management-issuance-or-renewal') {
      if (options.mutate === 'api') fs.put(PATHS.apiEnv, fs.get(PATHS.apiEnv)!.bytes.toString() + 'OPERATOR_CHANGED=preserve\n', 0o640, 100)
      if (options.mutate === 'secret') fs.put(PATHS.secret, '2'.repeat(64) + '\n', 0o640, 100)
      if (options.mutate === 'config') fs.put(PATHS.config, JSON.stringify({ ...value, acmeEmail: 'changed@example.org' }))
      if (options.mutate === 'timer') timer = { ...timer, InvocationID: '2'.repeat(32) }
    }
    return { stdout: operation === 'read-api-reader-group' ? 'xpanel:x:100:\n' : '', stderr: '', exitCode: 0 }
  }
  const bindings = {
    ...transactionBindings(fs), command, MARKER: '# Managed by xPanel management TLS lifecycle v1.\n', validateConfig, mergeApiEnvironment, certbotArguments,
    renewalTimerState: timerRead, nginxState: async () => ({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running', InvocationID: 'a'.repeat(32), MainPID: '10' }), nginxConfigurationDigest: async () => 'configuration-hash', dnsPreflight: async () => {},
    preflightUnusedListeners: async () => {}, assertNginxInvocation: async () => {}, nginxReload: async () => {}, assertNoCertbotHooks: () => {},
    installedCertificate: () => ({ generation: oldFingerprint }),
    servedReady: async (_config: unknown, certificate: { generation: string }) => { if (options.expired && certificate.generation === oldFingerprint) codedFailure('CERT_HAS_EXPIRED'); if (options.rejectCandidate && certificate.generation === newFingerprint) codedFailure('CANDIDATE_NOT_TRUSTED'); return { attempts: 1 } },
    readCertificate: () => ({ generation: newFingerprint, fullchain: 'diagnostic bytes', key: 'diagnostic bytes', expiresAt: '2030-01-01T00:00:00.000Z' }),
    rootDirectory: () => {}, renderChallenge, renderIngress, renderRenewalUnits: () => ({ service: '# Managed by xPanel management TLS lifecycle v1.\nservice\n', timer: '# Managed by xPanel management TLS lifecycle v1.\ntimer\n' }),
    randomBytes, awaitReadiness, request: async (_address: string, _point: unknown, path: string) => ({ status: 200, body: fs.get(PATHS.webroot + path)!.bytes.toString() }),
    profiles: (selected: any) => [{ host: selected.hostname }, { host: `whm.${selected.hostname}` }, { host: `mail.${selected.hostname}` }],
    renewalObservation, saveStatus: (status: unknown) => statuses.push(status),
  }
  const loaded = loadDeclarations(['OwnedTransaction', 'assertOriginalReferences', 'assertTimerSnapshot', 'lifecycle'], bindings)
  return { fs, value, statuses, operations, invoke: () => loaded.lifecycle(value, 'prepare', fs.get(PATHS.config)), oldFingerprint }
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
  it('renders scoped HTTP-01 without redirecting challenge tokens or opening unrelated names', () => {
    const text = renderChallenge(config())
    expect(text.match(/listen 192\.0\.2\.10:80;/g)).toHaveLength(3)
    expect(text.match(/server_name /g)).toHaveLength(3)
    expect(text).toContain('location ~ "^/\\.well-known/acme-challenge/[A-Za-z0-9_-]{1,128}$"')
    expect(text).toContain(`root ${PATHS.webroot};`)
    expect(text).not.toContain('default_server')
    expect(text).not.toContain('server_name example.org')
  })
  it('keeps canonical443 redirects outside API origins and uses one protected ingress include', () => {
    const text = renderIngress(config(), 'a'.repeat(64))
    for (const [port, backend] of [[2083, 12083], [2087, 12087], [2096, 12096]]) {
      expect(text).toContain(`listen 192.0.2.10:${port} ssl;`)
      expect(text).toContain(`proxy_pass http://127.0.0.1:${backend};`)
    }
    expect(text.match(/listen 192\.0\.2\.10:443 ssl;/g)).toHaveLength(3)
    expect(text.match(/include \/etc\/nginx\/xpanel-management\/ingress-secret.conf;/g)).toHaveLength(3)
    expect(text.match(/proxy_set_header Upgrade \$http_upgrade;/g)).toHaveLength(3)
    expect(text.match(/proxy_set_header Connection \$xpanel_management_connection_upgrade;/g)).toHaveLength(3)
    expect(text).toContain('if ($http_host != "panel.example.org:2083") { return 421; }')
    expect(text).toContain('proxy_set_header Forwarded "";')
    expect(text).toContain('proxy_set_header X-Forwarded-For $remote_addr;')
    expect(text).not.toContain('0.0.0.0')
    expect(text).not.toContain('proxy_pass https')
    expect(() => renderIngress(config(), '../escape')).toThrow()
  })
  it('renders IPv6 exact binds and gives renewal the same reviewed lifecycle', () => {
    const value = validateConfig({ ...input(), addresses: ['192.0.2.10', '2001:db8::10'] })
    expect(renderChallenge(value)).toContain('listen [2001:db8::10]:80;')
    expect(renderIngress(value, 'b'.repeat(64))).toContain('listen [2001:db8::10]:2087 ssl;')
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
    expect(model.fs.get(PATHS.ingress)!.bytes.toString()).toBe(renderIngress(model.value, model.oldFingerprint))
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
  const commandModel = (neverClose = false, initialGroupPresent = true, knownBirth = true) => {
    const fs = modelFilesystem(), signals: unknown[] = []
    let groupPresent = initialGroupPresent
    const child = Object.assign(new EventEmitter(), { pid: 4200, stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() })
    const spawn = () => { queueMicrotask(() => { child.emit('spawn'); if (!neverClose) child.emit('close', 0, null) }); return child }
    const processModel = { kill: (_pid: number, signal: unknown) => { if (signal !== 0) { signals.push(signal); groupPresent = false } else if (!groupPresent) codedFailure('ESRCH') } }
    const fields = Array(20).fill('0'); fields[0] = 'S'; fields[2] = '4200'; fields[3] = '4200'; fields[19] = '123'
    const { command } = loadDeclarations(['command'], { ...fs, PATHS, constants, spawn, process: processModel, performance, delay: async () => {}, trustedExecutable: () => {},
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
    await expect(model.run()).resolves.toMatchObject({ exitCode: 0, remainingProcessGroup: false })
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
