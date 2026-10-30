#!/usr/bin/env node
// One root-owned lifecycle for management HTTPS. This does not initialize identities or start the API.
import { constants, closeSync, existsSync, fchmodSync, fchownSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, createPrivateKey, randomBytes, X509Certificate } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createServer, isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

export const ACME_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory'
export const MARKER = '# Managed by xPanel management TLS lifecycle v1.\n'
export const PATHS = Object.freeze({
  config: '/etc/xpanel/management-tls.json', apiEnv: '/etc/xpanel/api.env', secret: '/etc/xpanel/ingress.secret',
  state: '/var/lib/xpanel-management-tls', webroot: '/var/lib/xpanel-management-tls/challenge',
  acme: '/etc/xpanel/management-acme', logs: '/var/log/xpanel-management-tls',
  challenge: '/etc/nginx/conf.d/xpanel-management-challenge.conf', ingress: '/etc/nginx/conf.d/xpanel-management.conf',
  include: '/etc/nginx/xpanel-management/ingress-secret.conf', certs: '/etc/xpanel/management-certificates',
  service: '/etc/systemd/system/xpanel-management-tls.service', timer: '/etc/systemd/system/xpanel-management-tls.timer',
})
const fail = code => { const error = new Error(code); error.code = code; throw error }
const sha = data => createHash('sha256').update(data).digest('hex')
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const stamp = () => new Date().toISOString().replaceAll(/[-:.]/g, '') + '-' + randomBytes(6).toString('hex')
const profiles = config => [
  { name: 'xpanel', host: config.hostname, port: 2083, backend: 12083 },
  { name: 'xwhm', host: `whm.${config.hostname}`, port: 2087, backend: 12087 },
  { name: 'xmail', host: `mail.${config.hostname}`, port: 2096, backend: 12096 },
]

/** No shell expansion, wildcard, apex inference, URL, or caller-selected certificate path. */
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('CONFIG_INVALID')
  const keys = Object.keys(input).sort().join(',')
  if (keys !== 'acceptAcmeTerms,acmeEmail,addresses,hostname,schemaVersion' || input.schemaVersion !== 1 || input.acceptAcmeTerms !== true) fail('ACME_EXPLICIT_CONSENT_REQUIRED')
  const hostname = input.hostname
  if (typeof hostname !== 'string' || hostname.length > 248 || hostname !== hostname.toLowerCase() || !hostname.includes('.') || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || isIP(hostname)) fail('HOSTNAME_INVALID')
  if (/\.(?:invalid|localhost|local|test|example)$/.test(hostname)) fail('PUBLIC_HOSTNAME_REQUIRED')
  if (typeof input.acmeEmail !== 'string' || input.acmeEmail.length > 254 || !/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(input.acmeEmail) || /[\s\r\n]/.test(input.acmeEmail)) fail('ACME_EMAIL_INVALID')
  if (!Array.isArray(input.addresses) || input.addresses.length < 1 || input.addresses.length > 4 || new Set(input.addresses).size !== input.addresses.length) fail('PUBLIC_ADDRESSES_INVALID')
  for (const address of input.addresses) {
    if (typeof address !== 'string' || !isIP(address) || /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.|22[4-9]\.|23[0-9]\.)/.test(address) || ['::', '::1'].includes(address) || address.includes('%') || /^(?:f[cdef]|::ffff:)/i.test(address)) fail('EXPLICIT_PUBLIC_ADDRESS_REQUIRED')
  }
  return Object.freeze({ schemaVersion: 1, hostname, addresses: Object.freeze([...input.addresses]), acmeEmail: input.acmeEmail, acceptAcmeTerms: true })
}

export function parseConfigArguments(args) {
  const input = { schemaVersion: 1, addresses: [], acceptAcmeTerms: false }
  const seen = new Set()
  for (const arg of args) {
    if (arg === '--accept-acme-terms') { if (seen.has(arg)) fail('DUPLICATE_ARGUMENT'); seen.add(arg); input.acceptAcmeTerms = true; continue }
    const match = /^(--management-hostname|--management-address|--acme-email)=(.+)$/.exec(arg)
    if (!match) fail('UNKNOWN_ARGUMENT')
    const [, key, value] = match
    if (key === '--management-address') input.addresses.push(value)
    else { if (seen.has(key)) fail('DUPLICATE_ARGUMENT'); seen.add(key); input[key === '--management-hostname' ? 'hostname' : 'acmeEmail'] = value }
  }
  return validateConfig(input)
}

export function requiredEnvironment(config) {
  const points = profiles(config)
  return {
    XPANEL_HOST: '127.0.0.1', XPANEL_PANEL_PORT: '12083', XPANEL_WHM_PORT: '12087', XPANEL_MAIL_PORT: '12096',
    XPANEL_PANEL_PUBLIC_ORIGIN: `https://${points[0].host}:2083`, XPANEL_WHM_PUBLIC_ORIGIN: `https://${points[1].host}:2087`, XPANEL_MAIL_PUBLIC_ORIGIN: `https://${points[2].host}:2096`,
    XPANEL_SERVER_SECRET_FILE: '/etc/xpanel/server.secret', XPANEL_INGRESS_SECRET_FILE: PATHS.secret,
  }
}

/** Existing nonempty settings are never silently migrated, and unrelated lines survive byte-for-byte. */
export function mergeApiEnvironment(content, config) {
  const required = requiredEnvironment(config)
  // EnvironmentFile supports quoting, whitespace and continuation rules. Refuse
  // ambiguous spellings rather than silently appending a higher-precedence key.
  if (/\\\r?\n/.test(content)) fail('API_ENV_EXPLICIT_MIGRATION_REQUIRED')
  const knownKey = new RegExp(`^\\s*(?:export\\s+)?(?:${Object.keys(required).join('|')})(?:\\s*=|\\s*$)`)
  for (const line of content.split(/\r?\n/)) {
    if (knownKey.test(line) && !/^[A-Z][A-Z0-9_]*=/.test(line)) fail('API_ENV_EXPLICIT_MIGRATION_REQUIRED')
  }
  const seen = new Set()
  const output = content.split(/(?<=\n)/).map(line => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*?)(\r?\n)?$/.exec(line)
    if (!match || !Object.hasOwn(required, match[1])) return line
    const [, key, value, ending = ''] = match
    if (seen.has(key)) fail('API_ENV_DUPLICATE_SETTING')
    seen.add(key)
    if (value !== '' && value !== required[key]) fail('API_ENV_EXPLICIT_MIGRATION_REQUIRED')
    return `${key}=${required[key]}${ending}`
  }).join('')
  const missing = Object.entries(required).filter(([key]) => !seen.has(key)).map(([key, value]) => `${key}=${value}\n`).join('')
  return output + (missing && output && !output.endsWith('\n') ? '\n' : '') + missing
}

