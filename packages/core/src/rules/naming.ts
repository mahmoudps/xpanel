// Names that end up in paths, unit names, config files and SQL. Every validator rejects;
// none of them repairs input silently. The only normalization is canonical form
// (lowercase, NFC, IDNA to punycode, one trailing dot) for case-insensitive names.
import { invalid } from './check.ts'

export const USERNAME_MAX = 16
export const DOMAIN_MAX = 253
export const DOMAIN_LABEL_MAX = 63
/**
 * MariaDB identifier limit for database names. Database-level grants store the name as an
 * escaped pattern in mysql.db (CHAR(64)), so every `_` counts twice against it.
 */
export const DB_NAME_MAX = 64
/** Kept at the MySQL-compatible 32 so dumps restore on either server. */
export const DB_USER_MAX = 32
export const EMAIL_LOCAL_MAX = 64
/** RFC 5321 path limit (256) minus the angle brackets. */
export const EMAIL_MAX = 254

/**
 * Account usernames double as the Linux user, its primary group, the DB prefix and the
 * slice owner, so any system user or group name is off limits: an account named `sudo`
 * or `docker` would otherwise collide with a privileged group. The agent still checks the
 * live passwd/group databases before creating a user; this list is what the API refuses.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // panel and competitors
  'xpanel', 'xwhm', 'xmail', 'cpanel', 'whm', 'webmail', 'plesk', 'aapanel', 'bt', 'directadmin',
  // generic / role
  'root', 'toor', 'admin', 'administrator', 'all', 'test', 'www', 'wwwdata', 'web', 'webmaster',
  'hostmaster', 'postmaster', 'abuse', 'noc', 'security', 'support', 'info', 'nobody', 'nogroup',
  'nfsnobody', 'anonymous', 'guest', 'default', 'public', 'system', 'virtfs', 'shared',
  // fixed API path segments under /api/accounts/
  'health',
  // debian/rhel base users
  'bin', 'daemon', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news', 'uucp', 'proxy', 'backup',
  'list', 'irc', 'gnats', 'operator', 'halt', 'shutdown', 'adm', 'ftp', 'ftpuser', 'sshd', 'ssh',
  'messagebus', 'dbus', 'polkitd', 'syslog', 'uuidd', 'tss', 'landscape', 'pollinate', 'usbmux',
  'dnsmasq', 'avahi', 'rpc', 'rpcuser', 'chrony', 'ntp', 'sssd', 'tcpdump', 'unbound', 'nscd',
  'saslauth', 'lxd', 'ubuntu', 'centos', 'rocky', 'alma', 'almalinux', 'cloud', 'ec2user', 'vagrant',
  'dhcpcd', 'fwupd', 'setroubleshoot', 'libstoragemgmt', 'clevis', 'geoclue', 'pipewire', 'pesign',
  'saned', 'colord', 'rtkit', 'gdm', 'cups', 'gopher', 'utempter', 'wireshark', 'pcap', 'sgx',
  'stapusr', 'stapdev', 'stapsys',
  // package managers
  'dnf', 'yum', 'rpm', 'dpkg',
  // privileged or sensitive groups
  'sudo', 'wheel', 'staff', 'users', 'shadow', 'utmp', 'tty', 'disk', 'kmem', 'mem', 'dialout', 'dip',
  'fax', 'voice', 'cdrom', 'floppy', 'tape', 'audio', 'video', 'plugdev', 'netdev', 'input', 'kvm',
  'render', 'docker', 'lxc', 'libvirt', 'qemu', 'lpadmin', 'printadmin', 'sambashare', 'crontab', 'cron',
  'at', 'mlocate', 'lock', 'src', 'sasl', 'ssl', 'certs', 'systemd', 'journal', 'apt', 'snap', 'snapd',
  // services the panel installs or talks to
  'mysql', 'mariadb', 'postgres', 'postgresql', 'redis', 'valkey', 'memcache', 'memcached', 'nginx',
  'apache', 'apache2', 'httpd', 'litespeed', 'lsadm', 'lsws', 'openlitespeed', 'postfix', 'postdrop',
  'dovecot', 'dovenull', 'vmail', 'mailnull', 'smmsp', 'exim', 'opendkim', 'opendmarc', 'rspamd',
  'spamd', 'clamav', 'clamupdate', 'clamscan', 'amavis', 'mailman', 'named', 'bind', 'pdns', 'powerdns',
  'proftpd', 'pureftpd', 'vsftpd', 'modsec', 'php', 'phpfpm', 'fpm', 'node', 'python', 'acme',
  'letsencrypt', 'certbot', 'squid', 'haproxy', 'varnish', 'ldap', 'nslcd', 'git', 'containerd', 'podman',
  // `<username>_schema` would name a MariaDB system schema (information_schema, performance_schema)
  'information', 'performance',
])

/**
 * Prefix rules: `systemd*` covers systemd-resolve/-network/..., `test*` follows the documented
 * cPanel rule, `xpanel*`, `xwhm*` and `xmail*` keep the namespace free for the panel's own users.
 */
