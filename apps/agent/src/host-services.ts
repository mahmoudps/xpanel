import { fail } from '@xpanel/core'

export interface HostServiceSpec {
  id: string
  label: string
  units: readonly string[]
}

export const HOST_SERVICES: readonly HostServiceSpec[] = [
  { id: 'apache', label: 'Apache', units: ['apache2.service', 'httpd.service'] },
  { id: 'mariadb', label: 'MariaDB', units: ['mariadb.service', 'mysql.service'] },
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
  state: 'active' | 'inactive' | 'failed' | 'not-installed'
}

const byId = new Map(HOST_SERVICES.map(service => [service.id, service]))

export const hostServiceById = (id: string): HostServiceSpec => {
  const service = byId.get(id)
  if (!service) return fail('NOT_FOUND', 'that service is not one of the services this panel restarts')
  return service
}

const showUnit = async (run: (argv: string[]) => Promise<HostCommandResult>, unit: string): Promise<{ load: string; active: string }> => {
  const result = await run(['/usr/bin/systemctl', 'show', '-p', 'LoadState', '-p', 'ActiveState', '--value', '--', unit])
  const [load, active] = result.stdout.trim().split('\n')
  return { load: load ?? '', active: active ?? '' }
}

export const readHostServices = async (run: (argv: string[]) => Promise<HostCommandResult>): Promise<HostServiceStatus[]> => {
  const rows: HostServiceStatus[] = []
  for (const service of HOST_SERVICES) {
    let chosen: HostServiceStatus = { id: service.id, label: service.label, unit: null, state: 'not-installed' }
    for (const unit of service.units) {
      const shown = await showUnit(run, unit)
      if (shown.load !== 'loaded') continue
      const state = shown.active === 'active' ? 'active' : shown.active === 'failed' ? 'failed' : 'inactive'
      chosen = { id: service.id, label: service.label, unit, state }
      break
    }
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
  if (!current?.unit) return fail('PRECONDITION_FAILED', `${service.label} is not installed on this server`)
  const restarted = await run(['/usr/bin/systemctl', 'restart', '--', current.unit])
  if (!restarted.ok) {
    const detail = (restarted.stderr || restarted.stdout || 'systemctl restart failed').trim().slice(0, 400)
    return fail('CONFIG_TEST_FAILED', `${service.label} did not restart (${detail})`)
  }
  const after = (await readHostServices(run)).find(row => row.id === service.id)
  return after ?? current
}
