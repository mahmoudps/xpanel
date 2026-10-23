import { fail, isUnlimited, suspensionEffects } from '@xpanel/core'
import type {
  Account,
  ConfigTest,
  HostAction,
  Limit,
  OsProfile,
  RenderedFile,
} from '@xpanel/core'
import { services } from '@xpanel/render'
import type { AgentExecutor, ConfigTestResult } from '../executor.ts'

type DefaultAddress = services.DefaultAddress
type ForwarderInput = services.ForwarderInput
type MailDomainInput = services.MailDomainInput
type MailboxInput = services.MailboxInput
type PostfixMapType = services.PostfixMapType

export interface ManagedMailboxSpec {
  local: string
  domain: string
  passwordHash: string
  quotaMb: Limit
  suspendLogin?: boolean
  suspendIncoming?: boolean
  suspendOutgoing?: boolean
}

export interface ManagedMailDomainSpec {
  domain: string
  account: Pick<Account, 'id' | 'username' | 'uid' | 'gid' | 'home' | 'status'>
  mailboxes: ManagedMailboxSpec[]
  forwarders?: ForwarderInput[]
  defaultAddress?: DefaultAddress
  login?: 'allowed' | 'denied'
  delivery?: 'accept' | 'defer'
}

export interface MailProvisionPlan {
  files: RenderedFile[]
  preActions: HostAction[]
  postActions: HostAction[]
  tests: ConfigTest[]
  maildirPaths: string[]
}

export interface MailboxQuotaDiagnostic {
  mailbox: string
  accountUsername: string
  uid: number
  mailboxQuotaMb: Limit
  accountDiskQuotaMb: Limit
  usedMailboxBytes: number
  usedAccountBytes: number
  limitingLayer: 'none' | 'mailbox_dovecot_quota' | 'account_filesystem_quota'
  lmtpStatus: '250 2.0.0 Ok' | '552 5.2.2 Quota exceeded (mailbox full)' | '452 4.2.2 Account filesystem quota exceeded (EDQUOT)'
}

export interface MailServiceAdapterOptions {
  executor: AgentExecutor
  os: OsProfile
  mapType?: PostfixMapType
  postmasterAddress?: string
  tls?: { certFile: string; keyFile: string }
  messageSizeLimitMb?: number
}

const STANDARD_MAILDIR_SUBDIRS = [
  'cur',
  'new',
  'tmp',
  '.Sent/cur',
  '.Sent/new',
  '.Sent/tmp',
  '.Drafts/cur',
  '.Drafts/new',
  '.Drafts/tmp',
  '.Junk/cur',
  '.Junk/new',
  '.Junk/tmp',
  '.Trash/cur',
  '.Trash/new',
  '.Trash/tmp',
  '.Spam/cur',
  '.Spam/new',
  '.Spam/tmp',
  '.Archive/cur',
  '.Archive/new',
  '.Archive/tmp',
] as const

const normalizeAddress = (local: string, domain: string): string => {
  const normLocal = services.normalizeMailboxLocal(local, 'mailbox local part')
  const normDomain = services.normalizeHostname(domain, 'mail domain')
  return `${normLocal}@${normDomain}`
}

/**
 * M01 MailServiceAdapter:
 * Coordinates Postfix virtual domains/mailboxes/aliases/sender_logins/recipient_access/sender_access
 * lookup tables (`postmap`), Dovecot per-domain passwd-files with verified `{ARGON2ID}` / `{BLF-CRYPT}` /
 * `{SHA512-CRYPT}` password hashes and `userdb_quota_rule=*:storage=<M>M`, Maildir provisioning under
 * the hosting account's UID/GID (`0750`), granular incoming/outgoing/login suspension, and immediate
 * map rebuild + Dovecot auth cache flush on mailbox deletion or password rotation.
 */
