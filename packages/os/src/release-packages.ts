import type { PackageRole } from '@xpanel/core'
import { DISTRO_DAEMONS_OFF } from './install.ts'
import { SUPPORTED_PHP_VERSIONS } from './php.ts'
import type { XpanelOsProfile } from './types.ts'

/** Pinned source builds of install.sh, for what no EL repository ships, with the file each leaves. */
export const EL_SOURCE_BUILDS = ['webalizer', 'awstats', 'fts-xapian'] as const
export type ElSourceBuild = (typeof EL_SOURCE_BUILDS)[number]
const WEBALIZER = { id: 'webalizer', path: '/usr/bin/webalizer' } as const
const AWSTATS = { id: 'awstats', path: '/usr/share/awstats/wwwroot/cgi-bin/awstats.pl' } as const
const FTS_XAPIAN = { id: 'fts-xapian', path: '/usr/lib64/dovecot/lib21_fts_xapian_plugin.so' } as const

/** One line of what the installer declares, grouped by what an operator would miss. */
export interface ReleaseFeature {
  id: string
  packages: readonly string[]
  /** Any of these installed proves the installer chose this option; empty on every host. */
  selectedBy: readonly string[]
  builds: readonly { readonly id: ElSourceBuild; readonly path: string }[]
  /** Distribution daemons that start with these packages and stay off, as after an install. */
  daemonsOff: readonly string[]
}

/**
 * The installer's package set for this OS, from the same profile roles. The install choices are not stored, so an
 * optional feature counts as chosen when its own main package is on the host: postfix alone proves nothing, some images ship it.
 */
export const releaseFeatures = (p: XpanelOsProfile): ReleaseFeature[] => {
  const roles = (...names: readonly PackageRole[]): string[] => [...new Set(names.flatMap(role => p.packages[role]))]
  const feature = (id: string, packages: readonly string[], options: Partial<ReleaseFeature> = {}): ReleaseFeature =>
    ({ id, packages, selectedBy: [], builds: [], daemonsOff: [], ...options })
  const el = p.family === 'rhel'
  return [
    feature('tools', p.bootstrapPackages),
    feature('web-server', roles('nginx', 'apache', 'apache-itk', 'apache-suexec', 'apache-fcgi')),
    feature('core-services', roles('postgresql', 'redis', 'sshd', 'nftables', 'quota', 'acme')),
    feature('web-stats', roles('web-stats'), { builds: el ? [WEBALIZER, ...(p.major >= 10 ? [AWSTATS] : [])] : [] }),
    feature('web-disk', roles('webdav'), { daemonsOff: DISTRO_DAEMONS_OFF }),
    feature('calendars', roles('caldav')),
    feature('mariadb', roles('mariadb'), { selectedBy: p.packages.mariadb }),
    feature('mail', roles('postfix', 'opendkim', 'dovecot'), { selectedBy: p.packages.dovecot.slice(0, 1), builds: el ? [FTS_XAPIAN] : [] }),
    feature('dns', roles('powerdns'), { selectedBy: p.packages.powerdns.slice(0, 1) }),
    feature('ftp', roles('ftp'), { selectedBy: p.packages.ftp }),
    feature('modsecurity', roles('modsecurity'), { selectedBy: p.packages.modsecurity.slice(0, 1) }),
    ...SUPPORTED_PHP_VERSIONS.map(version => {
      const packages = p.phpPackages(version)
      return feature(`php-${version}`, packages, { selectedBy: packages.slice(0, 1) })
    }),
  ]
}
