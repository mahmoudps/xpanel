// Contract between renderers (pure), the OS adapters and the reconciler (side effects).

export type OsFamily = 'debian' | 'rhel'

export type ServiceRole =
  | 'nginx'
  | 'apache'
  | 'openlitespeed'
  | 'mariadb'
  | 'postgresql'
  | 'postfix'
  | 'dovecot'
  | 'powerdns'
  | 'redis'
  | 'ftp'
  | 'sshd'
  | 'nftables'

export type PackageRole =
  | ServiceRole
  | 'apache-itk'
  | 'apache-suexec'
  | 'apache-fcgi'
  | 'quota'
  | 'acme'
  | 'modsecurity'

/** Everything distribution-specific, resolved once from /etc/os-release. */
export interface OsProfile {
  family: OsFamily
  /** os-release ID, e.g. ubuntu, centos, almalinux, rocky */
  id: string
  versionId: string
  packageManager: 'apt' | 'dnf'
  packages: Record<PackageRole, string[]>
  /** systemd unit names */
  services: Record<ServiceRole, string>
  /** package list for one side-by-side PHP version, e.g. 8.3 */
  phpPackages: (version: string) => string[]
  phpFpmService: (version: string) => string
  phpFpmPoolDir: (version: string) => string
  phpFpmSocketDir: string
  phpBinary: (version: string) => string
  paths: {
    apacheRoot: string
    apacheVhostDir: string
    apacheModulesConf: string
    apacheUser: string
    apacheCtl: string
    nginxRoot: string
    nginxVhostDir: string
    nginxUser: string
    olsRoot: string
    suexecDocroot: string
    systemdDir: string
    nftablesConf: string
    sshdConfig: string
    powerdnsConf: string
    postfixDir: string
    dovecotDir: string
  }
}

/** A file the reconciler writes into a config generation. */
export interface RenderedFile {
  /** absolute target path on the host */
  path: string
  content: string
  /** octal mode, e.g. 0o640 */
  mode: number
  owner?: string
  group?: string
}

/** A command that must succeed before a generation is activated. */
export interface ConfigTest {
  name: string
  argv: string[]
}

/** A side effect the reconciler performs. Executors are swappable (real Linux, fake). */
export type HostAction =
  | { kind: 'ensure-group'; name: string; gid: number }
  | { kind: 'ensure-user'; name: string; uid: number; gid: number; home: string; shell: string }
  | { kind: 'delete-user'; name: string }
  | { kind: 'ensure-dir'; path: string; mode: number; owner: string; group: string }
  | { kind: 'remove-path'; path: string }
  | { kind: 'set-quota'; user: string; blockSoftKb: number; blockHardKb: number; filesystem: string }
  | { kind: 'systemd-daemon-reload' }
  | { kind: 'systemd'; verb: 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'; unit: string }
  | { kind: 'systemd-set-property'; unit: string; properties: Record<string, string> }
  | { kind: 'exec'; argv: string[]; runAsUser?: string }
  | { kind: 'sql'; engine: 'mariadb' | 'postgresql'; statements: string[] }
