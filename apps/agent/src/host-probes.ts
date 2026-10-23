import { existsSync } from 'node:fs'

export type AgentHostProbe = 'linux-account' | 'apache' | 'mariadb' | 'mail' | 'files' | 'acme' | 'pdns' | 'backups' | 'systemd' | 'host-info'
export type AgentHostProbeResult = 'passed' | 'failed'

const ANY = (present: (path: string) => boolean, paths: readonly string[]): boolean => paths.some(present)

/** Pure classification so tests can prove a missing binary does not pass. */
export const classifyHostBinaries = (
  present: (path: string) => boolean,
  filesReady: boolean,
): Record<AgentHostProbe, AgentHostProbeResult> => ({
  'linux-account': present('/usr/sbin/useradd') ? 'passed' : 'failed',
  apache: ANY(present, ['/usr/sbin/apachectl', '/usr/sbin/apache2', '/usr/sbin/httpd']) ? 'passed' : 'failed',
  mariadb: ANY(present, ['/usr/bin/mariadb', '/usr/bin/mysql']) ? 'passed' : 'failed',
  mail: present('/usr/sbin/postfix') && ANY(present, ['/usr/sbin/dovecot', '/usr/bin/doveadm']) ? 'passed' : 'failed',
  files: filesReady ? 'passed' : 'failed',
  acme: ANY(present, ['/usr/bin/certbot', '/usr/bin/lego', '/usr/local/bin/acme.sh', '/root/.acme.sh/acme.sh']) ? 'passed' : 'failed',
  pdns: ANY(present, ['/usr/bin/pdnsutil', '/usr/bin/pdns_control', '/usr/sbin/pdns_server']) ? 'passed' : 'failed',
  backups: present('/var/lib/xpanel') ? 'passed' : 'failed',
  systemd: present('/usr/bin/systemctl') ? 'passed' : 'failed',
  'host-info': present('/proc/loadavg') ? 'passed' : 'failed',
})

let cached: { at: number; filesReady: boolean; probes: Record<AgentHostProbe, AgentHostProbeResult> } | undefined

export const probeHostCapabilities = (filesReady: boolean): Record<AgentHostProbe, AgentHostProbeResult> => {
  const now = Date.now()
  if (cached && cached.filesReady === filesReady && now - cached.at < 30_000) return cached.probes
  const probes = classifyHostBinaries(existsSync, filesReady)
  cached = { at: now, filesReady, probes }
  return probes
}
