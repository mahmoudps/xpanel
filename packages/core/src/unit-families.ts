// Every systemd unit family xPanel creates, with its exact name grammar. The agent renders or
// starts these units; the lifecycle settlement gate (scripts/lifecycle-services.mjs) accepts a
// loaded xpanel* unit only when one entry here matches it. This file has no imports so the root
// lifecycle scripts can load it directly. A new family is added here first:
// scripts/test-unit-families.test.ts fails on any unit name in the sources that no entry matches.

/** Account username (core naming rule). */
const USER = '(?<user>[a-z][a-z0-9]{0,15})'
/** Account uid, 1000 to 65533 (the upper bound is checked numerically). */
const UID = '(?<uid>[1-9][0-9]{3,4})'
/** App, cron job and container names (render assertShortName). */
const SHORT = '[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UID_MAX = 65533

/**
 * control-plane: the four receipt-owned units a lifecycle swap stops and starts.
 * coordinator: the unit a lifecycle operation runs in; accepted only as the current coordinator.
 * file-worker: transient account file workers, checked again against their incident records.
 * host and account: everything else the agent creates; a control-plane swap never stops them.
 */
export type UnitFamilyScope = 'control-plane' | 'coordinator' | 'file-worker' | 'host' | 'account'

export interface UnitFamily {
  readonly id: string
  readonly scope: UnitFamilyScope
  readonly pattern: RegExp
  /** Valid names; the registry test proves each one matches this family and no other. */
  readonly examples: readonly string[]
}

const family = (id: string, scope: UnitFamilyScope, source: string, examples: string[]): UnitFamily =>
  Object.freeze({ id, scope, pattern: new RegExp(`^(?:${source})$`), examples: Object.freeze(examples) })

export const UNIT_FAMILIES: readonly UnitFamily[] = Object.freeze([
  family('control-plane', 'control-plane', String.raw`xpanel-(?:api|agent|management-tls)\.service|xpanel-management-tls\.timer`,
    ['xpanel-api.service', 'xpanel-agent.service', 'xpanel-management-tls.service', 'xpanel-management-tls.timer']),
  family('coordinator', 'coordinator', String.raw`xpanel-(?:lifecycle|upgrade)\.service`, ['xpanel-lifecycle.service', 'xpanel-upgrade.service']),
  family('file-worker', 'file-worker', String.raw`xpanel-files-${UID}-[0-9a-f]{32}\.service`, [`xpanel-files-20003-${'a'.repeat(32)}.service`]),
  family('panel-slice', 'host', String.raw`xpanel\.slice`, ['xpanel.slice']),
  family('account-slice', 'account', String.raw`xpanel-${UID}\.slice`, ['xpanel-1000.slice', 'xpanel-65533.slice']),
  family('php-fpm', 'account', String.raw`xpanel-php-fpm-${USER}-[5-9]\.[0-9]{1,2}\.service`, ['xpanel-php-fpm-alice-8.3.service']),
  family('web-app', 'account', String.raw`xpanel-app-${USER}-${SHORT}\.service`, ['xpanel-app-alice-blog.service']),
  family('web-app-proxy', 'account', String.raw`xpanel-appproxy-${USER}-${SHORT}\.(?:service|socket)`, ['xpanel-appproxy-alice-blog.socket', 'xpanel-appproxy-alice-blog.service']),
  family('cron', 'account', String.raw`xpanel-cron-${USER}-${SHORT}\.(?:service|timer)`, ['xpanel-cron-alice-2.service', 'xpanel-cron-alice-2.timer']),
  family('cache', 'account', String.raw`xpanel-(?:redis|memcached)-${USER}\.service`, ['xpanel-redis-alice.service', 'xpanel-memcached-alice.service']),
  family('container', 'account', String.raw`xpanel-ctr-${USER}-${SHORT}\.service`, ['xpanel-ctr-alice-web.service']),
  family('caldav', 'account', String.raw`xpanel-caldav-${USER}\.(?:service|socket)`, ['xpanel-caldav-qa1.service', 'xpanel-caldav-qa1.socket']),
  family('webdisk', 'account', String.raw`xpanel-webdiskd?-${USER}-[0-9a-f]{12}\.(?:service|socket)`,
    ['xpanel-webdisk-alice-0123456789ab.socket', 'xpanel-webdisk-alice-0123456789ab.service', 'xpanel-webdiskd-alice-0123456789ab.socket', 'xpanel-webdiskd-alice-0123456789ab.service']),
  // Transient systemd-run jobs, loaded only while they run.
  family('app-job', 'account', String.raw`xpanel-(?:deps|pyenv|webstage|webdeploy)-${USER}-${SHORT}\.service`,
    ['xpanel-deps-alice-blog.service', 'xpanel-pyenv-alice-env1.service', 'xpanel-webstage-alice-blog.service', 'xpanel-webdeploy-alice-blog.service']),
  family('account-job', 'account', String.raw`xpanel-(?:podclean|ctrlogin|ctrbuild|pear|perl)-${USER}\.service`,
    ['xpanel-podclean-alice.service', 'xpanel-ctrlogin-alice.service', 'xpanel-ctrbuild-alice.service', 'xpanel-pear-alice.service', 'xpanel-perl-alice.service']),
  family('terminal', 'host', String.raw`xpanel-terminal-${UUID}\.service`, ['xpanel-terminal-0b6f2b4e-6a59-4c1e-9d0e-3c7f2a9b1d24.service']),
  family('panel-restart', 'host', String.raw`xpanel-panel-restart\.(?:service|timer)`, ['xpanel-panel-restart.timer', 'xpanel-panel-restart.service']),
  family('host-task', 'host', String.raw`xpanel-task-[a-z0-9]{12}\.(?:service|timer)`, ['xpanel-task-a1b2c3d4e5f6.service', 'xpanel-task-a1b2c3d4e5f6.timer']),
  family('host-daemon', 'host', String.raw`xpanel-daemon-[a-z][a-z0-9-]{0,30}\.service`, ['xpanel-daemon-worker.service']),
  family('host-service', 'host', String.raw`xpanel-(?:frps|frpc|ip-aliases|container-guard|ftp-anonymous-auth|phpmyadmin-fpm|source-build)\.service`,
    ['xpanel-frps.service', 'xpanel-frpc.service', 'xpanel-ip-aliases.service', 'xpanel-container-guard.service', 'xpanel-ftp-anonymous-auth.service', 'xpanel-phpmyadmin-fpm.service', 'xpanel-source-build.service']),
])

/** The family whose exact grammar matches the unit name, or null for an unknown name. */
export const unitFamily = (unit: unknown): UnitFamily | null => {
  if (typeof unit !== 'string' || unit.length > 240) return null
  for (const entry of UNIT_FAMILIES) {
    const match = entry.pattern.exec(unit)
    if (match && (match.groups?.uid === undefined || Number(match.groups.uid) <= UID_MAX)) return entry
  }
  return null
}
