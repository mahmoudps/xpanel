import { fail } from '@xpanel/core'
import type { OsFamily, OsProfile } from '@xpanel/core'

/** Absolute binaries the lifecycle plans run. argv[0] is never resolved through PATH. */
export interface LifecycleTools {
  tar: string
  mkdir: string
  dd: string
  systemctl: string
  /** MariaDB 10.5+ ship these names next to the mysql* compatibility links */
  mariadbDump: string
  mariadb: string
}

// Ubuntu 22.04/24.04 and EL 9/10 are merged-/usr systems: coreutils, GNU tar, systemd,
// and the MariaDB client all install into /usr/bin on both families.
const USR_BIN: LifecycleTools = Object.freeze({
  tar: '/usr/bin/tar',
  mkdir: '/usr/bin/mkdir',
  dd: '/usr/bin/dd',
  systemctl: '/usr/bin/systemctl',
  mariadbDump: '/usr/bin/mariadb-dump',
  mariadb: '/usr/bin/mariadb',
})

const BY_FAMILY: Readonly<Record<OsFamily, LifecycleTools>> = Object.freeze({ debian: USR_BIN, rhel: USR_BIN })

export const lifecycleTools = (os: Pick<OsProfile, 'family'>): LifecycleTools =>
  BY_FAMILY[os?.family] ?? fail('UNSUPPORTED_OS', 'unknown os family', { family: String(os?.family) })