const listen = (config, port, ssl = false) => config.addresses.map(address => `    listen ${isIP(address) === 6 ? `[${address}]` : address}:${port}${ssl ? ' ssl' : ''};`).join('\n')
export function renderChallenge(config) {
  return MARKER + profiles(config).map(point => `server {
${listen(config, 80)}
    server_name ${point.host};
    if ($host != "${point.host}") { return 421; }
    location ~ "^/\\.well-known/acme-challenge/[A-Za-z0-9_-]{1,128}$" {
        root ${PATHS.webroot};
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 308 https://${point.host}:${point.port}$request_uri; }
}
`).join('\n')
}

export function renderIngress(config, generation) {
  if (!/^[a-f0-9]{64}$/.test(generation)) fail('CERTIFICATE_GENERATION_INVALID')
  const certificate = `${PATHS.certs}/${generation}`
  const tls = `    ssl_certificate ${certificate}/fullchain.pem;\n    ssl_certificate_key ${certificate}/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;`
  return MARKER + `map $http_upgrade $xpanel_management_connection_upgrade { default upgrade; '' close; }\n\n` + profiles(config).map(point => `server {
${listen(config, 443, true)}
    server_name ${point.host};
${tls}
    if ($host != "${point.host}") { return 421; }
    return 308 https://${point.host}:${point.port}$request_uri;
}
server {
${listen(config, point.port, true)}
    server_name ${point.host};
${tls}
    if ($http_host != "${point.host}:${point.port}") { return 421; }
    add_header X-Content-Type-Options nosniff always;
    location / {
        proxy_pass http://127.0.0.1:${point.backend};
        include ${PATHS.include};
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Forwarded "";
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $xpanel_management_connection_upgrade;
    }
}
`).join('\n')
}

export function renderRenewalUnits(nodePath, layout = 'flat') {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(nodePath)) fail('NODE_PATH_INVALID')
  if (!['flat', 'current'].includes(layout)) fail('PROGRAM_LAYOUT_INVALID')
  const programRoot = layout === 'current' ? '/opt/xpanel/current' : '/opt/xpanel'
  return {
    service: MARKER + `[Unit]\nDescription=xPanel management TLS renewal and served-certificate verification\nAfter=network-online.target nginx.service\nWants=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nGroup=root\nUMask=0077\nExecStart=${nodePath} ${programRoot}/scripts/management-tls.mjs renew\nSuccessExitStatus=75\nTimeoutStartSec=720\nTimeoutStopSec=10\nKillMode=control-group\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectHome=yes\n\n`,
    timer: MARKER + '[Unit]\nDescription=xPanel management TLS renewal schedule\n\n[Timer]\nOnCalendar=*-*-* 00,12:00:00\nRandomizedDelaySec=1h\nPersistent=true\nUnit=xpanel-management-tls.service\n\n[Install]\nWantedBy=timers.target\n',
  }
}

export function certbotArguments(config) {
  return ['certonly', '--config', `${PATHS.acme}/cli.ini`, '--config-dir', PATHS.acme, '--work-dir', `${PATHS.state}/acme-work`, '--logs-dir', PATHS.logs,
    '--server', ACME_DIRECTORY, '--non-interactive', '--agree-tos', '--email', config.acmeEmail, '--no-directory-hooks',
    '--webroot', '--webroot-path', PATHS.webroot, '--preferred-challenges', 'http-01', '--cert-name', 'xpanel-management', '--keep-until-expiring',
    ...profiles(config).flatMap(point => ['-d', point.host])]
}

