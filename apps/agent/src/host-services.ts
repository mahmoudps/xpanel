import { fail } from '@xpanel/core'

export interface HostServiceSpec {
  id: string
  label: string
  units: readonly string[]
  /** Keep scanning until an active unit is found. The first unit stays the tie-break. */
  preferActive?: boolean
}

export const HOST_SERVICES: readonly HostServiceSpec[] = [
  { id: 'nginx', label: 'nginx', units: ['nginx.service'] },
  { id: 'apache', label: 'Apache', units: ['apache2.service', 'httpd.service'] },
  {
    id: 'php-fpm',
    label: 'PHP-FPM',
    units: ['php8.3-fpm.service', 'php8.4-fpm.service', 'php8.2-fpm.service', 'php8.1-fpm.service', 'php8.0-fpm.service', 'php7.4-fpm.service', 'php83-php-fpm.service'],
    preferActive: true,
  },
  { id: 'mariadb', label: 'MariaDB', units: ['mariadb.service', 'mysql.service'] },
  { id: 'postgresql', label: 'PostgreSQL', units: ['postgresql.service'] },
  { id: 'redis', label: 'Redis', units: ['redis-server.service', 'redis.service', 'valkey.service'] },
  { id: 'postfix', label: 'Postfix', units: ['postfix.service'] },
  { id: 'dovecot', label: 'Dovecot', units: ['dovecot.service'] },
  { id: 'pure-ftpd', label: 'pure-ftpd', units: ['pure-ftpd.service'] },
  { id: 'pdns', label: 'PowerDNS', units: ['pdns.service'] },
]

export interface HostCommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface HostServiceStatus {
  id: string
  label: string
  unit: string | null
  state: 'active' | 'inactive' | 'failed' | 'not-installed' | 'unchecked'
}

const byId = new Map(HOST_SERVICES.map(service => [service.id, service]))

export const hostServiceById = (id: string): HostServiceSpec => {
  const service = byId.get(id)
  if (!service) return fail('NOT_FOUND', 'that service is not one of the services this panel restarts')
  return service
}

const showUnit = async (
  run: (argv: string[]) => Promise<HostCommandResult>,
  unit: string,
): Promise<{ probed: boolean; load: string; active: string }> => {
  const result = await run(['/usr/bin/systemctl', 'show', '-p', 'LoadState', '-p', 'ActiveState', '--value', '--', unit])
  if (!result.ok) return { probed: false, load: '', active: '' }
  const [load, active] = result.stdout.trim().split('\n')
  return { probed: true, load: load ?? '', active: active ?? '' }
}

export const readHostServices = async (run: (argv: string[]) => Promise<HostCommandResult>): Promise<HostServiceStatus[]> => {
  const rows: HostServiceStatus[] = []
  for (const service of HOST_SERVICES) {
    let chosen: HostServiceStatus = { id: service.id, label: service.label, unit: null, state: 'unchecked' }
    let probed = false
    let rank = 0
    for (const unit of service.units) {
      const shown = await showUnit(run, unit)
      if (!shown.probed) continue
      probed = true
      if (shown.load !== 'loaded') continue
      const state = shown.active === 'active' ? 'active' : shown.active === 'failed' ? 'failed' : 'inactive'
      const nextRank = state === 'active' ? 3 : state === 'failed' ? 2 : 1
      if (chosen.unit === null || nextRank > rank) {
        chosen = { id: service.id, label: service.label, unit, state }
        rank = nextRank
      }
      if (!service.preferActive || state === 'active') break
    }
    if (chosen.unit === null) chosen = { ...chosen, state: probed ? 'not-installed' : 'unchecked' }
    rows.push(chosen)
  }
  return rows
}

export const restartHostService = async (
  run: (argv: string[]) => Promise<HostCommandResult>,
  id: string,
): Promise<HostServiceStatus> => {
  const service = hostServiceById(id)
  const current = (await readHostServices(run)).find(row => row.id === service.id)
  if (!current?.unit) {
    const reason = current?.state === 'unchecked' ? 'was not checked on this server' : 'is not installed on this server'
    return fail('PRECONDITION_FAILED', `${service.label} ${reason}`)
  }
  const restarted = await run(['/usr/bin/systemctl', 'restart', '--', current.unit])
  if (!restarted.ok) {
    const detail = (restarted.stderr || restarted.stdout || 'systemctl restart failed').trim().slice(0, 400)
    return fail('CONFIG_TEST_FAILED', `${service.label} did not restart (${detail})`)
  }
  const after = (await readHostServices(run)).find(row => row.id === service.id)
  return after ?? current
}
