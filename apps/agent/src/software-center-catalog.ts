import { msgid } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS, profileFor } from '@xpanel/os'
import type { SoftwareCenterFamily } from '../../../packages/os/src/software-center-command.ts'

/**
 * Shipped reviewed component catalog. It is part of the release code, so its identity is the
 * code identity: no remote catalog, no URL and no caller-supplied package name is ever trusted.
 * Package names are distro repository names (Ubuntu main/universe, EL AppStream/BaseOS/EPEL,
 * Remi SCL for PHP). `rhel: null` means no reviewed name exists for that family.
 */
export type SoftwareCenterPage = 'catalog' | 'module' | 'runtime'
export interface SoftwareComponent {
  id: string
  page: SoftwareCenterPage
  category: string
  name: string
  /** English source message; the web UI translates it. */
  description: string
  packages: { debian: readonly string[]; rhel: readonly string[] | null }
  /** systemd units the packages provide; informational only, never started or stopped here */
  services?: readonly string[]
  requires?: readonly string[]
  conflicts?: readonly string[]
  /** reviewed estimates, never observations: resident memory while in use and installed disk */
  estimate: { memoryMb: number; diskMb: number }
  phpVersion?: string
}
interface PhpModuleTemplate {
  key: string
  name: string
  description: string
  /** Debian/ondrej: php<version>-<debian>; Remi SCL: php<compact>-php-<rhel> */
  debian: string
  rhel: string | null
  estimate: { memoryMb: number; diskMb: number }
}

const component = (id: string, page: SoftwareCenterPage, category: string, name: string, description: string, debian: readonly string[], rhel: readonly string[] | null, memoryMb: number, diskMb: number, extra: Pick<SoftwareComponent, 'services' | 'requires' | 'conflicts'> = {}): SoftwareComponent =>
  ({ id, page, category, name, description, packages: { debian, rhel }, estimate: { memoryMb, diskMb }, ...extra })