function trustedDirectory(path) {
  let current = resolve(path)
  while (true) {
    const st = lstatSync(current)
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0) fail('UNTRUSTED_DIRECTORY')
    if (current === '/') return
    current = dirname(current)
  }
}
function rootDirectory(path, mode = 0o700) {
  trustedDirectory(dirname(path))
  if (!existsSync(path)) {
    mkdirSync(path, { mode })
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      if (fstatSync(fd).uid !== 0) fail('UNTRUSTED_DIRECTORY')
      fchownSync(fd, 0, 0); fchmodSync(fd, mode); fsyncSync(fd)
    } finally { closeSync(fd) }
    syncParent(path)
  }
  trustedDirectory(path)
  if ((lstatSync(path).mode & 0o7777) !== mode) fail('MANAGED_DIRECTORY_MODE_INVALID')
}
function readRootFile(path, maxBytes = 1024 * 1024, privateFile = false) {
  trustedDirectory(dirname(path))
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o6022) !== 0 || st.size > maxBytes || (privateFile && (st.mode & 0o077) !== 0)) fail('UNTRUSTED_FILE')
    return { bytes: readFileSync(fd), st }
  } finally { closeSync(fd) }
}
function trustedExecutable(path) {
  trustedDirectory(dirname(path))
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o6022) !== 0 || (st.mode & 0o111) === 0) fail('UNTRUSTED_EXECUTABLE')
  } finally { closeSync(fd) }
}
function syncParent(path) { const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd) } finally { closeSync(fd) } }
function replaceFile(path, bytes, mode, gid = 0, published = () => {}) {
  trustedDirectory(dirname(path))
  const temporary = `${path}.tmp.${stamp()}`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    fchownSync(fd, 0, gid); fchmodSync(fd, mode); writeFileSync(fd, bytes); fsyncSync(fd)
    renameSync(temporary, path)
    published({ bytes: Buffer.from(bytes), st: fstatSync(fd) })
    syncParent(path)
  } finally { closeSync(fd) }
}
function existing(path) {
  try { return readRootFile(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function observeChildBirth(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
    if (!/^[1-9][0-9]*$/.test(fields[19]) || Number(fields[2]) !== pid || Number(fields[3]) !== pid) return null
    return { pid, kernelStartTime: fields[19], processGroupId: Number(fields[2]), sessionId: Number(fields[3]) }
  } catch { return null }
}

/** Fixed argv-only root tools. Uncertain effects are retained, never signalled by a recycled PGID. */
async function command(operation, executable, args, timeoutMs = 30_000, extraFd, acceptedExitCodes = [0]) {
  trustedExecutable(executable)
  const activePath = `${PATHS.state}/active-command.json`
  // The lock operation itself must not modify another holder's command receipt.
  const tracked = operation !== 'management-tls-lock'
  let receipt
  if (tracked) {
    const fd = openSync(activePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { receipt = JSON.stringify({ operation, at: new Date().toISOString(), state: 'launching-or-running' }) + '\n'; writeFileSync(fd, receipt); fsyncSync(fd) } finally { closeSync(fd) }
    syncParent(activePath)
  }
  return new Promise((resolveCommand, reject) => {
    const acmeEnvironment = operation === 'certbot-management-issuance-or-renewal' ? { HOME: PATHS.state, XDG_CONFIG_HOME: `${PATHS.acme}/xdg` } : { HOME: '/root' }
    const child = spawn(executable, args, { detached: true, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', ...acmeEnvironment }, stdio: ['ignore', 'pipe', 'pipe', ...(extraFd === undefined ? [] : [extraFd])] })
    let length = 0, timer, settled = false, birth = observeChildBirth(child.pid)
    const chunks = [[], []]
    const attention = reason => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy(); child.stderr.destroy(); child.unref()
      // Closing streams and unref are not cancellation. The durable receipt is
      // retained and later invocations refuse to retry or roll back these effects.
      reject(Object.assign(new Error(reason), { code: reason, details: { operation, remainingProcessGroup: true, hardTermination: false } }))
    }
    timer = setTimeout(() => attention('CHILD_DEADLINE_ATTENTION'), timeoutMs)
    for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', chunk => { length += chunk.length; if (length <= 4 * 1024 * 1024) chunks[index].push(chunk); else attention('CHILD_OUTPUT_LIMIT_ATTENTION') })
    child.once('spawn', () => {
      if (!tracked) return
      try {
        if (readRootFile(activePath, 1024, true).bytes.toString('utf8') !== receipt) fail('COMMAND_RECEIPT_DRIFT')
        birth ??= observeChildBirth(child.pid)
        const next = JSON.stringify({ operation, executable, pid: child.pid, birth, at: new Date().toISOString(), state: 'running-or-draining' }) + '\n'
        replaceFile(activePath, next, 0o600)
        receipt = next
      } catch { attention('COMMAND_RECEIPT_ATTENTION') }
    })
    child.once('error', () => { /* close observes the failed spawn and retires its receipt only after drain. */ })
    child.once('close', async (code, signal) => {
      if (settled) return
      clearTimeout(timer)
      if (!Number.isInteger(child.pid) || child.pid < 1) {
        settled = true
        try { if (tracked) { unlinkSync(activePath); syncParent(activePath) } } catch { reject(Object.assign(new Error('COMMAND_RECEIPT_DRIFT'), { code: 'COMMAND_RECEIPT_DRIFT', details: { operation, remainingProcessGroup: true } })); return }
        reject(Object.assign(new Error('COMMAND_SPAWN_FAILED'), { code: 'COMMAND_SPAWN_FAILED', details: { operation, remainingProcessGroup: false } }))
        return
      }
      if (!birth) { attention('CHILD_BIRTH_UNOBSERVED_ATTENTION'); return }
      // Signal0 is observation only. A remaining/reused numeric group is never
      // TERM/KILLed after reap. PID1 unit lifetime qualification remains separate.
      try { process.kill(-child.pid, 0); attention('UNEXPECTED_DESCENDANTS_ATTENTION'); return } catch (error) { if (error.code !== 'ESRCH') { attention('CHILD_GROUP_UNOBSERVED_ATTENTION'); return } }
      const result = { operation, exitCode: code, signal, outputBytes: length, remainingProcessGroup: false, birth }
      settled = true
      try {
        if (tracked) {
          if (readRootFile(activePath, 1024, true).bytes.toString('utf8') !== receipt) fail('COMMAND_RECEIPT_DRIFT')
          unlinkSync(activePath); syncParent(activePath)
        }
      } catch { reject(Object.assign(new Error('COMMAND_RECEIPT_DRIFT'), { code: 'COMMAND_RECEIPT_DRIFT', details: { operation, remainingProcessGroup: true } })); return }
      if (!acceptedExitCodes.includes(code) || signal) return reject(Object.assign(new Error('COMMAND_FAILED'), { code: 'COMMAND_FAILED', details: result }))
      resolveCommand({ ...result, stdout: Buffer.concat(chunks[0]).toString('utf8'), stderr: Buffer.concat(chunks[1]).toString('utf8') })
    })
  })
}

export function sameFileVersion(left, right) {
  if (!left || !right) return left === right
  return sha(left.bytes) === sha(right.bytes) && ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs'].every(key => left.st[key] === right.st[key])
}

class OwnedTransaction {
  entries = []
  journalVersion = null
  journalPath = `${PATHS.state}/active-transition.json`
  begin(metadata) {
    this.metadata = metadata
    const fd = openSync(this.journalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, ...metadata, entries: [] }) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    syncParent(this.journalPath)
    this.journalVersion = readRootFile(this.journalPath, 1024 * 1024, true)
  }
  assertJournal() {
    if (this.journalVersion && !sameFileVersion(readRootFile(this.journalPath, 1024 * 1024, true), this.journalVersion)) fail('TRANSITION_JOURNAL_CONCURRENT_DRIFT')
  }
  record() {
    this.assertJournal()
    // Never serialize original/published bytes: the include contains a credential.
    const entries = this.entries.map(entry => ({ path: entry.path, beforeSha256: entry.before, afterSha256: entry.after, backup: entry.backup, published: Boolean(entry.published) }))
    replaceFile(this.journalPath, JSON.stringify({ schemaVersion: 1, ...this.metadata, entries }) + '\n', 0o600)
    this.journalVersion = readRootFile(this.journalPath, 1024 * 1024, true)
  }
  retire() {
    if (!this.journalVersion) return
    this.assertJournal()
    unlinkSync(this.journalPath); syncParent(this.journalPath)
    this.journalVersion = null
  }
  expectedVersion(path, fallback) {
    const entry = this.entries.find(item => item.path === path)
    return entry ? entry.published ?? entry.original : fallback
  }
  async write(path, bytes, mode = 0o644, gid = 0, allowUnmanaged = false, expectedVersion = undefined) {
    if (this.entries.some(item => item.path === path)) fail('TRANSACTION_DUPLICATE_PATH')
    const before = existing(path)
    if (expectedVersion !== undefined && !sameFileVersion(before, expectedVersion)) fail('ORIGINAL_REFERENCE_DRIFT')
    if (before && !allowUnmanaged && !before.bytes.toString('utf8').startsWith(MARKER)) fail('UNMANAGED_FILE_MIGRATION_REQUIRED')
    const entry = { path, before: before ? sha(before.bytes) : null, after: sha(bytes), backup: null, mode, gid, original: before, published: null }
    if (before && entry.before === entry.after && (before.st.mode & 0o777) === mode && before.st.gid === gid) return
    if (before) entry.backup = `${path}.bak.${stamp()}`
    this.entries.push(entry)
    this.record()
    if (before) {
      if (existsSync(entry.backup)) fail('BACKUP_DESTINATION_EXISTS')
      await command('backup-managed-file', '/usr/bin/cp', ['-a', '--', path, entry.backup])
      const backup = readRootFile(entry.backup)
      if (sha(backup.bytes) !== entry.before || (backup.st.mode & 0o777) !== (before.st.mode & 0o777) || backup.st.gid !== before.st.gid) fail('BACKUP_SOURCE_DRIFT')
    }
    const current = existing(path)
    if (!sameFileVersion(current, before)) fail('CONCURRENT_CONFIG_DRIFT')
    replaceFile(path, bytes, mode, gid, observation => { entry.published = observation; this.record() })
  }
  async rollback() {
    this.assertJournal()
    for (const entry of [...this.entries].reverse()) {
      const current = existing(entry.path)
      if (!entry.published && sameFileVersion(current, entry.original)) continue
      if (!entry.published || !sameFileVersion(current, entry.published)) fail('ROLLBACK_CONCURRENT_CONFIG_DRIFT')
      if (entry.backup) {
        const backup = readRootFile(entry.backup)
        if (sha(backup.bytes) !== entry.before) fail('ROLLBACK_BACKUP_DRIFT')
        replaceFile(entry.path, backup.bytes, backup.st.mode & 0o777, backup.st.gid)
      } else { unlinkSync(entry.path); syncParent(entry.path) }
    }
  }
}

function assertOriginalReferences(references) {
  for (const [path, expected] of references) if (!sameFileVersion(existing(path), expected)) fail('ORIGINAL_REFERENCE_DRIFT')
}

async function nginxReload() {
  const result = await command('nginx-config-test', '/usr/sbin/nginx', ['-t'])
  if (/conflicting server name|duplicate listen|emerg|warn/i.test(result.stderr)) fail('NGINX_CONFIG_CONFLICT')
  await command('nginx-reload', '/usr/bin/systemctl', ['reload', 'nginx.service'])
}

async function assertNginxInvocation(expected) {
  const current = await nginxState()
  if (current.ActiveState !== 'active' || current.InvocationID !== expected.InvocationID || current.MainPID !== expected.MainPID) fail('NGINX_CONCURRENT_INVOCATION_DRIFT')
}

async function nginxState() {
  const result = await command('read-nginx-service-state', '/usr/bin/systemctl', ['show', 'nginx.service', '--all', '--property=LoadState,ActiveState,SubState,InvocationID,MainPID'])
  const value = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')))
  if (value.LoadState !== 'loaded' || !['active:running', 'inactive:dead'].includes(`${value.ActiveState}:${value.SubState}`)) fail('INGRESS_BOOTSTRAP_BLOCKED_SERVICE_STATE')
  if (value.ActiveState === 'active' && (!/^[a-f0-9]{32}$/.test(value.InvocationID) || !/^[1-9][0-9]*$/.test(value.MainPID))) fail('NGINX_INVOCATION_UNOBSERVED')
  return value
}

async function renewalTimerState(expectedFiles = new Map()) {
  const references = new Map()
  let timer
  for (const [name, path] of [['xpanel-management-tls.timer', PATHS.timer], ['xpanel-management-tls.service', PATHS.service]]) {
    const result = await command('read-management-renewal-unit', '/usr/bin/systemctl', ['show', name, '--all', '--property=LoadState,ActiveState,SubState,UnitFileState,InvocationID,FragmentPath,DropInPaths'], 5_000, undefined, [0, 1])
    const state = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')))
    const file = existing(path)
    if (file && ((file.st.mode & 0o7777) !== 0o644 || !file.bytes.toString('utf8').startsWith(MARKER))) fail('RENEWAL_UNIT_CONFIGURATION_UNOWNED')
    if (state.DropInPaths !== '') fail('RENEWAL_UNIT_CONFIGURATION_UNOWNED')
    if (state.LoadState === 'not-found') {
      if (state.ActiveState !== 'inactive' || state.FragmentPath !== '' || (file && (!expectedFiles.has(path) || !sameFileVersion(file, expectedFiles.get(path))))) fail('RENEWAL_UNIT_CONFIGURATION_UNOWNED')
    } else if (state.LoadState !== 'loaded' || !file || state.FragmentPath !== path || realpathSync(state.FragmentPath) !== path) fail('RENEWAL_UNIT_CONFIGURATION_UNOWNED')
    if (name.endsWith('.timer')) {
      if (state.LoadState === 'loaded' && (!['enabled', 'disabled'].includes(state.UnitFileState) || !['inactive:dead', 'active:waiting', 'active:elapsed', 'active:running'].includes(`${state.ActiveState}:${state.SubState}`))) fail('RENEWAL_TIMER_EXPLICIT_MIGRATION_REQUIRED')
      timer = state
    }
    references.set(path, file)
  }
  return { ...timer, references }
}

function assertTimerSnapshot(original, current, expectedFiles, afterOwnReload = false) {
  assertOriginalReferences(expectedFiles)
  for (const [path, expected] of expectedFiles) if (!sameFileVersion(current.references.get(path), expected)) fail('RENEWAL_TIMER_CONCURRENT_DRIFT')
  if (original.LoadState === 'not-found' && afterOwnReload) {
    if (current.LoadState !== 'loaded' || current.ActiveState !== 'inactive' || current.SubState !== 'dead' || current.UnitFileState !== 'disabled' || current.InvocationID !== '') fail('RENEWAL_TIMER_CONCURRENT_DRIFT')
  } else for (const key of ['LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'InvocationID', 'FragmentPath', 'DropInPaths']) if (original[key] !== current[key]) fail('RENEWAL_TIMER_CONCURRENT_DRIFT')
}

async function nginxConfigurationDigest() {
  // nginx -T includes protected directives. Retain only the digest in memory;
  // stdout/stderr never enters a report or the terminal.
  const result = await command('read-nginx-configuration-digest', '/usr/sbin/nginx', ['-T'])
  if (/conflicting server name|duplicate listen|emerg|warn/i.test(result.stderr)) fail('NGINX_CONFIG_CONFLICT')
  return sha(result.stdout)
}

async function preflightUnusedListeners(config) {
  const inventory = await command('read-ingress-listeners', '/usr/bin/ss', ['--listening', '--tcp', '--numeric', '--no-header', '--processes'])
  const inventorySha256 = sha(inventory.stdout)
  // An exclusive real bind refuses Apache, legacy APIs and wildcard listeners.
  // No other service is stopped and no firewall/default vhost is rewritten.
  for (const address of config.addresses) for (const port of [80, 443, 2083, 2087, 2096]) {
    await new Promise((resolveProbe, reject) => {
      const server = createServer(socket => socket.destroy())
      const timer = setTimeout(() => { server.close(); reject(Object.assign(new Error('INGRESS_BOOTSTRAP_BLOCKED_LISTENER'), { code: 'INGRESS_BOOTSTRAP_BLOCKED_LISTENER' })) }, 2_000)
      server.once('error', () => { clearTimeout(timer); reject(Object.assign(new Error('INGRESS_BOOTSTRAP_BLOCKED_LISTENER'), { code: 'INGRESS_BOOTSTRAP_BLOCKED_LISTENER' })) })
      server.listen({ host: address, port, exclusive: true, ipv6Only: true }, () => server.close(error => { clearTimeout(timer); if (error) reject(error); else resolveProbe() }))
    })
  }
  return inventorySha256
}

export async function awaitReadiness(probe, { timeoutMs = 30_000, intervalMs = 250, now = () => performance.now(), sleep = delay } = {}) {
  const end = now() + timeoutMs
  let attempts = 0
  do {
    attempts++
    try { const result = await probe({ deadline: end, now }); if (now() >= end) fail('READINESS_DEADLINE_EXCEEDED'); return { attempts, result } } catch {}
    if (now() >= end) break
    await sleep(Math.min(intervalMs, end - now()))
  } while (now() < end)
  fail('SERVED_READINESS_FAILED')
}

function request(address, point, path, secure = true, port = point.port, fingerprint, deadline = performance.now() + 2_000) {
  return new Promise((resolveRequest, reject) => {
    const remaining = Math.min(2_000, deadline - performance.now())
    if (remaining <= 0) { reject(new Error('HTTP_DEADLINE')); return }
    const requester = secure ? httpsRequest : httpRequest
    const req = requester({ hostname: address, port, path, method: 'GET', servername: point.host, rejectUnauthorized: true, headers: { Host: `${point.host}${port === 80 || port === 443 ? '' : `:${port}`}`, Connection: 'close' }, agent: false }, res => {
      const peer = secure ? res.socket.getPeerCertificate() : null
      if (secure && (!res.socket.authorized || !peer?.raw || (fingerprint && sha(peer.raw) !== fingerprint))) { res.destroy(); reject(new Error('SERVED_CERTIFICATE_MISMATCH')); return }
      const chunks = []; let size = 0
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { res.destroy(); reject(new Error('HTTP_RESPONSE_TOO_LARGE')) } else chunks.push(chunk) })
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), fingerprint: peer?.raw ? sha(peer.raw) : null }))
      res.on('error', reject)
    })
    // A total wall deadline also bounds a peer that continuously drips bytes.
    const timer = setTimeout(() => req.destroy(new Error('HTTP_TIMEOUT')), remaining)
    req.once('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end()
  })
}

