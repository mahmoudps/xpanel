import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import {
  parseApacheVersion,
  parseCpuinfo,
  parseHostname,
  parseKernelRelease,
  parseNginxVersion,
  parseOsRelease,
  parsePackageVersion,
  parseProcUptime,
  parseVersionFile,
} from './host-info.ts'

export interface HostIdentity {
  hostname?: string
  system?: string
  kernel?: string
  uptimeSeconds?: number
  cores?: number
  model?: string
  engine?: string
  version?: string
  /** First DNS name on the panel certificate. */
  panelDomain?: string
  certificates?: Array<{ names: string[]; notAfter: string }>
}

export interface ObservedCertificate {
  names: string[]
  notAfter: string
  daysLeft: number
}

/** Names and expiry from a PEM. A broken certificate stays empty. */
export const certificateFromPem = (pem: string, now = Date.now()): ObservedCertificate | null => {
  let cert: X509Certificate
  try {
    cert = new X509Certificate(pem)
  } catch {
    return null
  }
  const names: string[] = []
  for (const part of (cert.subjectAltName ?? '').split(',')) {
    const trimmed = part.trim()
    if (trimmed.startsWith('DNS:')) names.push(trimmed.slice(4).trim())
    else if (trimmed.startsWith('IP Address:')) names.push(trimmed.slice('IP Address:'.length).trim())
  }
  if (names.length === 0) {
    const cn = /(?:^|,\s*)CN=([^,\n]+)/.exec(cert.subject)
    if (cn?.[1]) names.push(cn[1].trim())
  }
  const when = Date.parse(cert.validTo)
  if (!Number.isFinite(when) || names.length === 0) return null
  const daysLeft = Math.ceil((when - now) / 86_400_000)
  return { names, notAfter: new Date(when).toISOString(), daysLeft }
}

