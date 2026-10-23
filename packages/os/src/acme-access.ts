import { fail } from '@xpanel/core'
import type { HostAction } from '@xpanel/core'

/** Parent of the HTTP-01 webroot. Mode 2770 blocks nginx unless this user has execute. */
export const ACME_PARENT = '/var/lib/xpanel'
/** Directory nginx aliases to `/.well-known/acme-challenge/`. */
export const ACME_DIR = '/var/lib/xpanel/acme'

const NGINX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

export const assertNginxUser = (user: string): string =>
  NGINX_USER_RE.test(user) ? user : fail('VALIDATION', 'nginx user name is not a system account name')

/** `setfacl -m u:<nginx>:x /var/lib/xpanel` so nginx can traverse the state directory. */
export const acmeTraverseAclArgv = (nginxUser: string): string[] => [
  '/usr/bin/setfacl',
  '-m',
  `u:${assertNginxUser(nginxUser)}:x`,
  ACME_PARENT,
]

/** Probe argv. Every command must exit 0 before HTTP-01 is considered reachable. */
export const acmeTraverseProbeArgv = (nginxUser: string): string[][] => {
  const user = assertNginxUser(nginxUser)
  const run = (check: string, path: string): string[] => ['/usr/sbin/runuser', '-u', user, '--', '/usr/bin/test', check, path]
  return [run('-x', ACME_PARENT), run('-x', ACME_DIR), run('-r', ACME_DIR)]
}

export const acmeDirAction = (): HostAction => ({
  kind: 'ensure-dir',
  path: ACME_DIR,
  mode: 0o755,
  owner: 'root',
  group: 'root',
})