export interface MaildirSnapshot {
  accounts: readonly { id: string; home: string }[]
  domains: readonly { id: string; name: string }[]
  serviceUsers: readonly { accountId: string; domainId: string; localPart: string; services: { email: boolean } }[]
}

const maildirPaths = (snapshot: MaildirSnapshot): Set<string> => {
  const accounts = new Map(snapshot.accounts.map(account => [account.id, account.home]))
  const domains = new Map(snapshot.domains.map(domain => [domain.id, domain.name]))
  const paths = new Set<string>()
  for (const user of snapshot.serviceUsers) {
    if (!user.services.email) continue
    const home = accounts.get(user.accountId)
    const domain = domains.get(user.domainId)
    if (!home || !domain || !user.localPart) continue
    paths.add(`${home}/mail/${domain}/${user.localPart}`)
  }
  return paths
}

/** Maildir roots present in the applied generation and absent from the desired generation. */
export const removedMaildirPaths = (previous: MaildirSnapshot, next: MaildirSnapshot): string[] => {
  const kept = maildirPaths(next)
  return [...maildirPaths(previous)].filter(path => !kept.has(path)).sort()
}

export class MailServiceAdapter {
  private readonly executor: AgentExecutor
  private readonly os: OsProfile
  private readonly mapType: PostfixMapType
  private readonly postmasterAddress: string
  private readonly tls?: { certFile: string; keyFile: string }
  private readonly messageSizeLimitMb: number
  private readonly activeMailboxesByDomain = new Map<string, Map<string, ManagedMailboxSpec>>()

  constructor(options: MailServiceAdapterOptions) {
    this.executor = options.executor
    this.os = options.os
    this.mapType = options.mapType ?? 'texthash'
    this.postmasterAddress = options.postmasterAddress ?? 'postmaster@localhost.localdomain'
    this.tls = options.tls
    this.messageSizeLimitMb = options.messageSizeLimitMb ?? 50
  }

  /**
   * Builds the Maildir directory hierarchy actions under the owning account's UID/GID (`0750`).
   * Delivery runs as the account's UID/GID so filesystem quota and cgroup slice accounting apply.
   */
  buildMaildirActions(
    account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>,
    domain: string,
    local: string,
  ): { rootDir: string; actions: HostAction[] } {
    const acc = services.assertAccount(account)
    const normDomain = services.normalizeHostname(domain, 'mail domain')
    const normLocal = services.normalizeMailboxLocal(local, 'mailbox local')
    const mailRoot = `${acc.home}/mail`
    const domainDir = `${mailRoot}/${normDomain}`
    const boxDir = `${domainDir}/${normLocal}`

    const actions: HostAction[] = [
      { kind: 'ensure-dir', path: mailRoot, mode: 0o750, owner: acc.username, group: acc.username },
      { kind: 'ensure-dir', path: domainDir, mode: 0o750, owner: acc.username, group: acc.username },
      { kind: 'ensure-dir', path: boxDir, mode: 0o750, owner: acc.username, group: acc.username },
    ]

    for (const sub of STANDARD_MAILDIR_SUBDIRS) {
      const parts = sub.split('/')
      if (parts.length === 2 && sub.endsWith('/cur')) {
        actions.push({
          kind: 'ensure-dir',
          path: `${boxDir}/${parts[0]}`,
          mode: 0o750,
          owner: acc.username,
          group: acc.username,
        })
      }
      actions.push({
        kind: 'ensure-dir',
        path: `${boxDir}/${sub}`,
        mode: 0o750,
        owner: acc.username,
        group: acc.username,
      })
    }

    return { rootDir: boxDir, actions }
  }

