import { createHash } from 'node:crypto'
import { auditEntry, fail, isXpanelError, sliceUnit } from '@xpanel/core'
import type { Principal } from '@xpanel/core'
import { allocateUid, readCpanelArchive } from '@xpanel/lifecycle'
import type {
  AuditPort,
  Body,
  ByteSource,
  ClockPort,
  ImportCertificate,
  ImportDatabase,
  ImportDbUser,
  ImportDomain,
  ImportMailbox,
  ImportPlan,
  ImportSink,
  ImportWarning,
  ImportZone,
  LocalInventory,
  SinkItem,
} from '@xpanel/lifecycle'

export const DEFAULT_CPANEL_MAX_ENTRIES = 500_000
export const DEFAULT_CPANEL_MAX_TOTAL_BYTES = 50 * 1024 * 1024 * 1024
export const DEFAULT_CPANEL_DEADLINE_MS = 30 * 60 * 1000

const HOSTILE_SQL_DUMP_RE =
  /(?:^|\n|;)\s*(?:GRANT\s+[\s\S]*?\b(?:SUPER|FILE|SHUTDOWN|PROCESS|RELOAD|GRANT\s+OPTION)\b|CREATE\s+(?:DEFINER\s*=\s*(?!`?CURRENT_USER`?)\S+)\s+|\\!|SYSTEM\b|SOURCE\b|INTO\s+(?:OUTFILE|DUMPFILE)\b|LOAD\s+DATA\s+LOCAL\s+INFILE\b)/i

export interface StagedCpanelArtifact {
  ref: string
  item: SinkItem
  sha256: string
  bytes: number
  content: Buffer
}

export interface CpanelImportReport {
  importId: string
  archiveDisplayName: string
  format: 'cpmove' | 'backup'
  sourceUsername: string
  allocatedIdentity: {
    username: string
    uid: number
    gid: number
    slice: string
    home: string
    passwordResetRequired: true
  }
  imported: {
    account: ImportPlan['account']
    domains: ImportDomain[]
    databases: ImportDatabase[]
    dbUsers: ImportDbUser[]
    dnsZones: ImportZone[]
    mailboxes: ImportMailbox[]
    mail: ImportPlan['mail']
    certificates: ImportCertificate[]
    homeFiles: number
    homeDirectories: number
    homeSymlinks: number
    homeBytes: number
  }
  skipped: {
    homeSkippedCount: number
    items: ImportWarning[]
  }
  unsupported: ImportWarning[]
  warnings: ImportWarning[]
  cutoverReady: boolean
}

export interface CpanelImportApplyPort {
  getLocalInventory(): Promise<LocalInventory>
  provisionImportedAccount(input: {
    importId: string
    uid: number
    gid: number
    slice: string
    home: string
    plan: ImportPlan
    stagedItems: readonly StagedCpanelArtifact[]
  }): Promise<{ accountId: string; generationId: number }>
  rollbackProvisionedAccount(importId: string, username: string): Promise<void>
}

export interface CpanelImportRunnerPorts {
  applyPort: CpanelImportApplyPort
  clock: ClockPort
  audit?: AuditPort
  nowMs?: () => number
}

const UNSUPPORTED_WARNING_CODES: ReadonlySet<string> = new Set([
  'cron-not-imported',
  'postgresql-unsupported',
  'dkim-keys-not-imported',
  'ftp-accounts-not-imported',
  'split-home-unsupported',
  'filters-not-imported',
  'unsupported-item',
  'main-inbox-not-imported',
])

const SKIPPED_WARNING_CODES: ReadonlySet<string> = new Set([
  'symlink-escape',
  'symlink-chain',
  'symlink-not-allowed',
  'special-file',
  'unsupported-type',
  'control-chars',
  'hardlink-skipped',
  'credentials-file-skipped',
  'cpanel-internal',
  'mail-auth-file',
  'domain-skipped',
  'database-skipped',
  'grant-dropped',
  'zone-skipped',
  'dns-record-skipped',
  'mailbox-skipped',
  'forwarder-skipped',
  'forwarder-unsafe',
  'ssl-cert-foreign',
  'ssl-cert-expired',
  'ssl-cert-unreadable',
  'ssl-key-unreadable',
  'ssl-key-unused',
  'ssl-key-missing',
  'file-too-large',
])

