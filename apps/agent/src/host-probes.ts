import { existsSync } from 'node:fs'
import { acmeTraverseProbeArgv } from '@xpanel/os'
import { parseLoadavg, parseMeminfo } from './host-info.ts'
import { parseTrafficCounters } from './traffic-monitor.ts'

export type AgentHostProbe = 'linux-account' | 'apache' | 'mariadb' | 'mail' | 'files' | 'acme' | 'pdns' | 'backups' | 'systemd' | 'host-info' | 'audit_log'
  | 'host-jobs' | 'packages' | 'mail-queue' | 'journal' | 'procps' | 'mail-config' | 'iproute' | 'mariadb-admin' | 'fail2ban' | 'clamav' | 'getent' | 'iputils' | 'benchmark' | 'network-counters'
export type AgentHostProbeResult = 'passed' | 'failed'

export interface HostMeasurementEvidence {
  /** True only after `/proc/loadavg` and `/proc/meminfo` were read and parsed. */
  hostInfo?: boolean
  /** True only after the exact interface counters parsed successfully. */
  networkCounters?: boolean
  /** True only after a read of the append-only audit log succeeded. */
  auditLog?: boolean
  /**
   * When false, nginx cannot serve the HTTP-01 webroot. Omitted leaves the
   * previous client-only result so callers that have not probed traversal still pass.
   */
  acmeReachable?: boolean
  /** True only when this agent was started with a host job runner. */
  hostJobs?: boolean
  /** Trusted startup OS profile family; the package probe checks only that family's tools. */
  packageFamily?: string
}

export interface HostMeasurementReader {
  readFile(path: string): Promise<string | null>
  runCommand(argv: string[]): Promise<{ ok: boolean }>
}

const ANY = (present: (path: string) => boolean, paths: readonly string[]): boolean => paths.some(present)
const ALL = (present: (path: string) => boolean, paths: readonly string[]): boolean => paths.every(present)
/** Exact binaries the system update, software center and repair argv grammars execute (packages/os). */
const PACKAGE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  debian: ['/usr/bin/apt-get', '/usr/bin/apt-mark', '/usr/bin/apt-cache', '/usr/bin/dpkg', '/usr/bin/dpkg-query'],
  rhel: ['/usr/bin/dnf', '/usr/bin/rpm'],
}

/** Pure classification so tests can prove a missing binary does not pass. */
export const classifyHostBinaries = (
  present: (path: string) => boolean,
  filesReady: boolean,
  builtinAcme = false,
  measurements: HostMeasurementEvidence = {},
): Record<AgentHostProbe, AgentHostProbeResult> => ({
  'linux-account': present('/usr/sbin/useradd') ? 'passed' : 'failed',
  apache: ANY(present, ['/usr/sbin/apachectl', '/usr/sbin/apache2', '/usr/sbin/httpd']) ? 'passed' : 'failed',
  mariadb: ANY(present, ['/usr/bin/mariadb', '/usr/bin/mysql']) ? 'passed' : 'failed',
  mail: present('/usr/sbin/postfix') && ANY(present, ['/usr/sbin/dovecot', '/usr/bin/doveadm']) ? 'passed' : 'failed',
  files: filesReady ? 'passed' : 'failed',
  acme: (builtinAcme || ANY(present, ['/usr/bin/certbot', '/usr/bin/lego', '/usr/local/bin/acme.sh', '/root/.acme.sh/acme.sh'])) && measurements.acmeReachable !== false ? 'passed' : 'failed',
  pdns: ANY(present, ['/usr/bin/pdnsutil', '/usr/bin/pdns_control', '/usr/sbin/pdns_server']) ? 'passed' : 'failed',
  backups: present('/var/lib/xpanel') ? 'passed' : 'failed',
  systemd: present('/usr/bin/systemctl') ? 'passed' : 'failed',
  'host-info': measurements.hostInfo === true ? 'passed' : 'failed',
  audit_log: measurements.auditLog === true ? 'passed' : 'failed',
  'host-jobs': measurements.hostJobs === true ? 'passed' : 'failed',
  packages: measurements.packageFamily !== undefined && Object.hasOwn(PACKAGE_TOOLS, measurements.packageFamily) && ALL(present, PACKAGE_TOOLS[measurements.packageFamily]!) ? 'passed' : 'failed',
  'mail-queue': ALL(present, ['/usr/sbin/postqueue', '/usr/sbin/postsuper']) ? 'passed' : 'failed',
  journal: present('/usr/bin/journalctl') ? 'passed' : 'failed',
  procps: ALL(present, ['/usr/bin/ps', '/usr/bin/kill', '/usr/bin/df']) ? 'passed' : 'failed',
  'mail-config': ALL(present, ['/usr/sbin/postconf', '/usr/bin/doveconf']) ? 'passed' : 'failed',
  iproute: present('/usr/sbin/ip') ? 'passed' : 'failed',
  // The WHM database adapter runs this exact client (services/mariadb.ts DEFAULT_MARIADB_BINARY).
  'mariadb-admin': present('/usr/bin/mariadb') ? 'passed' : 'failed',
  fail2ban: present('/usr/bin/fail2ban-client') ? 'passed' : 'failed',
  clamav: ALL(present, ['/usr/bin/clamscan', '/usr/bin/freshclam', '/usr/bin/nice']) ? 'passed' : 'failed',
  getent: present('/usr/bin/getent') ? 'passed' : 'failed',
  iputils: present('/usr/bin/ping') ? 'passed' : 'failed',
  benchmark: ALL(present, ['/usr/bin/nice', '/usr/bin/ionice', '/usr/bin/openssl', '/usr/bin/dd', '/usr/bin/rm']) ? 'passed' : 'failed',
  'network-counters': measurements.networkCounters === true ? 'passed' : 'failed',
})

/**
 * Reads the same files `GET /host/info` uses and checks nginx can walk the ACME
 * directory. A thrown allowlist denial fails the probe. Results are not cached.
 */
export const readHostMeasurements = async (
  reader: HostMeasurementReader,
  nginxUser = 'nginx',
): Promise<HostMeasurementEvidence> => {
  let hostInfo = false
  try {
    const load = await reader.readFile('/proc/loadavg')
    const memory = await reader.readFile('/proc/meminfo')
    if (load && memory) {
      parseLoadavg(load)
      parseMeminfo(memory)
      hostInfo = true
    }
  } catch {
    hostInfo = false
  }
  let acmeReachable = true
  try {
    for (const argv of acmeTraverseProbeArgv(nginxUser)) {
      const result = await reader.runCommand(argv)
      if (!result.ok) {
        acmeReachable = false
        break
      }
    }
  } catch {
    acmeReachable = false
  }
  let networkCounters = false
  try { const raw = await reader.readFile('/proc/net/dev'); networkCounters = raw !== null && parseTrafficCounters(raw) !== null } catch { networkCounters = false }
  return { hostInfo, acmeReachable, networkCounters }
}

/** The audit log is readable when a query against it returns, including an empty log. */
export const probeAuditLog = async (read: () => Promise<unknown>): Promise<boolean> => {
  try {
    await read()
    return true
  } catch {
    return false
  }
}

export const probeHostCapabilities = (
  filesReady: boolean,
  builtinAcme = false,
  measurements: HostMeasurementEvidence = {},
): Record<AgentHostProbe, AgentHostProbeResult> =>
  classifyHostBinaries(existsSync, filesReady, builtinAcme, measurements)
