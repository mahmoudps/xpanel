import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
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
  const pem = await readText(reader, '/etc/xpanel/ssl/default/fullchain.pem')
  const certificate = pem ? certificateFromPem(pem) : null
  if (certificate) {
    identity.certificates = [{ names: certificate.names, notAfter: certificate.notAfter }]
    const dns = certificate.names.find(name => isIP(name) === 0)
    if (dns) identity.panelDomain = dns
  }
  return identity
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