async function dnsPreflight(config) {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 })
  for (const point of profiles(config)) {
    const records = await Promise.all([resolver.resolve4(point.host).catch(error => { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error }), resolver.resolve6(point.host).catch(error => { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) return []; throw error })])
    const actual = records.flat()
    if (!actual.length || actual.some(address => !config.addresses.includes(address)) || config.addresses.some(address => !actual.includes(address))) fail('DNS_DOES_NOT_MATCH_EXPLICIT_ADDRESSES')
  }
}

function readCertificate(config) {
  const lineage = `${PATHS.acme}/live/xpanel-management`
  const read = (name, maximum) => {
    const target = realpathSync(`${lineage}/${name}`)
    if (!target.startsWith(`${PATHS.acme}/archive/xpanel-management/`)) fail('CERTBOT_LINEAGE_OUTSIDE_MANAGED_SCOPE')
    return readRootFile(target, maximum, name === 'privkey.pem').bytes
  }
  const fullchain = read('fullchain.pem', 128 * 1024), key = read('privkey.pem', 32 * 1024)
  const certificate = new X509Certificate(fullchain), names = certificate.subjectAltName?.split(', ').map(name => name.startsWith('DNS:') ? name.slice(4) : '')
  const expected = profiles(config).map(point => point.host).sort()
  if (!names || names.length !== 3 || names.sort().join(',') !== expected.join(',') || !certificate.checkPrivateKey(createPrivateKey(key))) fail('CERTIFICATE_IDENTITIES_OR_KEY_INVALID')
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) - Date.now() < 7 * 86_400_000) fail('CERTIFICATE_VALIDITY_INSUFFICIENT')
  return { fullchain, key, generation: sha(certificate.raw), expiresAt: new Date(certificate.validTo).toISOString() }
}

