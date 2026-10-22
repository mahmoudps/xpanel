import type { ApacheMpm, Engine, HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import type { PhpVersion } from './php.ts'

/** Parsed os-release(5). `fields` holds every valid assignment, unquoted. */
export interface OsRelease {
  id: string
  idLike: string[]
  versionId: string
  versionCodename: string
  name: string
  prettyName: string
  platformId: string
  fields: Readonly<Record<string, string>>
}

/** Paths beyond the shared contract that installers and renderers need. */
export interface XpanelPaths {
  apacheMainConf: string
  /** file that carries the distribution's Apache `Listen` directives; the installer rewrites it without them */
  apachePortsConf: string
  /** mod_ssl's own config when it declares `Listen 443` (EL); null when ports.conf covers it (Debian) */
  apacheSslConf: string | null
  /** distribution test page applied to every vhost (EL welcome.conf); null where none ships */
  apacheWelcomeConf: string | null
  /** Debian sites-available; apacheVhostDir is the directory Apache actually includes */
  apacheSitesAvailableDir: string | null
  apacheLogDir: string
  nginxLogDir: string
  /** apache2-suexec-custom config (line 1 docroot, line 2 userdir suffix); null when the docroot is compiled in */
  suexecConfigFile: string | null
  /** drop-in directory included by paths.sshdConfig (the main sshd_config file) */
  sshdConfigDir: string
  /** directory holding paths.powerdnsConf (the main pdns.conf file) */
  powerdnsConfDir: string
  postgresqlDataDir: string
}

export interface OsBinaries {
  env: string
  systemctl: string
  nginx: string
  aptGet: string | null
  addAptRepository: string | null
  a2enmod: string | null
  a2dismod: string | null
  a2disconf: string | null
  a2dissite: string | null
  /** Debian adduser, idempotent for --system users */
  adduser: string | null
  dnf: string | null
  postgresqlSetup: string | null
}

export interface XpanelOsProfile extends OsProfile {
  major: number
  /** Ubuntu codename (jammy, noble); empty on EL */
  codename: string
  paths: OsProfile['paths'] & XpanelPaths
  bin: OsBinaries
  /** packages needed before any repository can be added */
  bootstrapPackages: string[]
  /** system users no package creates but the profile names (Debian's dedicated nginx user) */
  extraSystemUsers: string[]
  /** FPM master binary; xPanel runs one master per account inside its slice */
  phpFpmBinary: (version: string) => string
  /** php-cgi run by the cgi, fcgid and suphp handler wrappers */
  phpCgiBinary: (version: string) => string
  phpIniFile: (version: string) => string
  lsphpPackages: (version: string) => string[]
  lsphpBinary: (version: string) => string
  /** socket unit that owns the SSH listener (Ubuntu 24.04 socket activation), else null */
  sshSocketUnit: string | null
}

export interface InstallOptions {
  engine: Engine
  phpVersions: string[]
  withMail: boolean
  withDns: boolean
  withFtp: boolean
  /** default 'itk'; 'prefork' must be chosen explicitly where itk is not packaged */
  apacheMpm?: ApacheMpm
  /** default false */
  withModSecurity?: boolean
}

export interface ResolvedInstallOptions {
  engine: Engine
  phpVersions: PhpVersion[]
  withMail: boolean
  withDns: boolean
  withFtp: boolean
  apacheMpm: ApacheMpm
  withModSecurity: boolean
}

export type ExecAction = Extract<HostAction, { kind: 'exec' }>

/** exec with an idempotency guard: an executor skips it when `creates` already exists. */
export type GuardedExec = ExecAction & { creates?: string }

export type InstallAction = Exclude<HostAction, { kind: 'exec' }> | GuardedExec

export type InstallWarningCode =
  | 'APACHE_SHARED_IDENTITY'
  | 'EDGE_NOT_STARTED'
  | 'SELINUX_UNMANAGED'
  | 'FIREWALLD_CONFLICT'
  | 'SUEXEC_DOCROOT_FIXED'
  | 'SSH_SOCKET_ACTIVATION'
  | 'RESOLVED_STUB_PORT_53'
  | 'SERVICES_NOT_STARTED'

export interface InstallWarning {
  code: InstallWarningCode
  message: string
}

export interface InstallBundle {
  /** run in order */
  actions: InstallAction[]
  /** write after the actions, before the reconciler starts the web servers */
  files: RenderedFile[]
  warnings: InstallWarning[]
}
