import { fail } from '@xpanel/core'
import { isAccountFpmMaster, isPhpVersion, phpCompact, serviceConfigTest, SERVICE_MANAGER_FILES, SERVICE_MANAGER_LIST, SUPPORTED_PHP_VERSIONS, type PhpVersion, type XpanelOsProfile } from '@xpanel/os'
import { parseServiceManagerLists, type ServiceManagerRow } from './service-manager.ts'

export interface HostServiceSpec {
  id: string
  label: string
  units: readonly string[]
}

/** Single-unit services. PHP-FPM is reported per installed PHP version from the unit inventory instead. */
export const HOST_SERVICES: readonly HostServiceSpec[] = [
  { id: 'nginx', label: 'nginx', units: ['nginx.service'] },
  { id: 'apache', label: 'Apache', units: ['apache2.service', 'httpd.service'] },
  { id: 'mariadb', label: 'MariaDB', units: ['mariadb.service', 'mysql.service'] },
  { id: 'postgresql', label: 'PostgreSQL', units: ['postgresql.service'] },
  { id: 'redis', label: 'Redis', units: ['redis-server.service', 'redis.service', 'valkey.service'] },
  { id: 'postfix', label: 'Postfix', units: ['postfix.service'] },
  { id: 'dovecot', label: 'Dovecot', units: ['dovecot.service'] },
  { id: 'pure-ftpd', label: 'pure-ftpd', units: ['pure-ftpd.service'] },
  { id: 'pdns', label: 'PowerDNS', units: ['pdns.service'] },
  { id: 'opendkim', label: 'OpenDKIM', units: ['opendkim.service'] },
  { id: 'xpanel-api', label: 'xpanel-api', units: ['xpanel-api.service'] },
  { id: 'xpanel-agent', label: 'xpanel-agent', units: ['xpanel-agent.service'] },
  { id: 'cron', label: 'cron', units: ['cron.service', 'cronie.service'] },
  { id: 'ssh', label: 'ssh', units: ['ssh.service', 'sshd.service'] },
]

export interface HostCommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

/** One installed PHP version's per-account masters by observed state; the rest of `masters` are stopped. */
export interface HostFpmVersion {
  version: PhpVersion
  masters: number
  running: number
  failed: number
}

export interface HostServiceStatus {
  id: string
  label: string
  /** Null for a PHP-FPM version row: its masters are many units, counted in `fpm`. */
  unit: string | null
  state: 'active' | 'inactive' | 'failed' | 'not-installed' | 'unchecked'
  fpm?: HostFpmVersion
}

type Run = (argv: string[]) => Promise<HostCommandResult>

const byId = new Map(HOST_SERVICES.map(service => [service.id, service]))
const FPM_ID = /^php-fpm-([0-9])([0-9])$/

export const hostServiceById = (id: string): HostServiceSpec => {
  const service = byId.get(id)
  if (!service) return fail('NOT_FOUND', 'that service is not one of the services this panel restarts')
  return service
}

const showUnit = async (run: Run, unit: string): Promise<{ probed: boolean; load: string; active: string }> => {
  const result = await run(['/usr/bin/systemctl', 'show', '-p', 'LoadState', '-p', 'ActiveState', '--value', '--', unit])
  if (!result.ok) return { probed: false, load: '', active: '' }
  const [load, active] = result.stdout.trim().split('\n')
  return { probed: true, load: load ?? '', active: active ?? '' }
}

/** The systemd unit inventory, or null when it could not be listed. */
const readUnitInventory = async (run: Run): Promise<ServiceManagerRow[] | null> => {
  const units = await run([...SERVICE_MANAGER_LIST]), files = await run([...SERVICE_MANAGER_FILES])
  if (!units.ok || !files.ok) return null
  try { return parseServiceManagerLists(units.stdout, files.stdout) } catch { return null }
}

/** Enabled or running account masters of one version; a suspended account's master is stopped and disabled and stays so. */
const versionMasters = (inventory: readonly ServiceManagerRow[], version: PhpVersion): ServiceManagerRow[] =>
  inventory.filter(row => isAccountFpmMaster(row.unit) && row.unit.endsWith(`-${version}.service`) && row.load === 'loaded' && (row.boot === 'enabled' || row.active === 'active'))

// Ubuntu packages ship php<v>-fpm.service and Remi on EL php<vv>-php-fpm.service; xPanel keeps both off, but their unit file marks the version installed.
const distroFpmUnits = (version: PhpVersion): string[] => [`php${version}-fpm.service`, `php${phpCompact(version)}-php-fpm.service`]

