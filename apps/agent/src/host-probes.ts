import { existsSync } from 'node:fs'
import { acmeTraverseProbeArgv } from '@xpanel/os'
import { parseLoadavg, parseMeminfo } from './host-info.ts'

export type AgentHostProbe = 'linux-account' | 'apache' | 'mariadb' | 'mail' | 'files' | 'acme' | 'pdns' | 'backups' | 'systemd' | 'host-info'
export type AgentHostProbeResult = 'passed' | 'failed'

export interface HostMeasurementEvidence {
  /** True only after `/proc/loadavg` and `/proc/meminfo` were read and parsed. */
  hostInfo?: boolean
  /**
   * When false, nginx cannot serve the HTTP-01 webroot. Omitted leaves the
   * previous client-only result so callers that have not probed traversal still pass.
   */
  acmeReachable?: boolean
}

export interface HostMeasurementReader {
  readFile(path: string): Promise<string | null>
  runCommand(argv: string[]): Promise<{ ok: boolean }>
}

const ANY = (present: (path: string) => boolean, paths: readonly string[]): boolean => paths.some(present)

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
  return { hostInfo, acmeReachable }
}

export const probeHostCapabilities = (
  filesReady: boolean,
  builtinAcme = false,
  measurements: HostMeasurementEvidence = {},
): Record<AgentHostProbe, AgentHostProbeResult> =>
  classifyHostBinaries(existsSync, filesReady, builtinAcme, measurements)