  /**
   * Compiles the complete Postfix + Dovecot configuration files, Maildir structure,
   * sender/recipient suspension access maps, `postmap` compilation commands, and config tests.
   */
  compileProvisionPlan(domains: readonly ManagedMailDomainSpec[]): MailProvisionPlan {
    const files: RenderedFile[] = []
    const preActions: HostAction[] = []
    const postActions: HostAction[] = []
    const maildirPaths: string[] = []

    const dovecotDomainsDir = services.dovecotDomainsDir(this.os)
    preActions.push({
      kind: 'ensure-dir',
      path: dovecotDomainsDir,
      mode: 0o750,
      owner: 'root',
      group: 'dovecot',
    })

    // Base Dovecot auth & xPanel LMTP/quota/sieve configuration
    files.push(services.renderDovecotAuthConf(this.os))
    files.push(
      services.renderDovecotXpanelConf(this.os, {
        postmaster: this.postmasterAddress,
        tls: this.tls,
      }),
    )
    files.push(services.renderQuotaWarningScript({ from: this.postmasterAddress }))

    const renderDomainInputs: MailDomainInput[] = []
    const outgoingSuspended = new Map<string, string>()

    for (const domSpec of domains) {
      const acc = services.assertAccount(domSpec.account)
      const normDomain = services.normalizeHostname(domSpec.domain, 'mail domain')

      const accountEffects =
        domSpec.account.status === 'active'
          ? []
          : suspensionEffects({ status: domSpec.account.status, uid: domSpec.account.uid })
      const accountDeniedLogin = accountEffects.some(
        (e) => e.subsystem === 'mail-login' && e.state === 'denied',
      )
      const accountDeferDelivery = accountEffects.some(
        (e) => e.subsystem === 'mail-delivery' && e.state === 'defer',
      )

      const effectiveLogin: 'allowed' | 'denied' =
        domSpec.login === 'denied' || accountDeniedLogin ? 'denied' : 'allowed'
      const effectiveDelivery: 'accept' | 'defer' =
        domSpec.delivery === 'defer' || accountDeferDelivery ? 'defer' : 'accept'

      const mailboxInputs: MailboxInput[] = []
      for (const mbx of domSpec.mailboxes) {
        const normLocal = services.normalizeMailboxLocal(mbx.local, 'mailbox local')
        const verifiedHash = services.assertDovecotHash(mbx.passwordHash)
        const address = `${normLocal}@${normDomain}`

        const maildir = this.buildMaildirActions(acc, normDomain, normLocal)
        maildirPaths.push(maildir.rootDir)
        preActions.push(...maildir.actions)

        if (mbx.suspendOutgoing || effectiveLogin === 'denied') {
          outgoingSuspended.set(
            address,
            'REJECT 5.7.1 Outbound mail submission is suspended for this mailbox',
          )
        }

        mailboxInputs.push({
          local: normLocal,
          passwordHash: verifiedHash,
          quotaMb: mbx.quotaMb,
          suspendLogin: Boolean(mbx.suspendLogin) || effectiveLogin === 'denied',
          suspendIncoming: Boolean(mbx.suspendIncoming),
        })
      }

      const domainInput: MailDomainInput = {
        domain: normDomain,
        account: acc,
        mailboxes: mailboxInputs,
        forwarders: domSpec.forwarders,
        defaultAddress: domSpec.defaultAddress,
        login: effectiveLogin,
        delivery: effectiveDelivery,
      }

      renderDomainInputs.push(domainInput)
      files.push(services.dovecotPasswdFile(this.os, domainInput))
    }

    const postfixMaps = services.renderPostfixMaps(this.os, renderDomainInputs, {
      mapType: this.mapType,
    })

    // Enforce outgoing suspension in sender_logins and sender_access
    const mapPaths = services.postfixMapPaths(this.os)
    const senderAccessPath = `${mapPaths.dir}/sender_access`
    const senderAccessLines = [...outgoingSuspended.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([addr, rule]) => `${addr}\t${rule}\n`)
      .join('')

    const adjustedMapFiles = postfixMaps.files.map((f) => {
      if (f.path === mapPaths.senders && outgoingSuspended.size > 0) {
        const filteredLines = f.content
          .split('\n')
          .map((line) => {
            if (!line || line.startsWith('#')) return line
            const [key] = line.split('\t')
            if (key && outgoingSuspended.has(key)) {
              return `${key}\t${services.NO_SENDER}`
            }
            return line
          })
          .join('\n')
        return { ...f, content: filteredLines }
      }
      return f
    })

    adjustedMapFiles.push({
      path: senderAccessPath,
      content: `# managed by xPanel: suspended outbound senders\n${senderAccessLines}`,
      mode: 0o640,
      owner: 'root',
      group: 'postfix',
    })

    files.push(...adjustedMapFiles)

    // Postfix main.cf and master.cf fragments (rendered as atomic files to avoid unsafe shell/argv characters)
    const mainSettings = services.postfixMainSettings(this.os, {
      mapType: this.mapType,
      tls: this.tls,
      messageSizeLimitMb: this.messageSizeLimitMb,
    })
    mainSettings.smtpd_sender_restrictions = `check_sender_access ${this.mapType}:${senderAccessPath}, reject_authenticated_sender_login_mismatch`
    files.push(
      {
        path: `${this.os.paths.postfixDir}/xpanel_main.cf`,
        content: services.renderPostfixMainFragment(mainSettings),
        mode: 0o644,
        owner: 'root',
        group: 'root',
      },
      {
        path: `${this.os.paths.postfixDir}/xpanel_master.cf`,
        content: [
          '# managed by xPanel — submission (587) & submissions (465)',
          '587 inet n - y - - smtpd -o syslog_name=postfix/submission -o smtpd_tls_security_level=encrypt -o smtpd_sasl_auth_enable=yes -o smtpd_tls_auth_only=yes',
          '465 inet n - y - - smtpd -o syslog_name=postfix/smtps -o smtpd_tls_wrappermode=yes -o smtpd_sasl_auth_enable=yes -o smtpd_tls_auth_only=yes',
          '',
        ].join('\n'),
        mode: 0o644,
        owner: 'root',
        group: 'root',
      },
    )

    const ensureMapDir = postfixMaps.actions.find((a) => a.kind === 'ensure-dir')
    if (ensureMapDir) preActions.push(ensureMapDir)

    if (this.mapType !== 'texthash') {
      for (const f of adjustedMapFiles) {
        postActions.push({
          kind: 'exec',
          argv: ['/usr/sbin/postmap', `${this.mapType}:${f.path}`],
        })
      }
    }

    postActions.push(
      { kind: 'systemd', verb: 'reload', unit: this.os.services.dovecot },
      { kind: 'systemd', verb: 'reload', unit: this.os.services.postfix },
    )

    const tests: ConfigTest[] = services.mailConfigTests(this.os).map((t) => ({
      name: t.name,
      argv: t.argv[0]?.startsWith('/')
        ? [...t.argv]
        : [`/usr/sbin/${t.argv[0]}`, ...t.argv.slice(1)],
    }))

    return {
      files,
      preActions,
      postActions,
      tests,
      maildirPaths,
    }
  }