function installedCertificate(config) {
  const ingress = existing(PATHS.ingress)
  if (!ingress) return null
  const text = ingress.bytes.toString('utf8')
  const generation = /ssl_certificate \/etc\/xpanel\/management-certificates\/([a-f0-9]{64})\/fullchain\.pem;/.exec(text)?.[1]
  if (!generation || text !== renderIngress(config, generation)) fail('MANAGED_INGRESS_EXPLICIT_MIGRATION_REQUIRED')
  const certificate = new X509Certificate(readRootFile(`${PATHS.certs}/${generation}/fullchain.pem`, 128 * 1024, true).bytes)
  if (sha(certificate.raw) !== generation) fail('INSTALLED_CERTIFICATE_DRIFT')
  return { generation }
}

function assertNoCertbotHooks() {
  // Certbot's ConfigArgParse reads default files in addition to --config. Do not
  // execute inherited hooks or silently amend another operator's global choices.
  for (const path of ['/etc/letsencrypt/cli.ini', `${PATHS.acme}/xdg/letsencrypt/cli.ini`]) {
    const global = existing(path)
    if (global) assertIsolatedDefaultConfig(global.bytes.toString('utf8'))
  }
  const renewal = existing(`${PATHS.acme}/renewal/xpanel-management.conf`)
  if (renewal && /^\s*(?:pre_hook|post_hook|renew_hook|deploy_hook)\s*=\s*\S/m.test(renewal.bytes.toString('utf8'))) fail('ACME_UNREVIEWED_HOOK_REFUSED')
}

export function assertIsolatedDefaultConfig(text) {
  if (text.split(/\r?\n/).some(line => { const value = line.trim(); return value && !value.startsWith('#') && !value.startsWith(';') })) fail('ACME_GLOBAL_CONFIGURATION_REVIEW_REQUIRED')
}