export const SOFTWARE_CENTER_CATALOG: readonly SoftwareComponent[] = [
  component('memcached', 'catalog', 'cache', 'Memcached', msgid('In-memory key-value cache server for application sessions and objects.'), ['memcached'], ['memcached'], 64, 1, { services: ['memcached.service'] }),
  component('imagemagick', 'catalog', 'media', 'ImageMagick', msgid('Command-line image conversion and resizing tools.'), ['imagemagick'], ['ImageMagick'], 0, 30),
  component('ffmpeg', 'catalog', 'media', 'FFmpeg', msgid('Audio and video conversion toolkit.'), ['ffmpeg'], null, 0, 80),
  component('ghostscript', 'catalog', 'media', 'Ghostscript', msgid('PostScript and PDF interpreter used for document thumbnails.'), ['ghostscript'], ['ghostscript'], 0, 40),
  component('fail2ban', 'catalog', 'security', 'Fail2ban', msgid('Log-driven ban service for repeated failed sign-ins.'), ['fail2ban'], ['fail2ban-server'], 40, 10, { services: ['fail2ban.service'] }),
  component('clamav', 'catalog', 'security', 'ClamAV', msgid('Antivirus scanner with signature updates. A scan can use about 1 GB of memory.'), ['clamav'], ['clamav', 'clamav-update'], 1000, 400, { services: ['clamav-freshclam.service'] }),
  component('git', 'catalog', 'developer', 'Git', msgid('Distributed version control client.'), ['git'], ['git'], 0, 40),
  component('composer', 'catalog', 'developer', 'Composer', msgid('PHP dependency manager from the distribution repository.'), ['composer'], null, 0, 10),
  component('sqlite', 'catalog', 'developer', 'SQLite CLI', msgid('Command-line shell for SQLite databases.'), ['sqlite3'], ['sqlite'], 0, 2),
  component('zip-tools', 'catalog', 'utilities', 'Zip and Unzip', msgid('Create and extract zip archives.'), ['zip', 'unzip'], ['zip', 'unzip'], 0, 2),
  component('htop', 'catalog', 'utilities', 'htop', msgid('Interactive process viewer.'), ['htop'], ['htop'], 0, 1),
  component('supervisor', 'catalog', 'utilities', 'Supervisor', msgid('Process control system for long-running application workers.'), ['supervisor'], ['supervisor'], 30, 5, { services: ['supervisor.service'] }),
  component('rabbitmq', 'catalog', 'utilities', 'RabbitMQ', msgid('Message broker for application queues. The distribution package includes its Erlang runtime.'), ['rabbitmq-server'], null, 150, 60, { services: ['rabbitmq-server.service'] }),
  component('podman', 'catalog', 'developer', 'Podman', msgid('Daemonless container engine that can also run rootless containers.'), ['podman'], ['podman'], 0, 120),
  component('nodejs', 'runtime', 'nodejs', 'Node.js', msgid('Distribution Node.js runtime. The version is the one your repositories provide.'), ['nodejs'], ['nodejs'], 0, 60),
  component('npm', 'runtime', 'nodejs', 'npm', msgid('Node.js package manager from the distribution repository.'), ['npm'], ['npm'], 0, 150, { requires: ['nodejs'] }),
  component('python3-pip', 'runtime', 'python', 'pip for Python 3', msgid('Python package installer for the system Python 3.'), ['python3-pip'], ['python3-pip'], 0, 20),
  component('python3-venv', 'runtime', 'python', 'Python 3 venv', msgid('Virtual environment support. RHEL-family Python 3 includes venv already.'), ['python3-venv'], null, 0, 5),
  component('python3-dev', 'runtime', 'python', 'Python 3 headers', msgid('Headers for building native Python extensions.'), ['python3-dev'], ['python3-devel'], 0, 30),
  component('golang', 'runtime', 'go', 'Go', msgid('Distribution Go toolchain.'), ['golang-go'], ['golang'], 0, 400),
  component('openjdk-17', 'runtime', 'java', 'OpenJDK 17 runtime', msgid('Headless Java 17 runtime.'), ['openjdk-17-jre-headless'], ['java-17-openjdk-headless'], 0, 200),
  component('openjdk-21', 'runtime', 'java', 'OpenJDK 21 runtime', msgid('Headless Java 21 runtime.'), ['openjdk-21-jre-headless'], ['java-21-openjdk-headless'], 0, 210),
  component('perl-dbi', 'module', 'perl', 'Perl DBI', msgid('Perl database interface.'), ['libdbi-perl'], ['perl-DBI'], 0, 3),
  component('perl-dbd-mariadb', 'module', 'perl', 'Perl DBD::MariaDB', msgid('MariaDB driver for Perl DBI.'), ['libdbd-mariadb-perl'], null, 0, 2, { requires: ['perl-dbi'] }),
  component('perl-libwww', 'module', 'perl', 'Perl LWP', msgid('Perl web client library.'), ['libwww-perl'], ['perl-libwww-perl'], 0, 3),
  component('perl-json', 'module', 'perl', 'Perl JSON', msgid('JSON encoder and decoder for Perl.'), ['libjson-perl'], ['perl-JSON'], 0, 1),
  component('perl-net-ssleay', 'module', 'perl', 'Perl Net::SSLeay', msgid('OpenSSL bindings for Perl.'), ['libnet-ssleay-perl'], ['perl-Net-SSLeay'], 0, 2),
]

const PHP_MODULE_TEMPLATES: readonly PhpModuleTemplate[] = [
  { key: 'redis', name: 'redis', description: msgid('PHP client extension for Redis.'), debian: 'redis', rhel: null, estimate: { memoryMb: 2, diskMb: 2 } },
  { key: 'imagick', name: 'imagick', description: msgid('ImageMagick bindings for PHP.'), debian: 'imagick', rhel: null, estimate: { memoryMb: 4, diskMb: 30 } },
  { key: 'memcached', name: 'memcached', description: msgid('PHP client extension for Memcached.'), debian: 'memcached', rhel: 'pecl-memcached', estimate: { memoryMb: 2, diskMb: 2 } },
  { key: 'apcu', name: 'APCu', description: msgid('In-process user data cache for PHP.'), debian: 'apcu', rhel: 'pecl-apcu', estimate: { memoryMb: 32, diskMb: 1 } },
  { key: 'igbinary', name: 'igbinary', description: msgid('Compact binary serializer for PHP.'), debian: 'igbinary', rhel: 'pecl-igbinary', estimate: { memoryMb: 1, diskMb: 1 } },
  { key: 'ldap', name: 'LDAP', description: msgid('LDAP directory functions for PHP.'), debian: 'ldap', rhel: 'ldap', estimate: { memoryMb: 1, diskMb: 1 } },
  { key: 'pgsql', name: 'PostgreSQL', description: msgid('PostgreSQL drivers for PHP.'), debian: 'pgsql', rhel: 'pgsql', estimate: { memoryMb: 1, diskMb: 2 } },
  { key: 'gmp', name: 'GMP', description: msgid('Arbitrary-precision arithmetic for PHP.'), debian: 'gmp', rhel: 'gmp', estimate: { memoryMb: 1, diskMb: 1 } },
]