export const RESERVED_USERNAME_PREFIXES: readonly string[] = ['systemd', 'test', 'xpanel', 'xwhm', 'xmail']

const USERNAME_RE = /^[a-z][a-z0-9]*$/

export const validateUsername = (name: unknown): string => {
  if (typeof name !== 'string' || name.length === 0) return invalid('username is required')
  if (name.length > USERNAME_MAX) return invalid(`username must be at most ${USERNAME_MAX} characters`, { name: name.slice(0, 64) })
  if (!USERNAME_RE.test(name)) {
    return invalid('username must be lowercase letters and digits and start with a letter', { name })
  }
  if (RESERVED_USERNAMES.has(name)) return invalid(`username "${name}" is reserved`, { name })
  const prefix = RESERVED_USERNAME_PREFIXES.find((p) => name.startsWith(p))
  if (prefix) return invalid(`usernames may not start with "${prefix}"`, { name, prefix })
  return name
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
// Delegated TLDs are letters or an IDN A-label. A digit-bearing last label such as `0x7f` is
// also what the WHATWG URL parser reads as an IPv4 number, so browsers could not reach it.
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
// Hard bound applied before any processing, so a hostile megabyte string never reaches IDNA.
const RAW_INPUT_MAX = 1024
// Label separators IDNA accepts besides "." (RFC 3490 section 3.1).
const IDNA_DOTS_RE = /[\u3002\uff0e\uff61]/g

/**
 * Special-use names that never belong to a hosted site: `localhost` resolves to loopback
 * (RFC 6761), `local` is multicast DNS (RFC 6762), `onion` is Tor (RFC 7686), `invalid` can
 * never resolve (RFC 6761), `arpa` holds the reverse zones (RFC 3172), and `localdomain` is the
 * loopback alias in /etc/hosts, so a tenant claiming it would receive the host's own requests.
 */
export const RESERVED_TLDS: ReadonlySet<string> = new Set(['localhost', 'localdomain', 'local', 'invalid', 'onion', 'arpa'])

const toAsciiHost = (host: string): string | null => {
  try {
    return new URL(`http://${host}/`).hostname
  } catch {
    return null
  }
}

// ---- RFC 3492 punycode decoding ----------------------------------------------------------

const PUNY_BASE = 36
const PUNY_TMIN = 1
const PUNY_TMAX = 26
const PUNY_MAX_INT = 0x7fffffff

const punyDigit = (c: number): number => (c >= 0x30 && c <= 0x39 ? c - 22 : c >= 0x61 && c <= 0x7a ? c - 0x61 : PUNY_BASE)

const punyAdapt = (delta: number, points: number, first: boolean): number => {
  let d = first ? Math.floor(delta / 700) : delta >> 1
  d += Math.floor(d / points)
  let k = 0
  while (d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
    d = Math.floor(d / (PUNY_BASE - PUNY_TMIN))
    k += PUNY_BASE
  }
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + 38))
}

/** Decodes the part of a lowercase A-label after `xn--`; null when it is not valid punycode. */
const decodePunycode = (input: string): string | null => {
  const out: number[] = []
  const basic = Math.max(0, input.lastIndexOf('-'))
  for (let j = 0; j < basic; j++) out.push(input.charCodeAt(j))
  let n = 128
  let i = 0
  let bias = 72
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
    const oldi = i
    for (let w = 1, k = PUNY_BASE; ; k += PUNY_BASE) {
      if (idx >= input.length) return null
      const digit = punyDigit(input.charCodeAt(idx++))
      if (digit >= PUNY_BASE || digit > Math.floor((PUNY_MAX_INT - i) / w)) return null
      i += digit * w
      const t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias
      if (digit < t) break
      if (w > Math.floor(PUNY_MAX_INT / (PUNY_BASE - t))) return null
      w *= PUNY_BASE - t
    }
    const len = out.length + 1
    bias = punyAdapt(i - oldi, len, oldi === 0)
    n += Math.floor(i / len)
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null
    i %= len
    out.splice(i++, 0, n)
  }
  return String.fromCodePoint(...out)
}

/**
 * The URL parser applies UTS-46 mapping: it drops invisible characters (zero-width space,
 * soft hyphen) and folds compatibility forms (full-width letters, circled letters). Accepting
 * that would store a different name than the one typed, so each label must decode back to
 * exactly what was typed, up to case and NFC.
 */