export function renewalObservation(previousFingerprint, currentFingerprint, priorWasObserved = true) {
  if (!/^[a-f0-9]{64}$/.test(currentFingerprint) || (previousFingerprint !== null && !/^[a-f0-9]{64}$/.test(previousFingerprint))) fail('FINGERPRINT_INVALID')
  if (previousFingerprint === null) return 'initial-certificate-served'
  if (!priorWasObserved) return previousFingerprint === currentFingerprint ? 'baseline-repaired-with-existing-certificate' : 'replacement-served-with-unhealthy-baseline'
  return previousFingerprint === currentFingerprint ? 'checked-unchanged' : 'certificate-rotation-served-observed'
}

function saveStatus(value) {
  const bytes = JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...value }, null, 2) + '\n'
  replaceFile(`${PATHS.state}/status-${stamp()}.json`, bytes, 0o600)
  replaceFile(`${PATHS.state}/status.json`, bytes, 0o600)
}

async function servedReady(config, certificate, verifyApplication) {
  return awaitReadiness(async ({ deadline }) => {
    for (const address of config.addresses) for (const point of profiles(config)) {
      const redirect = await request(address, point, '/login', true, 443, certificate.generation, deadline)
      if (redirect.status !== 308 || redirect.headers.location !== `https://${point.host}:${point.port}/login`) fail('CANONICAL_REDIRECT_INVALID')
      const login = await request(address, point, '/login', true, point.port, certificate.generation, deadline)
      if (verifyApplication && (login.status !== 200 || !login.headers['content-type']?.startsWith('text/html') || !login.body.includes(`data-login-audience="${point.name}"`))) fail('APPLICATION_LOGIN_NOT_READY')
      // TLS preparation explicitly permits an unavailable backend; it never reports application health.
      if (verifyApplication) {
        const health = await request(address, point, '/api/health', true, point.port, certificate.generation, deadline)
        if (health.status !== 200 || !health.headers['content-type']?.startsWith('application/json') || JSON.parse(health.body)?.ok !== true) fail('APPLICATION_HEALTH_NOT_READY')
      }
    }
    return { fingerprint: certificate.generation, application: verifyApplication ? 'ingress-observed-ready' : 'bootstrap-pending' }
  })
}

