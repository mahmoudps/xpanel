import type { WhmServiceHealthRow } from './surfaces/xwhm.ts'

/** Display grouping only. This list never grants a native action or invents an alias. */
export function serviceArea(id: string | null, unit: string | null): string {
  const known: readonly [string, string, readonly string[]][] = [
    ['nginx', 'web', ['nginx.service']], ['apache', 'web', ['apache2.service', 'httpd.service']],
    ['php-fpm', 'web', ['php8.3-fpm.service', 'php8.4-fpm.service', 'php8.2-fpm.service', 'php8.1-fpm.service', 'php8.0-fpm.service', 'php7.4-fpm.service', 'php83-php-fpm.service', 'php-fpm.service']],
    ['mariadb', 'data', ['mariadb.service', 'mysql.service']], ['postgresql', 'data', ['postgresql.service']],
    ['redis', 'data', ['redis-server.service', 'redis.service', 'valkey.service']],
    ['postfix', 'mail', ['postfix.service']], ['dovecot', 'mail', ['dovecot.service']], ['opendkim', 'mail', ['opendkim.service']],
    ['pure-ftpd', 'access', ['pure-ftpd.service']], ['pdns', 'access', ['pdns.service']],
    ['xpanel-api', 'data', ['xpanel-api.service']], ['xpanel-agent', 'data', ['xpanel-agent.service']],
    ['cron', 'access', ['cron.service', 'cronie.service']], ['ssh', 'access', ['ssh.service', 'sshd.service']],
  ]
  if (id !== null) {
    const match = known.find(row => row[0] === id)
    return match && (unit === null || match[2].includes(unit)) ? match[1] : 'unread'
  }
  const matches = unit === null ? [] : known.filter(row => row[2].includes(unit))
  return matches.length === 1 ? matches[0]![1] : 'unread'
}

export interface ServiceHealthPresentation {
  key: string; label: string; unit: string; state: string; area: string
  role: string | null; version: string | null; rssMb: number | null; enabled: boolean | null
}

/** Preserve unknown telemetry and joinable provenance; neither active nor zero is a boot/RSS probe. */
export function serviceHealthPresentation(rows: readonly WhmServiceHealthRow[]): ServiceHealthPresentation[] {
  const counts = new Map<string, number>()
  for (const row of rows) if (row.unit) counts.set(row.unit, (counts.get(row.unit) ?? 0) + 1)
  return rows.map((row, index) => {
    const checked = row.checked !== false
    const identified = serviceArea(null, row.unit || null) !== 'unread'
    const unique = checked && identified && !!row.unit && counts.get(row.unit) === 1
    return {
      key: 'snapshot-' + index, label: row.name, unit: row.unit,
      state: !checked || row.installed !== false && !unique ? 'unchecked' : row.installed === false ? 'not-installed' : row.active ? 'active' : 'inactive',
      area: serviceArea(null, row.unit || null),
      role: unique && row.role ? row.role : null, version: unique && row.version ? row.version : null,
      rssMb: unique && row.installed !== false && typeof row.rssMb === 'number' && Number.isFinite(row.rssMb) && row.rssMb >= 0 ? row.rssMb : null,
      enabled: unique && typeof row.enabled === 'boolean' ? row.enabled : null,
    }
  })
}