/** Like cPanel, one row per installed PHP version; it aggregates that version's account masters. */
const fpmVersionRows = (inventory: readonly ServiceManagerRow[] | null): HostServiceStatus[] => {
  if (!inventory) return [{ id: 'php-fpm', label: 'PHP-FPM', unit: null, state: 'unchecked' }]
  const present = new Set(inventory.filter(row => row.load === 'loaded' || row.boot !== null).map(row => row.unit))
  const rows = SUPPORTED_PHP_VERSIONS.flatMap((version): HostServiceStatus[] => {
    const masters = versionMasters(inventory, version)
    if (masters.length === 0 && !distroFpmUnits(version).some(unit => present.has(unit))) return []
    const running = masters.filter(row => row.active === 'active').length, failed = masters.filter(row => row.active === 'failed').length
    const state = masters.length > 0 && running === masters.length ? 'active' : failed > 0 ? 'failed' : 'inactive'
    return [{ id: `php-fpm-${phpCompact(version)}`, label: `PHP-FPM ${version}`, unit: null, state, fpm: { version, masters: masters.length, running, failed } }]
  })
  return rows.length > 0 ? rows : [{ id: 'php-fpm', label: 'PHP-FPM', unit: null, state: 'not-installed' }]
}

export const readHostServices = async (run: Run): Promise<HostServiceStatus[]> => {
  const rows: HostServiceStatus[] = []
  for (const service of HOST_SERVICES) {
    let chosen: HostServiceStatus = { id: service.id, label: service.label, unit: null, state: 'unchecked' }
    let probed = false
    for (const unit of service.units) {
      const shown = await showUnit(run, unit)
      if (!shown.probed) continue
      probed = true
      if (shown.load !== 'loaded') continue
      chosen = { id: service.id, label: service.label, unit, state: shown.active === 'active' ? 'active' : shown.active === 'failed' ? 'failed' : 'inactive' }
      break
    }
    if (chosen.unit === null) chosen = { ...chosen, state: probed ? 'not-installed' : 'unchecked' }
    rows.push(chosen)
  }
  rows.splice(rows.findIndex(row => row.id === 'apache') + 1, 0, ...fpmVersionRows(await readUnitInventory(run)))
  return rows
}

/** Every configuration test passes before the first restart, so a failure leaves all running units untouched. */
const testThenRestart = async (run: Run, label: string, units: readonly string[], os: XpanelOsProfile): Promise<void> => {
  for (const unit of units) {
    const test = serviceConfigTest(unit, os)
    const checked = test ? await run(test) : null
    if (checked && !checked.ok) {
      const stderr = (checked.stderr.trim() || 'the check failed without a message').slice(0, 1000)
      return fail('CONFIG_TEST_FAILED', `${label} was not restarted: its configuration test failed (${stderr})`, { stateChanged: false, reason: 'config_test_failed', unit, stderr })
    }
  }
  for (const unit of units) {
    const restarted = await run(['/usr/bin/systemctl', 'restart', '--', unit])
    if (!restarted.ok) {
      const detail = (restarted.stderr || restarted.stdout || 'systemctl restart failed').trim().slice(0, 400)
      return fail('CONFIG_TEST_FAILED', `${label} did not restart (${detail})`)
    }
  }
}

/** Restarts exactly the version's account masters; the distro master and its shared www pool are never touched. */
const restartFpmVersion = async (run: Run, id: string, version: PhpVersion, os: XpanelOsProfile): Promise<HostServiceStatus> => {
  const label = `PHP-FPM ${version}`
  const inventory = await readUnitInventory(run)
  if (!inventory) return fail('PRECONDITION_FAILED', 'the account PHP-FPM masters could not be listed', { stateChanged: false })
  const masters = versionMasters(inventory, version).map(row => row.unit)
  if (masters.length === 0) return fail('PRECONDITION_FAILED', `${label} has no enabled account master on this server`, { stateChanged: false, reason: 'no_account_masters' })
  await testThenRestart(run, label, masters, os)
  const after = (await readHostServices(run)).find(row => row.id === id)
  return after ?? fail('SERVICE_UNAVAILABLE', `${label} was restarted but could not be read back`, { stateChanged: true, verificationRequired: true })
}

export const restartHostService = async (run: Run, id: string, os: XpanelOsProfile, disabledUnits: ReadonlySet<string> = new Set()): Promise<HostServiceStatus> => {
  const fpm = FPM_ID.exec(id), version = fpm ? `${fpm[1]}.${fpm[2]}` : null
  if (isPhpVersion(version)) return restartFpmVersion(run, id, version, os)
  const service = hostServiceById(id)
  const current = (await readHostServices(run)).find(row => row.id === service.id)
  if (!current?.unit) return fail('PRECONDITION_FAILED', `${service.label} ${current?.state === 'unchecked' ? 'was not checked on this server' : 'is not installed on this server'}`)
  if (disabledUnits.has(current.unit)) return fail('PRECONDITION_FAILED', `${service.label} is disabled on this server`, { stateChanged: false, reason: 'service_role_disabled' })
  // A restart would start it again, which is the Service Manager's decision.
  if (current.state !== 'active' && ['disabled', 'masked'].includes((await readUnitInventory(run))?.find(row => row.unit === current.unit)?.boot ?? '')) return fail('PRECONDITION_FAILED', `${service.label} is disabled on this server`, { stateChanged: false, reason: 'service_disabled' })
  await testThenRestart(run, service.label, [current.unit], os)
  const after = (await readHostServices(run)).find(row => row.id === service.id)
  return after ?? current
}