async function lifecycle(config, phase, configReference, layout = 'flat') {
  const transaction = new OwnedTransaction()
  let configChanged = false
  let initialNginx, startedNginx, initialConfiguration, listenerInventorySha256
  let startAttempted = false, priorCertificate
  let initialTimer, enabledTimer, timerEnableAttempted = false
  const managedReferences = new Map()
  let originalReferences = []
  let priorObservation = { state: 'not-serving', installedFingerprint: null, observedFingerprint: null }
  try {
    if (!configReference || JSON.stringify(validateConfig(JSON.parse(configReference.bytes.toString('utf8')))) !== JSON.stringify(config)) fail('MANAGEMENT_CONFIG_REFERENCE_REQUIRED')
    assertOriginalReferences([[PATHS.config, configReference]])
    for (const path of [PATHS.challenge, PATHS.ingress, PATHS.include, PATHS.service, PATHS.timer]) {
      const old = existing(path)
      managedReferences.set(path, old)
      if (old && !old.bytes.toString('utf8').startsWith(MARKER)) fail('UNMANAGED_FILE_MIGRATION_REQUIRED')
      if (old && path === PATHS.include && (old.st.mode & 0o7777) !== 0o600) fail('INGRESS_INCLUDE_REVIEW_REQUIRED')
    }
    initialTimer = await renewalTimerState()
    initialNginx = await nginxState()
    if (phase !== 'prepare' && initialNginx.ActiveState !== 'active') fail('INGRESS_BOOTSTRAP_BLOCKED_INACTIVE_NGINX')
    initialConfiguration = await nginxConfigurationDigest()
    if (initialNginx.ActiveState === 'inactive') listenerInventorySha256 = await preflightUnusedListeners(config)
    await dnsPreflight(config)
    const group = await command('read-api-reader-group', '/usr/bin/getent', ['group', 'xpanel'], 5_000)
    const readerGid = /^xpanel:[^:\n]*:([1-9][0-9]*):[^\n]*\n?$/.exec(group.stdout)?.[1]
    if (!readerGid) fail('API_READER_GROUP_INVALID')
    const secret = readRootFile(PATHS.secret, 65)
    if ((secret.st.mode & 0o777) !== 0o640 || secret.st.gid !== Number(readerGid) || !/^[a-f0-9]{64}\n?$/.test(secret.bytes.toString('utf8'))) fail('INGRESS_SECRET_INVALID')
    const api = readRootFile(PATHS.apiEnv)
    if (![0o600, 0o640].includes(api.st.mode & 0o777) || api.st.gid !== secret.st.gid) fail('API_ENV_READER_INVALID')
    const merged = mergeApiEnvironment(api.bytes.toString('utf8'), config)
    originalReferences = [[PATHS.config, configReference], [PATHS.secret, secret], [PATHS.apiEnv, api]]
    if (phase === 'renew' && merged !== api.bytes.toString('utf8')) fail('API_ENV_NOT_PREPARED')
    if (phase === 'verify') {
      if (merged !== api.bytes.toString('utf8')) fail('API_ENV_NOT_PREPARED')
      const certificate = readCertificate(config)
      const result = await servedReady(config, certificate, true)
      assertOriginalReferences(originalReferences)
      saveStatus({ phase, status: 'ingress-observed-ready', fingerprint: certificate.generation, expiresAt: certificate.expiresAt, applicationBootstrap: 'identity-and-optional-MFA-remain-independent', attempts: result.attempts })
      return
    }
    priorCertificate = installedCertificate(config)
    priorObservation.installedFingerprint = priorCertificate?.generation ?? null
    if (priorCertificate && initialNginx.ActiveState === 'active') {
      try {
        await servedReady(config, priorCertificate, false)
        priorObservation = { ...priorObservation, state: 'trusted-observed', observedFingerprint: priorCertificate.generation }
      } catch { priorObservation = { ...priorObservation, state: 'baseline-unhealthy' } }
    }
    if (phase === 'renew' && !priorCertificate) fail('MANAGED_INGRESS_NOT_PREPARED')
    assertNoCertbotHooks()
    assertOriginalReferences([...originalReferences, ...managedReferences])
    transaction.begin({ phase, startedAt: new Date().toISOString(), managementConfigSha256: sha(JSON.stringify(config)), initialNginx, initialTimer: Object.fromEntries(Object.entries(initialTimer).filter(([key]) => key !== 'references')), initialConfiguration })
    await transaction.write(PATHS.challenge, renderChallenge(config), 0o644, 0, false, managedReferences.get(PATHS.challenge))
    configChanged = true
    if (initialNginx.ActiveState === 'active') { await assertNginxInvocation(initialNginx); await nginxReload() }
    else {
      const tested = await command('nginx-start-config-test', '/usr/sbin/nginx', ['-t'])
      if (/conflicting server name|duplicate listen|emerg|warn/i.test(tested.stderr)) fail('NGINX_CONFIG_CONFLICT')
      // Recheck state immediately before the only permitted service start.
      const beforeStart = await nginxState()
      if (JSON.stringify(beforeStart) !== JSON.stringify(initialNginx)) fail('NGINX_CONCURRENT_SERVICE_TRANSITION')
      startAttempted = true
      await command('start-owned-nginx-ingress', '/usr/bin/systemctl', ['start', 'nginx.service'])
      startedNginx = await nginxState()
      if (startedNginx.ActiveState !== 'active' || startedNginx.InvocationID === initialNginx.InvocationID) fail('NGINX_START_NOT_OBSERVED')
      transaction.metadata.startedNginx = startedNginx
      transaction.record()
    }
    const nonce = randomBytes(24).toString('hex'), tokenPath = `${PATHS.webroot}/.well-known/acme-challenge/${nonce}`
    replaceFile(tokenPath, nonce, 0o644)
    try {
      await awaitReadiness(async ({ deadline }) => {
        for (const address of config.addresses) for (const point of profiles(config)) {
          const response = await request(address, point, `/.well-known/acme-challenge/${nonce}`, false, 80, undefined, deadline)
          if (response.status !== 200 || response.body !== nonce) fail('HTTP01_ROUTE_NOT_READY')
        }
      })
    } finally { if (sha(readRootFile(tokenPath).bytes) !== sha(nonce)) fail('CHALLENGE_CONCURRENT_DRIFT'); unlinkSync(tokenPath); syncParent(tokenPath) }
    await command('certbot-management-issuance-or-renewal', '/usr/bin/certbot', certbotArguments(config), 600_000)
    assertOriginalReferences([...originalReferences, ...[...managedReferences].map(([path, original]) => [path, transaction.expectedVersion(path, original)])])
    const certificate = readCertificate(config), generation = `${PATHS.certs}/${certificate.generation}`
    rootDirectory(generation)
    for (const [name, bytes] of [['fullchain.pem', certificate.fullchain], ['privkey.pem', certificate.key]]) {
      const target = `${generation}/${name}`, old = existing(target)
      if (old && sha(old.bytes) !== sha(bytes)) fail('CERTIFICATE_GENERATION_DRIFT')
      if (!old) replaceFile(target, bytes, 0o600)
    }
    await transaction.write(PATHS.include, MARKER + `proxy_set_header X-XPanel-Ingress-Secret "${secret.bytes.toString('utf8').trim()}";\n`, 0o600, 0, false, managedReferences.get(PATHS.include))
    await transaction.write(PATHS.apiEnv, merged, api.st.mode & 0o777, api.st.gid, true, api)
    await transaction.write(PATHS.ingress, renderIngress(config, certificate.generation), 0o644, 0, false, managedReferences.get(PATHS.ingress))
    if (phase === 'prepare') {
      const beforeUnitWrite = await renewalTimerState()
      assertTimerSnapshot(initialTimer, beforeUnitWrite, initialTimer.references)
      const units = renderRenewalUnits(process.execPath, layout)
      await transaction.write(PATHS.service, units.service, 0o644, 0, false, managedReferences.get(PATHS.service))
      await transaction.write(PATHS.timer, units.timer, 0o644, 0, false, managedReferences.get(PATHS.timer))
    }
    await assertNginxInvocation(startedNginx ?? initialNginx)
    await nginxReload()
    const result = await servedReady(config, certificate, false)
    if (phase === 'prepare') {
      const expectedUnits = new Map([...initialTimer.references].map(([path, original]) => [path, transaction.expectedVersion(path, original)]))
      const beforeReload = await renewalTimerState(expectedUnits)
      assertTimerSnapshot(initialTimer, beforeReload, expectedUnits)
      await command('systemd-daemon-reload', '/usr/bin/systemctl', ['daemon-reload'])
      const beforeEnable = await renewalTimerState(expectedUnits)
      assertTimerSnapshot(initialTimer, beforeEnable, expectedUnits, true)
      if (beforeEnable.ActiveState !== 'active' || beforeEnable.UnitFileState !== 'enabled') {
        timerEnableAttempted = true
        await command('enable-management-renewal', '/usr/bin/systemctl', ['enable', '--now', 'xpanel-management-tls.timer'])
      }
      enabledTimer = await renewalTimerState(expectedUnits)
      if (enabledTimer.ActiveState !== 'active' || enabledTimer.UnitFileState !== 'enabled') fail('RENEWAL_TIMER_ACTIVATION_UNOBSERVED')
      transaction.metadata.enabledTimer = Object.fromEntries(Object.entries(enabledTimer).filter(([key]) => key !== 'references'))
      transaction.record()
    }
    await command('verify-renewal-enabled', '/usr/bin/systemctl', ['is-enabled', '--quiet', 'xpanel-management-tls.timer'])
    await command('verify-renewal-active', '/usr/bin/systemctl', ['is-active', '--quiet', 'xpanel-management-tls.timer'])
    assertOriginalReferences([...originalReferences.map(([path, original]) => [path, transaction.expectedVersion(path, original)]), ...[...managedReferences].map(([path, original]) => [path, transaction.expectedVersion(path, original)])])
    saveStatus({ phase, status: 'tls-ready', fingerprint: certificate.generation, previousInstalledFingerprint: priorObservation.installedFingerprint, previousServedFingerprint: priorObservation.observedFingerprint, priorReadiness: priorObservation.state, certificateObservation: renewalObservation(priorObservation.installedFingerprint, certificate.generation, priorObservation.state === 'trusted-observed'), expiresAt: certificate.expiresAt, applicationBootstrap: 'pending', renewal: 'timer-active-not-renewal-qualified', attempts: result.attempts, ingressStartedByTransaction: Boolean(startedNginx), listenerInventorySha256: listenerInventorySha256 ?? null })
    transaction.retire()
  } catch (error) {
    let rollback = 'not-needed'
    if (error.details?.remainingProcessGroup || existsSync(`${PATHS.state}/active-command.json`) || (startAttempted && !startedNginx) || timerEnableAttempted || ['NGINX_CONCURRENT_INVOCATION_DRIFT', 'NGINX_CONCURRENT_SERVICE_TRANSITION', 'ORIGINAL_REFERENCE_DRIFT', 'RENEWAL_TIMER_CONCURRENT_DRIFT', 'RENEWAL_UNIT_CONFIGURATION_UNOWNED'].includes(error.code)) rollback = 'blocked-preserve-concurrent-state'
    else if (transaction.entries.length || startAttempted || timerEnableAttempted) try {
      // No systemd compare-and-start primitive proves sole ownership against a
      // concurrent root actor. After an activation attempt, preserve scheduling
      // and require review rather than stopping/disabling a possibly adopted job.
      await transaction.rollback()
      if (startedNginx) {
        const observed = await nginxState()
        if (observed.InvocationID !== startedNginx.InvocationID || observed.MainPID !== startedNginx.MainPID || await nginxConfigurationDigest() !== initialConfiguration) fail('NGINX_ROLLBACK_OWNERSHIP_DRIFT')
        await command('stop-only-owned-nginx-invocation', '/usr/bin/systemctl', ['stop', 'nginx.service'])
        const stopped = await nginxState()
        if (stopped.ActiveState !== 'inactive') fail('NGINX_STOP_NOT_OBSERVED')
      } else if (configChanged && initialNginx?.ActiveState === 'active') {
        await assertNginxInvocation(initialNginx)
        await nginxReload()
        if (priorObservation.state === 'trusted-observed') await servedReady(config, priorCertificate, false)
      }
      if (transaction.entries.some(entry => [PATHS.service, PATHS.timer].includes(entry.path))) await command('rollback-systemd-daemon-reload', '/usr/bin/systemctl', ['daemon-reload'])
      rollback = priorObservation.state === 'baseline-unhealthy' ? 'owned-files-restored-prior-baseline-unhealthy' : 'owned-files-restored'
    } catch { rollback = 'blocked-preserve-concurrent-state' }
    saveStatus({ phase, status: 'failed', reason: error.code ?? 'LIFECYCLE_FAILED', operation: error.details?.operation ?? null, rollback, priorReadiness: priorObservation.state, previousInstalledFingerprint: priorObservation.installedFingerprint, previousServedFingerprint: priorObservation.observedFingerprint })
    if (rollback !== 'blocked-preserve-concurrent-state') transaction.retire()
    fail(rollback === 'blocked-preserve-concurrent-state' ? 'ROLLBACK_REQUIRES_REVIEW' : error.code ?? 'LIFECYCLE_FAILED')
  }
}