const assertTypedAsStored = (input: string, ascii: string): void => {
  const typed = input.normalize('NFC').replace(IDNA_DOTS_RE, '.').toLowerCase().replace(/\.$/, '').split('.')
  const stored = ascii.replace(/\.$/, '').split('.')
  const same =
    typed.length === stored.length &&
    stored.every((label, i) => label === typed[i] || (label.startsWith('xn--') && decodePunycode(label.slice(4)) === typed[i]))
  if (!same) {
    invalid('domain name contains invisible or compatibility characters that IDNA would change; type the name as registered', { name: input })
  }
}

const validateLabels = (name: string, labels: string[]): void => {
  for (const label of labels) {
    if (label.length === 0) invalid('domain contains an empty label', { name })
    if (label.length > DOMAIN_LABEL_MAX) invalid(`domain label exceeds ${DOMAIN_LABEL_MAX} characters`, { name, label })
    if (!LABEL_RE.test(label)) invalid('domain labels may contain only a-z, 0-9 and inner hyphens', { name, label })
    if (label.slice(2, 4) === '--' && !label.startsWith('xn--')) {
      invalid('labels with "--" in positions 3-4 are reserved for IDNA', { name, label })
    }
    if (label.startsWith('xn--') && decodePunycode(label.slice(4)) === null) invalid('domain contains an invalid punycode label', { name, label })
  }
  const tld = labels[labels.length - 1] ?? ''
  if (/^[0-9]+$/.test(tld)) invalid('IP addresses and numeric top-level labels are not domain names', { name })
  if (!TLD_RE.test(tld)) invalid('the top-level label must be letters or an xn-- IDN label', { name, tld })
  if (RESERVED_TLDS.has(tld)) invalid(`".${tld}" is a special-use name and cannot be hosted`, { name, tld })
  // the WHATWG URL parser also refuses A-labels that do not decode to a valid IDN
  if (labels.some((l) => l.startsWith('xn--')) && toAsciiHost(name) !== name) {
    invalid('domain contains an invalid punycode label', { name })
  }
}

/**
 * FQDN check for hosted names. Returns the canonical form: lowercase, punycode,
 * without the trailing dot. Rejects IPs, wildcards, single labels, `_`, `..`,
 * special-use names and Unicode that IDNA would silently rewrite.
 */
