import type { Locale } from '../i18n.ts'
import { readHostConfigChecks, readHostIdentity } from '../../../agent/src/host-identity.ts'
import { parseDf, parseDfInodes, parseLoadavg, parseMeminfo } from '../../../agent/src/host-info.ts'
import { readHostServices, type HostCommandResult } from '../../../agent/src/host-services.ts'
import { mapAgentHostInfo, mapAgentServices, whmDashboardFromProps, type WhmDashboardModel } from './xwhm-dashboard.ts'

/** Raw command output from the lab host. Parsers read these strings; nothing here is pre-parsed JSON. */
export const HOSTNAME_F = 'host.example.test\n'
export const OS_RELEASE = 'NAME="Ubuntu"\nVERSION="24.04.3 LTS (Noble Numbat)"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n'
export const UNAME_R = '6.8.0-90-generic\n'
export const PROC_UPTIME = '126000.12 40000.00\n'
export const NGINX_V = 'nginx version: nginx/1.24.0\n'
export const APACHE_V = 'Server version: Apache/2.4.58 (Ubuntu)\n'
export const CPUINFO = [
  'processor\t: 0',
  'vendor_id\t: AuthenticAMD',
  'model name\t: AMD EPYC-Rome',
  'processor\t: 1',
  'model name\t: AMD EPYC-Rome',
  'processor\t: 2',
  'model name\t: AMD EPYC-Rome',
  'processor\t: 3',
  'model name\t: AMD EPYC-Rome',
  '',
].join('\n')
export const LOADAVG = '0.00 0.02 0.00 1/180 1234\n'
export const MEMINFO = 'MemTotal:        7939453 kB\nMemFree:         2000000 kB\nMemAvailable:    5000000 kB\n'
export const DF_ROOT = 'Filesystem     1B-blocks         Used    Available Capacity Mounted on\n/dev/vda1    161000000000  40000000000 121000000000      25% /\n'
export const DF_HOME = 'Filesystem     1B-blocks         Used    Available Capacity Mounted on\n/dev/vda1    161000000000  40000000000 121000000000      25% /\n'
export const DF_INODES = 'Filesystem       Inodes   IUsed    IFree IUse% Mounted on\n/dev/vda1       9732496  148410  9584086    2% /\n'
export const NGINX_T = 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n'
export const APACHE_T = 'Syntax OK\n'
export const SAMPLED_AT = '2026-10-23T13:48:00.000Z'

const SAFE_ARG = /^[A-Za-z0-9@+=:./_-]+$/
const ACTIVE = new Set([
  'nginx.service',
  'apache2.service',
  'php8.3-fpm.service',
  'mariadb.service',
  'postfix.service',
  'dovecot.service',
  'pure-ftpd.service',
  'pdns.service',
  'opendkim.service',
  'xpanel-api.service',
  'xpanel-agent.service',
  'cron.service',
  'ssh.service',
])

const serviceText = (unit: string): string => {
  if (unit === 'redis-server.service') return 'loaded\ninactive\n'
  if (ACTIVE.has(unit)) return 'loaded\nactive\n'
  return 'not-found\ninactive\n'
}

/** Dashboard model produced by parsing the lab command output. */
export const labHostDashboard = async (
  locale: Locale = 'en',
  served?: { plain: string | null; named: string | null; origin: string | null },
): Promise<WhmDashboardModel> => {
  const argv: string[][] = []
  const identity = await readHostIdentity({
    readFile: async (path) => {
      if (path === '/etc/os-release') return OS_RELEASE
      if (path === '/proc/uptime') return PROC_UPTIME
      if (path === '/proc/cpuinfo') return CPUINFO
      return null
    },
    runCommand: async (command) => {
      argv.push(command)
      const bin = command[0] ?? ''
      if (bin.endsWith('/hostname') && command[1] === '-f') return { ok: true, stdout: HOSTNAME_F, stderr: '' }
      if (bin.endsWith('/uname') && command[1] === '-r') return { ok: true, stdout: UNAME_R, stderr: '' }
      if (bin.endsWith('/nginx') && command[1] === '-v') return { ok: true, stdout: '', stderr: NGINX_V }
      if (bin.endsWith('/nginx') && command[1] === '-t') return { ok: true, stdout: '', stderr: NGINX_T }
      if (bin.endsWith('/apache2') && command[1] === '-v') return { ok: true, stdout: APACHE_V, stderr: '' }
      if (command[1] === 'configtest' && bin.endsWith('/apachectl')) return { ok: true, stdout: APACHE_T, stderr: '' }
      if (command[1] === 'configtest') return { ok: false, stdout: '', stderr: 'spawn ENOENT' }
      return { ok: false, stdout: '', stderr: '' }
    },
    readServedCertificate: async (servername) => servername ? (served?.named ?? null) : (served?.plain ?? null),
    publicOrigin: () => served?.origin ?? null,
  })
  const configChecks = await readHostConfigChecks({
    readFile: async () => null,
    runCommand: async (command) => {
      argv.push(command)
      const bin = command[0] ?? ''
      if (bin.endsWith('/nginx') && command[1] === '-t') return { ok: true, stdout: '', stderr: NGINX_T }
      if (bin.endsWith('/apachectl') && command[1] === 'configtest') return { ok: true, stdout: APACHE_T, stderr: '' }
      return { ok: false, stdout: '', stderr: 'spawn ENOENT' }
    },
  }, new Date(SAMPLED_AT))
  if (!argv.every(command => command.every(arg => SAFE_ARG.test(arg)))) throw new Error('host command argv left the safe set')
  const disk = parseDf(DF_ROOT)
  const home = parseDf(DF_HOME)
  const inodes = parseDfInodes(DF_INODES)
  const info = {
    load: parseLoadavg(LOADAVG),
    memory: parseMeminfo(MEMINFO),
    disk,
    inodes,
    ...(home.mount === '/' || home.filesystem === disk.filesystem || inodes.mount === '/' ? { homeOnRoot: true } : {}),
    identity,
    sampledAt: SAMPLED_AT,
    configChecks,
  }
  const services = await readHostServices(async (command): Promise<HostCommandResult> => {
    argv.push(command)
    const unit = command.at(-1) ?? ''
    return { ok: true, stdout: serviceText(unit), stderr: '' }
  })
  if (!argv.every(command => command.every(arg => SAFE_ARG.test(arg)))) throw new Error('service command argv left the safe set')
  const sample = mapAgentHostInfo(info)
  const rows = mapAgentServices({ services })
  if (!sample || !rows) throw new Error('lab host fixture did not parse')
  return whmDashboardFromProps({
    locale,
    principal: { username: 'root' },
    ...(sample.hostname ? { hostname: sample.hostname } : {}),
    hostSample: sample,
    services: rows,
    generationId: 142,
    rollbackGenerationId: 140,
  })
}