export interface HostIdentityReader {
  readFile(path: string): Promise<string | null>
  runCommand(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>
  /** PEM presented by the panel TLS listener. Pass a DNS name to send it as SNI. */
  readServedCertificate?(servername?: string): Promise<string | null>
  /** API public origin, for example the WHM PUBLIC_ORIGIN. The host is the SNI name. */
  publicOrigin?(): string | null
}

/** The panel TLS listener. nginx's catch-all certificate is a different file. */
export const PANEL_LISTENER_PORT = 8443

/**
 * `ssl_certificate` inside the server block that listens on `port`.
 * `ssl_certificate_key` is not a certificate.
 */
export const sslCertificateForListen = (config: string, port: number): string | null => {
  const blocks: string[] = []
  const opener = /\bserver\s*\{/g
  let found: RegExpExecArray | null
  while ((found = opener.exec(config)) !== null) {
    let depth = 1
    let index = found.index + found[0].length
    const start = index
    while (index < config.length && depth > 0) {
      const char = config[index]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
    blocks.push(config.slice(start, index - 1))
    opener.lastIndex = index
  }
  const listen = new RegExp(`\\blisten\\s+[^;]*\\b${port}\\b[^;]*;`, 'i')
  for (const block of blocks) {
    if (!listen.test(block)) continue
    const certificate = /(?:^|[^\w-])ssl_certificate(?!_key)\s+(['"]?)([^'";\s]+)\1\s*;/.exec(block)
    const path = certificate?.[2]
    if (path && path.startsWith('/')) return path
  }
  return null
}

/** DNS names on the server block that listens on `port`. `_` and IP addresses are skipped. */
export const serverNamesForListen = (config: string, port: number): string[] => {
  const blocks: string[] = []
  const opener = /\bserver\s*\{/g
  let found: RegExpExecArray | null
  while ((found = opener.exec(config)) !== null) {
    let depth = 1
    let index = found.index + found[0].length
    const start = index
    while (index < config.length && depth > 0) {
      const char = config[index]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
    blocks.push(config.slice(start, index - 1))
    opener.lastIndex = index
  }
  const listen = new RegExp(`\\blisten\\s+[^;]*\\b${port}\\b[^;]*;`, 'i')
  for (const block of blocks) {
    if (!listen.test(block)) continue
    const named = /(?:^|[^\w-])server_name\s+([^;]+);/.exec(block)
    if (!named?.[1]) continue
    return named[1].split(/\s+/).map(name => name.trim().toLowerCase()).filter(name => name.length > 0 && name !== '_' && isIP(name) === 0)
  }
  return []
}

const originHost = (value: string | null | undefined): string | null => {
  if (!value) return null
  try {
    const url = value.includes('://') ? new URL(value) : new URL(`https://${value}`)
    const host = url.hostname.toLowerCase()
    if (!host || isIP(host) !== 0) return null
    return host
  } catch {
    return null
  }
}

/** Peer certificate from a TLS handshake. `servername` is the SNI the panel hostname needs. */
export const readServedCertificatePem = (host: string, port: number, timeoutMs = 2000, servername?: string): Promise<string | null> =>
  new Promise((resolve) => {
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      timeout: timeoutMs,
      ...(servername ? { servername } : {}),
    }, () => {
      try {
        const peer = socket.getPeerCertificate()
        const raw = peer.raw
        socket.end()
        if (!raw || raw.length === 0) {
          done(null)
          return
        }
        const pem = new X509Certificate(raw).toString()
        done(pem.includes('BEGIN CERTIFICATE') ? pem : null)
      } catch {
        socket.destroy()
        done(null)
      }
    })
    socket.on('error', () => {
      socket.destroy()
      done(null)
    })
    socket.on('timeout', () => {
      socket.destroy()
      done(null)
    })
  })

const readPanelCertificatePem = async (reader: HostIdentityReader): Promise<string | null> => {
  if (reader.readServedCertificate) {
    try {
      const pem = await reader.readServedCertificate()
      if (pem && pem.includes('BEGIN CERTIFICATE')) return pem
    } catch { /* The nginx dump is the other way to see the listener. */ }
  }
  for (const bin of ['/usr/sbin/nginx', '/usr/bin/nginx']) {
    let dumped = ''
    try {
      const result = await reader.runCommand([bin, '-T'])
      dumped = `${result.stdout}\n${result.stderr}`
    } catch {
      continue
    }
    const path = sslCertificateForListen(dumped, PANEL_LISTENER_PORT)
    if (!path) continue
    const pem = await readText(reader, path)
    if (pem && pem.includes('BEGIN CERTIFICATE')) return pem
  }
  return null
}

const NGINX_ARGV = [['/usr/sbin/nginx', '-v'], ['/usr/bin/nginx', '-v']] as const
const APACHE_ARGV = [
  ['/usr/sbin/apache2', '-v', 'Apache'],
  ['/usr/sbin/httpd', '-v', 'httpd'],
] as const

const commandText = async (reader: HostIdentityReader, argv: readonly string[]): Promise<string> => {
  try {
    const result = await reader.runCommand([...argv])
    return `${result.stdout}\n${result.stderr}`
  } catch {
    return ''
  }
}

const readText = async (reader: HostIdentityReader, path: string): Promise<string | null> => {
  try {
    return await reader.readFile(path)
  } catch {
    return null
  }
}

/** The agent package version. A missing or unreadable manifest stays empty. */
export const readAgentPackageVersion = async (): Promise<string | null> => {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url))
    return parsePackageVersion(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Optional host facts for the dashboard. A missing file or binary leaves that field
 * empty and does not fail the host-info probe, which still depends on load and memory.
 */
export const readHostIdentity = async (reader: HostIdentityReader): Promise<HostIdentity> => {
  const identity: HostIdentity = {}
  const release = (await readText(reader, '/etc/os-release')) ?? (await readText(reader, '/usr/lib/os-release'))
  const system = release ? parseOsRelease(release) : null
  if (system) identity.system = system
  const uptimeText = await readText(reader, '/proc/uptime')
  const uptimeSeconds = uptimeText ? parseProcUptime(uptimeText) : null
  if (uptimeSeconds !== null) identity.uptimeSeconds = uptimeSeconds
  const kernel = parseKernelRelease(await commandText(reader, ['/usr/bin/uname', '-r']))
  if (kernel) identity.kernel = kernel
  let hostname = parseHostname(await commandText(reader, ['/usr/bin/hostname', '-f']))
  if (!hostname) hostname = parseHostname(await commandText(reader, ['/bin/hostname', '-f']))
  if (hostname) identity.hostname = hostname
  const cpuText = await readText(reader, '/proc/cpuinfo')
  const cpu = cpuText ? parseCpuinfo(cpuText) : null
  if (cpu) {
    identity.cores = cpu.cores
    if (cpu.model) identity.model = cpu.model
  }

  let nginx: string | null = null
  for (const argv of NGINX_ARGV) {
    nginx = parseNginxVersion(await commandText(reader, argv))
    if (nginx) break
  }
  let apache: { name: string; version: string } | null = null
  for (const [bin, flag, name] of APACHE_ARGV) {
    const version = parseApacheVersion(await commandText(reader, [bin, flag]))
    if (version) {
      apache = { name, version }
      break
    }
  }
  const engine = [
    nginx ? `nginx ${nginx}` : '',
    apache ? `${apache.name} ${apache.version}` : '',
  ].filter(part => part.length > 0).join(' → ')
  if (engine) identity.engine = engine

  const versionFile = await readText(reader, '/opt/xpanel/VERSION')
  const version = (versionFile ? parseVersionFile(versionFile) : null) ?? await readAgentPackageVersion()
  if (version) identity.version = version
  const certificates = await readPanelCertificates(reader)
  if (certificates.rows.length > 0) identity.certificates = certificates.rows
  if (certificates.panelDomain) identity.panelDomain = certificates.panelDomain
  return identity
}

const certificateKey = (row: { names: string[]; notAfter: string }): string => `${row.notAfter}\n${row.names.join(',')}`

/**
 * The no-SNI handshake is the certificate nginx serves for the IP. The named
 * handshake is the certificate for the public origin or the listener's server_name.
 */
const readPanelCertificates = async (
  reader: HostIdentityReader,
): Promise<{ rows: Array<{ names: string[]; notAfter: string }>; panelDomain?: string }> => {
  let dumped = ''
  for (const bin of ['/usr/sbin/nginx', '/usr/bin/nginx']) {
    const text = await commandText(reader, [bin, '-T'])
    if (text.includes('server')) {
      dumped = text
      break
    }
  }
  const origin = originHost(reader.publicOrigin?.() ?? null)
  const serverName = origin ?? serverNamesForListen(dumped, PANEL_LISTENER_PORT)[0] ?? null
  const pems: string[] = []
  const take = async (servername?: string): Promise<string | null> => {
    if (!reader.readServedCertificate) return null
    try {
      const pem = await reader.readServedCertificate(servername)
      return pem && pem.includes('BEGIN CERTIFICATE') ? pem : null
    } catch {
      return null
    }
  }
  const plain = await take()
  const named = serverName ? await take(serverName) : null
  if (plain) pems.push(plain)
  if (named && named !== plain) pems.push(named)
  if (pems.length === 0) {
    const path = dumped ? sslCertificateForListen(dumped, PANEL_LISTENER_PORT) : null
    const file = path ? await readText(reader, path) : null
    if (file && file.includes('BEGIN CERTIFICATE')) pems.push(file)
  }
  const rows: Array<{ names: string[]; notAfter: string }> = []
  const seen = new Set<string>()
  let panelDomain: string | undefined
  const namedCert = named ? certificateFromPem(named) : null
  const namedDns = namedCert?.names.find(name => isIP(name) === 0)
  if (namedDns) panelDomain = namedDns
  for (const pem of pems) {
    const parsed = certificateFromPem(pem)
    if (!parsed) continue
    const key = certificateKey(parsed)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ names: parsed.names, notAfter: parsed.notAfter })
    if (!panelDomain) {
      const dns = parsed.names.find(name => isIP(name) === 0)
      if (dns) panelDomain = dns
    }
  }
  return panelDomain ? { rows, panelDomain } : { rows }
}

export interface HostConfigCheck {
  ok: boolean
  at: string
}

export interface HostConfigChecks {
  nginx?: HostConfigCheck
  apache?: HostConfigCheck
}

const NGINX_TEST_ARGV = [['/usr/sbin/nginx', '-t'], ['/usr/bin/nginx', '-t']] as const
const APACHE_TEST_ARGV = [['/usr/sbin/apachectl', 'configtest'], ['/usr/sbin/apache2ctl', 'configtest']] as const

const commandMissing = (result: { ok: boolean; stderr: string }): boolean =>
  !result.ok && /ENOENT|not found/i.test(result.stderr)

const firstPresent = async (
  reader: HostIdentityReader,
  commands: readonly (readonly string[])[],
): Promise<{ ok: boolean } | null> => {
  for (const argv of commands) {
    let result: { ok: boolean; stdout: string; stderr: string }
    try {
      result = await reader.runCommand([...argv])
    } catch {
      continue
    }
    if (commandMissing(result)) continue
    return { ok: result.ok }
  }
  return null
}

/**
 * Read-only `nginx -t` and `apachectl configtest`. A missing binary leaves that
 * check empty and does not fail the host-info probe.
 */
export const readHostConfigChecks = async (reader: HostIdentityReader, now = new Date()): Promise<HostConfigChecks> => {
  const at = now.toISOString()
  const checks: HostConfigChecks = {}
  const nginx = await firstPresent(reader, NGINX_TEST_ARGV)
  if (nginx) checks.nginx = { ok: nginx.ok, at }
  const apache = await firstPresent(reader, APACHE_TEST_ARGV)
  if (apache) checks.apache = { ok: apache.ok, at }
  return checks
}