export const validateDomainName = (input: unknown): string => {
  if (typeof input !== 'string' || input.length === 0) return invalid('domain name is required')
  if (input.length > RAW_INPUT_MAX) return invalid('domain name is too long')
  if (/[\x00-\x20\x7f]/.test(input)) return invalid('domain name contains whitespace or control characters', { name: input })
  if (input.includes('*')) return invalid('wildcards are not allowed here; use a wildcard name', { name: input })
  // ASCII outside letters/digits/dot/hyphen is never legal, even mixed with Unicode
  // (this also blocks `%41`-style escapes the URL parser would otherwise decode).
  if (/[\x21-\x2c\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(input)) {
    return invalid('domain name contains invalid characters', { name: input })
  }
  let name = input
  if (/[^\x00-\x7f]/.test(name)) {
    const ascii = toAsciiHost(name)
    if (ascii === null) return invalid('domain name is not a valid internationalized name', { name: input })
    assertTypedAsStored(input, ascii)
    name = ascii
  }
  name = name.toLowerCase()
  if (name.endsWith('.')) name = name.slice(0, -1)
  if (name.length === 0 || name.length > DOMAIN_MAX) return invalid(`domain name must be 1..${DOMAIN_MAX} characters`, { name: input.slice(0, 300) })
  const labels = name.split('.')
  if (labels.length < 2) return invalid('domain name must be fully qualified (at least two labels)', { name })
  validateLabels(name, labels)
  return name
}

/** `*.example.com` only: one leftmost `*` label over a valid domain. Returns canonical form. */
export const validateWildcardName = (input: unknown): string => {
  if (typeof input !== 'string' || !input.startsWith('*.')) {
    return invalid('wildcard name must look like *.example.com', { name: typeof input === 'string' ? input.slice(0, 300) : null })
  }
  const base = validateDomainName(input.slice(2))
  const name = `*.${base}`
  if (name.length > DOMAIN_MAX) return invalid(`wildcard name exceeds ${DOMAIN_MAX} characters`, { name })
  return name
}

export const isWildcardName = (name: string): boolean => name.startsWith('*.')

const DB_SUFFIX_RE = /^[a-z0-9][a-z0-9_]*$/
const DB_FULL_NAME_RE = /^[a-z][a-z0-9]*_[a-z0-9][a-z0-9_]*$/

/** MariaDB's own schemas; no account database may carry one of these names. */
const MARIADB_SYSTEM_SCHEMAS: ReadonlySet<string> = new Set(['mysql', 'information_schema', 'performance_schema', 'sys'])

/** Length of the name once `_` is escaped for a database-level GRANT. */
const grantPatternLength = (name: string): number => name.length + (name.match(/_/g)?.length ?? 0)

const assertDbNameFits = (name: string): string => {
  if (grantPatternLength(name) > DB_NAME_MAX) {
    return invalid(`database name exceeds ${DB_NAME_MAX} characters (each "_" counts twice because GRANT stores it escaped)`, {
      name: name.slice(0, 80),
      max: DB_NAME_MAX,
    })
  }
  if (MARIADB_SYSTEM_SCHEMAS.has(name)) return invalid(`"${name}" is a MariaDB system schema`, { name })
  return name
}

/** Builds `<username>_<suffix>`. Usernames have no `_`, so the prefix is unambiguous. */
export const dbName = (username: string, suffix: unknown): string => {
  const user = validateUsername(username)
  if (typeof suffix !== 'string' || suffix.length === 0) return invalid('database name suffix is required')
  if (suffix.length > DB_NAME_MAX || !DB_SUFFIX_RE.test(suffix)) {
    return invalid('database name suffix may contain only a-z, 0-9 and _, starting with a letter or digit', { suffix: suffix.slice(0, 80) })
  }
  return assertDbNameFits(`${user}_${suffix}`)
}

/** Database user names follow the same prefix rule with the shorter user-name limit. */
export const dbUserName = (username: string, suffix: unknown): string => {
  const name = dbName(username, suffix)
  if (name.length > DB_USER_MAX) return invalid(`database user name exceeds ${DB_USER_MAX} characters`, { name, max: DB_USER_MAX })
  return name
}

/** Checks a full name already carries the owner's prefix (e.g. on import or rename). */
export const assertDbNameOwned = (username: string, name: unknown): string => {
  const user = validateUsername(username)
  if (typeof name !== 'string' || !name.startsWith(`${user}_`)) {
    return invalid(`database name must start with "${user}_"`, { name: typeof name === 'string' ? name.slice(0, 80) : null })
  }
  return dbName(user, name.slice(user.length + 1))
}

/**
 * `_` and `%` are wildcards in a database-level GRANT, so `GRANT ... ON bob_db.*` would also
 * match `bobxdb`. Grants must use this escaped pattern. The name is checked again here because
 * it goes straight into SQL: anything but a `<username>_<suffix>` name of a valid account
 * username is refused.
 */
export const dbGrantPattern = (name: unknown): string => {
  if (typeof name !== 'string' || name.length > DB_NAME_MAX || !DB_FULL_NAME_RE.test(name)) {
    return invalid('database name must look like <username>_<suffix> in a-z, 0-9 and _', { name: typeof name === 'string' ? name.slice(0, 80) : null })
  }
  validateUsername(name.slice(0, name.indexOf('_')))
  return assertDbNameFits(name).replace(/_/g, '\\_')
}

// Dot-atom subset. `+` is left out on purpose: it is the recipient delimiter, so a mailbox
// called `a+b` would be unreachable. Must start with a letter or digit so it can never be
// mistaken for an option when passed as an argv element.
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$/

/** Mailbox/FTP local part, lowercased (mail lookups are case-insensitive). */
export const validateEmailLocalPart = (input: unknown): string => {
  if (typeof input !== 'string' || input.length === 0) return invalid('local part is required')
  if (input.length > EMAIL_LOCAL_MAX) return invalid(`local part exceeds ${EMAIL_LOCAL_MAX} characters`)
  // checked before lowercasing: toLowerCase folds e.g. the Kelvin sign U+212A into ASCII "k"
  if (/[^\x21-\x7e]/.test(input)) return invalid('local part may contain only ASCII letters, digits, ".", "_" and "-"', { local: input })
  const local = input.toLowerCase()
  if (!LOCAL_PART_RE.test(local)) {
    return invalid('local part may contain only a-z, 0-9, ".", "_" and "-", and must start with a letter or digit', { local: input })
  }
  if (local.includes('..')) return invalid('local part may not contain ".."', { local: input })
  return local
}

/** `local@domain` login for a service user (mail, FTP, Web Disk). */
export const serviceLogin = (local: unknown, domain: unknown): string => {
  const login = `${validateEmailLocalPart(local)}@${validateDomainName(domain)}`
  if (login.length > EMAIL_MAX) return invalid(`address exceeds ${EMAIL_MAX} characters`, { login })
  return login
}

/** Splits and re-validates a stored `local@domain` login. */
export const parseServiceLogin = (login: unknown): { local: string; domain: string } => {
  if (typeof login !== 'string') return invalid('login is required')
  const at = login.lastIndexOf('@')
  if (at <= 0 || login.indexOf('@') !== at) return invalid('login must be local@domain', { login: login.slice(0, 300) })
  const value = serviceLogin(login.slice(0, at), login.slice(at + 1))
  const sep = value.indexOf('@')
  return { local: value.slice(0, sep), domain: value.slice(sep + 1) }
}