const programLayout = () => {
  const sourceRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))
  if (sourceRoot === '/opt/xpanel') return 'flat'
  if (!/^\/opt\/xpanel\/releases\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(sourceRoot)
    || realpathSync('/opt/xpanel/current') !== sourceRoot) fail('PROGRAM_LAYOUT_INVALID')
  return 'current'
}

async function main(args) {
  const [phase, ...options] = args
  if (phase === 'plan') { const config = parseConfigArguments(options); process.stdout.write(JSON.stringify({ config, origins: requiredEnvironment(config), applicationBootstrap: 'pending' }, null, 2) + '\n'); return }
  if (!['configure', 'prepare', 'verify', 'renew'].includes(phase) || (phase !== 'configure' && options.length)) fail('USAGE_INVALID')
  const desiredConfig = phase === 'configure' ? parseConfigArguments(options) : null
  if (process.platform !== 'linux' || process.getuid?.() !== 0) fail('ROOT_LINUX_REQUIRED')
  process.umask(0o077)
  readRootFile(fileURLToPath(import.meta.url))
  trustedExecutable(process.execPath)
  const sourceRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))))
  const layout = programLayout()
  if (readRootFile(`${sourceRoot}/.node-version`, 32).bytes.toString('utf8').trim() !== process.versions.node) fail('PINNED_NODE_VERSION_REQUIRED')
  trustedDirectory('/etc/xpanel')
  if (phase === 'configure') rootDirectory(PATHS.state, 0o755)
  else trustedDirectory(PATHS.state)
  const lock = openSync(`${PATHS.state}/lifecycle.lock`, (phase === 'configure' ? constants.O_CREAT : 0) | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const lockStat = fstatSync(lock)
    if (!lockStat.isFile() || lockStat.uid !== 0 || (lockStat.mode & 0o777) !== 0o600) fail('UNTRUSTED_LOCK')
    try { await command('management-tls-lock', '/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75', '3'], 5_000, lock) } catch (error) { if (error.details?.exitCode === 75) fail('LIFECYCLE_ALREADY_ACTIVE'); throw error }
    if (existsSync(`${PATHS.state}/active-command.json`)) fail('CHILD_QUIESCENCE_REVIEW_REQUIRED')
    if (existsSync(`${PATHS.state}/active-transition.json`)) fail('INTERRUPTED_TRANSITION_REVIEW_REQUIRED')
    if (phase === 'configure') {
      const config = desiredConfig, old = existing(PATHS.config)
      if (old) readRootFile(PATHS.config, 16 * 1024, true)
      if (old && JSON.stringify(validateConfig(JSON.parse(old.bytes.toString('utf8')))) !== JSON.stringify(config)) fail('MANAGEMENT_CONFIG_EXPLICIT_MIGRATION_REQUIRED')
      if (!old) replaceFile(PATHS.config, JSON.stringify(config, null, 2) + '\n', 0o600)
      return
    }
    const configReference = readRootFile(PATHS.config, 16 * 1024, true)
    const config = validateConfig(JSON.parse(configReference.bytes.toString('utf8')))
    for (const [path, mode] of [[PATHS.webroot, 0o755], [`${PATHS.webroot}/.well-known`, 0o755], [`${PATHS.webroot}/.well-known/acme-challenge`, 0o755], [PATHS.acme, 0o700], [PATHS.logs, 0o700], [`${PATHS.state}/acme-work`, 0o700], [PATHS.certs, 0o700], ['/etc/nginx/xpanel-management', 0o700]]) {
      if (phase === 'verify') trustedDirectory(path)
      else rootDirectory(path, mode)
    }
    const cli = `${PATHS.acme}/cli.ini`
    if (!existsSync(cli) && phase !== 'verify') replaceFile(cli, '# Dedicated management ACME scope.\n', 0o600)
    else if (readRootFile(cli, 256, true).bytes.toString('utf8') !== '# Dedicated management ACME scope.\n') fail('ACME_CONFIG_DRIFT')
    await lifecycle(config, phase, configReference, layout)
    process.stdout.write(phase === 'verify' ? 'Management ingress observed ready; identity and service qualification remain separate.\n' : 'Management TLS ready; application bootstrap pending.\n')
  } finally { closeSync(lock) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Management TLS failed: ${error.code ?? 'LIFECYCLE_FAILED'}. Inspect the protected lifecycle status.\n`); process.exitCode = error.code === 'LIFECYCLE_ALREADY_ACTIVE' ? 75 : 1 })
}
