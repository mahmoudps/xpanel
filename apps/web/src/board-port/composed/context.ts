import type {
  Account,
  Database,
  DatabaseUser,
  Domain,
  DomainCustomConfig,
  IoAnalyticsSnapshot,
  MailIpConfig,
  Plan,
  Reseller,
  ServerIpEntry,
  ServiceUser,
  WebsiteAnalyticsSnapshot,
} from '@xpanel/core'
import type { Locale } from '../../i18n.ts'

export interface ComposedFileEntry {
  name: string
  path: string
  kind: 'file' | 'folder'
  sizeBytes: number
  modeOctal: string
  modifiedAt: string
  trashed?: boolean
}

export interface ComposedServiceRow {
  name: string
  unit: string
  version: string
  active: boolean
  role: string
  rssMb: number
}

export interface ComposedGenerationRow {
  generationId: number
  at: string
  actor: string
  summary: string
  stateChecksum: string
  filesCount: number
  durationMs: number
  status: 'active' | 'superseded' | 'rolled-back'
}

export interface ComposedContext {
  locale: Locale
  account?: Account
  plan?: Plan
  domains?: readonly Domain[]
  files?: readonly ComposedFileEntry[]
  databases?: readonly Database[]
  databaseUsers?: readonly Pick<DatabaseUser, 'id' | 'name' | 'grants'>[]
  serviceUsers?: readonly ServiceUser[]
  customConfig?: DomainCustomConfig
  websiteAnalytics?: WebsiteAnalyticsSnapshot
  terminalSessionId?: string
  shellEnabled?: boolean
  usage?: {
    phpVersion: string | null
    diskBytes: number | null
    memoryBytes: number | null
    processCount: number | null
    bandwidth: 'unmeasured'
  }
  accounts?: readonly Account[]
  resellers?: readonly Reseller[]
  services?: readonly ComposedServiceRow[]
  ipPool?: readonly ServerIpEntry[]
  mailIpConfig?: MailIpConfig
  generations?: readonly ComposedGenerationRow[]
  ioSnapshot?: IoAnalyticsSnapshot
  generationId?: number
  isRoot?: boolean
}