  /**
   * Executes the provision plan against the host executor:
   * 1. Runs preActions (ensures directories & Maildirs with 0750 account ownership)
   * 2. Writes candidate files
   * 3. Runs `postfix check` and `doveconf -n` config tests
   * 4. Runs postActions (`postconf`, `postmap`, service reloads)
   */
  async applyProvisionPlan(domains: readonly ManagedMailDomainSpec[]): Promise<MailProvisionPlan> {
    const plan = this.compileProvisionPlan(domains)
    await this.executor.preflight({
      files: plan.files,
      preActions: plan.preActions,
      postActions: plan.postActions,
    })

    for (const action of plan.preActions) {
      await this.executor.runAction(action)
    }
    for (const file of plan.files) {
      await this.executor.writeFile(file)
    }
    for (const test of plan.tests) {
      const res = await this.executor.runTest(test)
      if (!res.ok) {
        fail('PRECONDITION_FAILED', `mail configuration test "${test.name}" failed: ${res.stderr}`, {
          test: test.name,
          code: res.code,
          stderr: res.stderr,
        })
      }
    }
    for (const action of plan.postActions) {
      await this.executor.runAction(action)
    }

    // Update tracked state
    this.activeMailboxesByDomain.clear()
    for (const d of domains) {
      const normDomain = services.normalizeHostname(d.domain, 'mail domain')
      const boxMap = new Map<string, ManagedMailboxSpec>()
      for (const m of d.mailboxes) {
        const addr = normalizeAddress(m.local, normDomain)
        boxMap.set(addr, { ...m, local: m.local.toLowerCase(), domain: normDomain })
      }
      this.activeMailboxesByDomain.set(normDomain, boxMap)
    }

    return plan
  }

