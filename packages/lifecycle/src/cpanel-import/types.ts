import type { DomainKind, Limit, PlanCaps } from '@xpanel/core'
import type { services } from '@xpanel/render'
import type { FileRef } from '../archive/sink.ts'
import type { DomainMail } from '../backup/mail-config.ts'

export interface ImportWarning {
  code: string
  message: string
  path?: string
}

export interface ImportAccount {
  /** target username (the source name unless renamed); no uid: one is allocated on apply */
  username: string
  primaryDomain: string
  contactEmail: string | null
  sourcePlan: string | null
  sourceIp: string | null
  diskQuotaMb: Limit | null
  bandwidthMbMonth: Limit | null
  caps: Partial<PlanCaps>
  passwordResetRequired: true
}

export interface ImportDomain {
  name: string
  kind: DomainKind
  /** parent domain name for aliases and subdomains */
  parent: string | null
  /** relative to the new home */
  docRoot: string
  serverAliases: string[]
  phpVersion: string | null
  wildcard: boolean
}

export interface ImportDatabase {
  sourceName: string
  name: string
  sql: FileRef
}

export interface ImportDbUser {
  sourceName: string
  name: string
  hosts: string[]
  grants: { database: string; privileges: services.MariadbPrivilege[] }[]
  passwordResetRequired: true
}

export interface ImportZone {
  zone: string
  /** desired-state records; the source SOA is dropped because the new server writes its own */
  records: services.ZoneRecord[]
  /** apex NS targets as exported; they usually still name the old server */
  sourceNameservers: string[]
}

export interface ImportMailbox {
  address: string
  quotaMb: Limit
  /** maildir relative to the new home */
  maildir: string
  hasMaildir: boolean
  passwordResetRequired: true
}

export interface ImportCertificate {
  names: string[]
  notAfter: string
  cert: FileRef
  key: FileRef | null
}

/** A crontab line of the account; imported paused until the owner reviews it. */
export interface ImportCronJob {
  schedule: string
  command: string
}

export interface ImportPlan {
  format: 'cpmove' | 'backup'
  topDir: string
  sourceUsername: string
  account: ImportAccount
  domains: ImportDomain[]
  databases: ImportDatabase[]
  dbUsers: ImportDbUser[]
  remoteDbHosts: string[]
  dnsZones: ImportZone[]
  mailboxes: ImportMailbox[]
  /** forwarders and default addresses per domain, in the renderer's shapes */
  mail: DomainMail[]
  certificates: ImportCertificate[]
  cronJobs: ImportCronJob[]
  home: { files: number; directories: number; symlinks: number; bytes: number; skipped: number }
  warnings: ImportWarning[]
}