class ConfinedCpanelStagingSink implements ImportSink {
  readonly staged: StagedCpanelArtifact[] = []
  abortedReason: Error | null = null
  private readonly checkDeadline: () => void
  private readonly onItemStored?: (item: SinkItem, count: number) => Promise<void> | void

  constructor(
    checkDeadline: () => void,
    onItemStored?: (item: SinkItem, count: number) => Promise<void> | void,
  ) {
    this.checkDeadline = checkDeadline
    this.onItemStored = onItemStored
  }

  async put(item: SinkItem, body: Body): Promise<string> {
    this.checkDeadline()
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of body) {
      this.checkDeadline()
      const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      bytes += b.length
      hash.update(b)
      chunks.push(b)
    }
    const content = Buffer.concat(chunks)
    if (item.part === 'sql') {
      const sqlText = content.toString('utf8')
      if (HOSTILE_SQL_DUMP_RE.test(sqlText)) {
        fail('VALIDATION', `SQL dump ${item.path} contains unauthorized GRANT/SUPER/FILE/DEFINER or client execution statement`)
      }
    }
    const ref = `cpstage-${this.staged.length + 1}`
    this.staged.push({
      ref,
      item: structuredClone(item),
      sha256: hash.digest('hex'),
      bytes,
      content,
    })
    if (this.onItemStored) {
      await this.onItemStored(item, this.staged.length)
    }
    return ref
  }

  async abort(reason: Error): Promise<void> {
    this.abortedReason = reason
    this.staged.length = 0
  }
}

export class CpanelImportRunner {
  private readonly ports: CpanelImportRunnerPorts

  constructor(ports: CpanelImportRunnerPorts) {
    this.ports = ports
  }