  /**
   * Flushes Dovecot's authentication cache and kicks active IMAP/POP/LMTP sessions
   * for a specific mailbox (or all mailboxes when omitted) after password change,
   * login suspension, or mailbox deletion.
   */
  async flushDovecotAuthAndKick(mailboxAddress?: string): Promise<ConfigTestResult[]> {
    const results: ConfigTestResult[] = []
    if (mailboxAddress) {
      const { address } = services.normalizeHostedEmail(mailboxAddress, 'mailbox address')
      results.push(
        await this.executor.runCommand(['/usr/bin/doveadm', 'auth', 'cache', 'flush', address]),
      )
      results.push(await this.executor.runCommand(['/usr/bin/doveadm', 'kick', address]))
    } else {
      results.push(await this.executor.runCommand(['/usr/bin/doveadm', 'auth', 'cache', 'flush']))
    }
    return results
  }

  /**
   * Rotates a mailbox password with immediate Dovecot passwd-file update and auth cache flush
   * so the old password is immediately rejected.
   */
  async rotateMailboxPassword(
    domains: readonly ManagedMailDomainSpec[],
    mailboxAddress: string,
    newPasswordHash: string,
  ): Promise<{ updatedAddress: string; plan: MailProvisionPlan }> {
    const { local, domain, address } = services.normalizeHostedEmail(mailboxAddress, 'mailbox')
    const verifiedHash = services.assertDovecotHash(newPasswordHash)
    let found = false

    const updatedDomains = domains.map((d) => {
      if (services.normalizeHostname(d.domain, 'mail domain') !== domain) return d
      return {
        ...d,
        mailboxes: d.mailboxes.map((m) => {
          if (services.normalizeMailboxLocal(m.local, 'mailbox') !== local) return m
          found = true
          return { ...m, passwordHash: verifiedHash }
        }),
      }
    })

    if (!found) {
      fail('NOT_FOUND', `mailbox ${address} not found in managed domains`)
    }

    const plan = await this.applyProvisionPlan(updatedDomains)
    await this.flushDovecotAuthAndKick(address)
    return { updatedAddress: address, plan }
  }

