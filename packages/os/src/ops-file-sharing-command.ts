/** Reviewed NFS export grammar. exportfs(8) -r re-exports /etc/exports and /etc/exports.d/*.exports; -a acts on all entries. */
export const EXPORTFS_REEXPORT_ARGV = ['/usr/sbin/exportfs', '-ra'] as const
/** The only file xPanel writes; exports(5) reads every *.exports file under /etc/exports.d. Admin-owned /etc/exports is never edited. */
export const MANAGED_EXPORTS_PATH = '/etc/exports.d/xpanel.exports'
/** exportfs(8): /var/lib/nfs/etab is the kernel-facing table of currently exported directories. */
export const NFS_ETAB_PATH = '/var/lib/nfs/etab'

export const EXPORTFS_BINARY = EXPORTFS_REEXPORT_ARGV[0]
export const NFS_SERVER_ACTIVE_ARGV = ['/usr/bin/systemctl', 'is-active', '--quiet', '--', 'nfs-server.service'] as const
export const NFS_SERVER_ENABLE_ARGV = ['/usr/bin/systemctl', 'enable', '--now', '--', 'nfs-server.service'] as const

export const isOpsFileSharingCommand = (argv: readonly unknown[]): boolean =>
  Array.isArray(argv) && [EXPORTFS_REEXPORT_ARGV, NFS_SERVER_ACTIVE_ARGV, NFS_SERVER_ENABLE_ARGV].some(reviewed => argv.length === reviewed.length && reviewed.every((value, index) => value === argv[index]))