const compact = (version: string): string => version.replace('.', '')
const supportedPhp = new Set<string>(SUPPORTED_PHP_VERSIONS)
/** Module rows exist only for observed installed PHP versions. */
export function phpModuleComponents(phpVersions: readonly string[]): SoftwareComponent[] {
  return [...new Set(phpVersions)].filter(version => supportedPhp.has(version)).sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
    .flatMap(version => PHP_MODULE_TEMPLATES.map(template => ({
      id: 'php' + compact(version) + '-' + template.key, page: 'module' as const, category: 'php', name: 'PHP ' + version + ' ' + template.name, description: template.description,
      packages: { debian: ['php' + version + '-' + template.debian], rhel: template.rhel === null ? null : ['php' + compact(version) + '-php-' + template.rhel] },
      estimate: template.estimate, phpVersion: version,
    })))
}
export const softwareCenterComponents = (phpVersions: readonly string[]): SoftwareComponent[] => [...SOFTWARE_CENTER_CATALOG, ...phpModuleComponents(phpVersions)]
export const componentPackages = (item: SoftwareComponent, family: SoftwareCenterFamily): readonly string[] | null => family === 'debian' ? item.packages.debian : item.packages.rhel

/** Packages that identify an installed PHP version: the CLI or FPM runtime of the supported series. */
export const phpRuntimeMarkers = (family: SoftwareCenterFamily): { version: string; packages: string[] }[] => SUPPORTED_PHP_VERSIONS.map(version => ({
  version, packages: family === 'debian' ? ['php' + version + '-cli', 'php' + version + '-fpm'] : ['php' + compact(version) + '-php-cli', 'php' + compact(version) + '-php-fpm'],
}))

// The panel's own stack is never removable here: every package the installer profiles name for any
// supported release (web engines, PHP-FPM for every supported version, MariaDB, PostgreSQL, Postfix,
// Dovecot, PowerDNS, Redis, nftables, SSH, quota, ACME) plus the base system that runs the agent.
const SYSTEM_PROTECTED: Readonly<Record<SoftwareCenterFamily, readonly string[]>> = {
  debian: ['apt', 'dpkg', 'libc6', 'systemd', 'systemd-sysv', 'init', 'bash', 'coreutils', 'util-linux', 'login', 'passwd', 'sudo', 'openssl', 'python3', 'nginx-common', 'nginx-core', 'apache2-bin', 'mariadb-server-core', 'mariadb-client', 'mariadb-common', 'postgresql-common'],
  rhel: ['dnf', 'rpm', 'glibc', 'systemd', 'bash', 'coreutils', 'util-linux', 'shadow-utils', 'pam', 'sudo', 'openssl', 'python3', 'nginx-core', 'nginx-filesystem', 'httpd-core', 'httpd-filesystem', 'mariadb', 'postgresql'],
}
const PROFILE_RELEASES: Readonly<Record<SoftwareCenterFamily, readonly string[]>> = {
  debian: ['ID=ubuntu\nVERSION_ID=22.04\n', 'ID=ubuntu\nVERSION_ID=24.04\n'],
  rhel: ['ID=almalinux\nVERSION_ID=9\n', 'ID=almalinux\nVERSION_ID=10\n'],
}
const protectedSets = new Map<SoftwareCenterFamily, ReadonlySet<string>>()
export function protectedPackageNames(family: SoftwareCenterFamily): ReadonlySet<string> {
  const known = protectedSets.get(family)
  if (known) return known
  const names = new Set<string>(SYSTEM_PROTECTED[family])
  for (const release of PROFILE_RELEASES[family]) {
    const profile = profileFor(release)
    for (const list of Object.values(profile.packages)) for (const name of list) names.add(name)
    for (const name of profile.bootstrapPackages) names.add(name)
    for (const version of SUPPORTED_PHP_VERSIONS) for (const name of [...profile.phpPackages(version), ...profile.lsphpPackages(version)]) names.add(name)
  }
  const frozen: ReadonlySet<string> = names
  protectedSets.set(family, frozen)
  return frozen
}
/** Debian simulation names can carry an architecture qualifier (libc6:amd64). */
export const isProtectedPackage = (family: SoftwareCenterFamily, name: string): boolean => protectedPackageNames(family).has(family === 'debian' ? name.replace(/:[a-z0-9-]+$/, '') : name)