  /**
   * Deletes a mailbox from the domain's Dovecot passwd-file and Postfix virtual maps,
   * flushes Dovecot auth cache, kicks active sessions, and optionally purges the Maildir.
   */
  async deleteMailbox(
    domains: readonly ManagedMailDomainSpec[],
    mailboxAddress: string,
    opts: { purgeMaildir?: boolean } = {},
  ): Promise<{ deletedAddress: string; removedMaildirPath: string | null; plan: MailProvisionPlan }> {
    const { local, domain, address } = services.normalizeHostedEmail(mailboxAddress, 'mailbox')
    const matchedDomain = domains.find(
      (d) => services.normalizeHostname(d.domain, 'mail domain') === domain,
    )
    let found = false

    const updatedDomains = domains.map((d) => {
      if (services.normalizeHostname(d.domain, 'mail domain') !== domain) return d
      const remaining = d.mailboxes.filter((m) => {
        const isMatch = services.normalizeMailboxLocal(m.local, 'mailbox') === local
        if (isMatch) found = true
        return !isMatch
      })
      return { ...d, mailboxes: remaining }
    })

    if (!found || !matchedDomain) {
      return fail('NOT_FOUND', `mailbox ${address} not found`)
    }

    const plan = await this.applyProvisionPlan(updatedDomains)
    await this.flushDovecotAuthAndKick(address)

    let removedMaildirPath: string | null = null
    // Deletion removes the Maildir. Callers pass purgeMaildir: false only when a retention policy keeps it.
    if (opts.purgeMaildir !== false) {
      const acc = services.assertAccount(matchedDomain.account)
      removedMaildirPath = `${acc.home}/mail/${domain}/${local}`
      await this.executor.runAction({ kind: 'remove-path', path: removedMaildirPath })
    }

    return { deletedAddress: address, removedMaildirPath, plan }
  }

  /**
   * Evaluates mailbox vs. account filesystem quota to determine whether LMTP delivery
   * will succeed or reject/defer due to Dovecot mailbox quota vs. Linux filesystem quota (EDQUOT).
   */
  diagnoseDeliveryQuota(input: {
    mailbox: string
    account: Pick<Account, 'username' | 'uid'>
    mailboxQuotaMb: Limit
    accountDiskQuotaMb: Limit
    usedMailboxBytes: number
    usedAccountBytes: number
    incomingMessageBytes: number
  }): MailboxQuotaDiagnostic {
    const { address } = services.normalizeHostedEmail(input.mailbox, 'mailbox')
    const acc = services.assertUsername(input.account.username)
    const uid = services.assertAccountId('uid', input.account.uid)

    const nextMailboxBytes = input.usedMailboxBytes + input.incomingMessageBytes
    const nextAccountBytes = input.usedAccountBytes + input.incomingMessageBytes

    const accountLimitBytes = isUnlimited(input.accountDiskQuotaMb)
      ? Number.POSITIVE_INFINITY
      : input.accountDiskQuotaMb * 1024 * 1024
    const mailboxLimitBytes = isUnlimited(input.mailboxQuotaMb)
      ? Number.POSITIVE_INFINITY
      : input.mailboxQuotaMb * 1024 * 1024

    if (nextAccountBytes > accountLimitBytes) {
      return {
        mailbox: address,
        accountUsername: acc,
        uid,
        mailboxQuotaMb: input.mailboxQuotaMb,
        accountDiskQuotaMb: input.accountDiskQuotaMb,
        usedMailboxBytes: input.usedMailboxBytes,
        usedAccountBytes: input.usedAccountBytes,
        limitingLayer: 'account_filesystem_quota',
        lmtpStatus: '452 4.2.2 Account filesystem quota exceeded (EDQUOT)',
      }
    }

    if (nextMailboxBytes > mailboxLimitBytes) {
      return {
        mailbox: address,
        accountUsername: acc,
        uid,
        mailboxQuotaMb: input.mailboxQuotaMb,
        accountDiskQuotaMb: input.accountDiskQuotaMb,
        usedMailboxBytes: input.usedMailboxBytes,
        usedAccountBytes: input.usedAccountBytes,
        limitingLayer: 'mailbox_dovecot_quota',
        lmtpStatus: '552 5.2.2 Quota exceeded (mailbox full)',
      }
    }

    return {
      mailbox: address,
      accountUsername: acc,
      uid,
      mailboxQuotaMb: input.mailboxQuotaMb,
      accountDiskQuotaMb: input.accountDiskQuotaMb,
      usedMailboxBytes: input.usedMailboxBytes,
      usedAccountBytes: input.usedAccountBytes,
      limitingLayer: 'none',
      lmtpStatus: '250 2.0.0 Ok',
    }
  }
}