  /**
   * Streams an untrusted cPanel archive (`cpmove-<user>.tar.gz` or `backup-<date>_<user>.tar.gz`),
   * enforces entry/byte/deadline limits, validates SQL dumps and links, allocates a fresh UID/GID
   * from the host allocator (never trusting archive UIDs), enforces `passwordResetRequired: true`
   * on all imported credentials, and provisions the account into confined staging.
   */
  async importArchive(input: {
    actor: Principal
    importId: string
    /** For display/logging only; never opened as a file path. */
    archiveDisplayName: string
    source: ByteSource
    expectedArchiveSha256?: string
    targetUsername?: string
    ipv4?: string
    limits?: {
      maxEntries?: number
      maxTotalBytes?: number
      deadlineMs?: number
    }
    dryRun?: boolean
    onStageStep?: (stepName: string) => Promise<void> | void
  }): Promise<CpanelImportReport> {
    if (input.actor.kind !== 'root' && input.actor.kind !== 'reseller') {
      fail('FORBIDDEN', 'only root or an authorized reseller may import a cPanel archive')
    }
    if (typeof input.archiveDisplayName !== 'string' || input.archiveDisplayName.trim().length === 0) {
      fail('VALIDATION', 'archiveDisplayName is required')
    }

    const maxEntries = input.limits?.maxEntries ?? DEFAULT_CPANEL_MAX_ENTRIES
    const maxTotalBytes = input.limits?.maxTotalBytes ?? DEFAULT_CPANEL_MAX_TOTAL_BYTES
    const deadlineMs = input.limits?.deadlineMs ?? DEFAULT_CPANEL_DEADLINE_MS
    const nowMs = this.ports.nowMs ?? (() => this.ports.clock.now().getTime())
    const startedMs = nowMs()

    const checkDeadline = (): void => {
      if (nowMs() - startedMs > deadlineMs) {
        fail('LIMIT_EXCEEDED', `cPanel archive import exceeded time limit of ${deadlineMs}ms`)
      }
    }

    const outerHash = createHash('sha256')
    const guardedSource: ByteSource = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of input.source) {
          checkDeadline()
          const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          outerHash.update(b)
          yield b
        }
      },
    }

    const sink = new ConfinedCpanelStagingSink(checkDeadline, async (item, count) => {
      if (input.onStageStep) await input.onStageStep(`put:${item.part}:${count}`)
    })

    const plan = await readCpanelArchive(guardedSource, {
      targetUsername: input.targetUsername,
      ipv4: input.ipv4,
      sink: input.dryRun ? undefined : sink,
      limits: { maxEntries, maxTotalBytes },
      now: this.ports.clock.now(),
    })

    const actualArchiveSha = outerHash.digest('hex')
    if (input.expectedArchiveSha256 && input.expectedArchiveSha256 !== actualArchiveSha) {
      await sink.abort(new Error('archive checksum mismatch'))
      fail('VALIDATION', `cPanel archive sha256 mismatch: expected ${input.expectedArchiveSha256}, got ${actualArchiveSha}`)
    }

    // Check local inventory conflicts BEFORE allocating UID or writing desired state
    const local = await this.ports.applyPort.getLocalInventory()
    if (local.usernames.includes(plan.account.username)) {
      await sink.abort(new Error('username conflict'))
      fail('CONFLICT', `account ${plan.account.username} already exists on this server`)
    }
    const localDomains = new Set(local.domains.map((d) => d.toLowerCase()))
    for (const d of plan.domains) {
      if (localDomains.has(d.name.toLowerCase())) {
        await sink.abort(new Error('domain conflict'))
        fail('CONFLICT', `domain ${d.name} already exists on this server`)
      }
    }

    // Allocate a fresh UID/GID from the local inventory; never reuse archive UID
    const uid = allocateUid(local.uids)
    const gid = uid
    const slice = sliceUnit(uid)
    const home = `/home/${plan.account.username}`

    // Enforce explicit passwordResetRequired across account, dbUsers, and mailboxes
    if (plan.account.passwordResetRequired !== true) {
      fail('VALIDATION', 'imported account must require an explicit password reset')
    }
    for (const u of plan.dbUsers) {
      if (u.passwordResetRequired !== true) {
        fail('VALIDATION', `imported DB user ${u.name} must require an explicit password reset`)
      }
    }
    for (const mb of plan.mailboxes) {
      if (mb.passwordResetRequired !== true) {
        fail('VALIDATION', `imported mailbox ${mb.address} must require an explicit password reset`)
      }
    }

    let cutoverReady = false
    if (!input.dryRun) {
      try {
        if (input.onStageStep) await input.onStageStep('before-apply')
        await this.ports.applyPort.provisionImportedAccount({
          importId: input.importId,
          uid,
          gid,
          slice,
          home,
          plan,
          stagedItems: sink.staged,
        })
        cutoverReady = true
      } catch (e) {
        await sink.abort(e instanceof Error ? e : new Error(String(e)))
        try {
          await this.ports.applyPort.rollbackProvisionedAccount(input.importId, plan.account.username)
        } catch (rbErr) {
          if (!isXpanelError(rbErr)) void rbErr
        }
        throw e
      }
    }

    const unsupported = plan.warnings.filter((w) => UNSUPPORTED_WARNING_CODES.has(w.code))
    const skippedItems = plan.warnings.filter((w) => SKIPPED_WARNING_CODES.has(w.code))

    const report: CpanelImportReport = {
      importId: input.importId,
      archiveDisplayName: input.archiveDisplayName,
      format: plan.format,
      sourceUsername: plan.sourceUsername,
      allocatedIdentity: {
        username: plan.account.username,
        uid,
        gid,
        slice,
        home,
        passwordResetRequired: true,
      },
      imported: {
        account: plan.account,
        domains: plan.domains,
        databases: plan.databases,
        dbUsers: plan.dbUsers,
        dnsZones: plan.dnsZones,
        mailboxes: plan.mailboxes,
        mail: plan.mail,
        certificates: plan.certificates,
        homeFiles: plan.home.files,
        homeDirectories: plan.home.directories,
        homeSymlinks: plan.home.symlinks,
        homeBytes: plan.home.bytes,
      },
      skipped: {
        homeSkippedCount: plan.home.skipped,
        items: skippedItems,
      },
      unsupported,
      warnings: plan.warnings,
      cutoverReady,
    }

    await this.ports.audit?.record(
      auditEntry(input.actor, 'cpanel.import.completed', plan.account.username, {
        importId: input.importId,
        sourceUsername: plan.sourceUsername,
        uid,
        domains: plan.domains.length,
        databases: plan.databases.length,
        mailboxes: plan.mailboxes.length,
        warnings: plan.warnings.length,
      }, 'ok', { now: this.ports.clock.now() }),
    )

    return report
  }
}
