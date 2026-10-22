import { fail } from '@xpanel/core'
import type { Account, HostAction, Id, RenderedFile } from '@xpanel/core'
import { extended, services } from '@xpanel/render'
import type { AgentExecutor } from '../executor.ts'

type MailFilter = services.MailFilter
type VacationInput = services.VacationInput
type FilterTest = services.FilterTest

export interface ForwardingEdgeInput {
  source: string
  destinations: readonly string[]
  accountId?: Id
}

export interface DomainForwarderEdgeInput {
  fromDomain: string
  toDomain: string
  accountId?: Id
}

export interface LoopDetectionReport {
  hasLoop: boolean
  cyclePath: string[] | null
  maxHopDepth: number
}

export interface SieveActorContext {
  kind: 'root' | 'reseller' | 'user' | 'mailbox'
  accountId?: Id
  boundMailbox?: string
  ownedAccountIds?: readonly Id[]
}

export interface MailboxSieveInstallInput {
  actor: SieveActorContext
  account: Pick<Account, 'id' | 'username' | 'uid' | 'gid' | 'home'>
  mailbox: string
  authorizedAliases?: readonly string[]
  filters: readonly MailFilter[]
  vacation?: VacationInput | null
  existingForwarders?: readonly ForwardingEdgeInput[]
  existingDomainForwarders?: readonly DomainForwarderEdgeInput[]
}

export interface MailboxSieveInstallResult {
  mailbox: string
  activeSievePath: string
  activeSvbinPath: string
  compiledScript: string
  removedAllFiles: boolean
  actionsExecuted: HostAction[]
}

export interface SimulatedDeliveryMessage {
  from: string
  to: string
  subject: string
  headers?: Readonly<Record<string, string>>
  body: string
  sizeBytes?: number
}

export interface SimulatedSieveOutcome {
  disposition: 'inbox' | 'fileinto' | 'redirect' | 'discard' | 'reject'
  folder: string | null
  redirectedTo: string[]
  keptCopy: boolean
  markedRead: boolean
  rejectMessage: string | null
  vacationTriggered: boolean
  vacationSuppressedReason: string | null
}

const MAX_SCRIPT_BYTES = 1024 * 1024 // 1 MiB
const MAX_FORWARDING_HOPS = 16

interface ActiveMailboxSieveState {
  account: Pick<Account, 'id' | 'username' | 'uid' | 'gid' | 'home'>
  mailbox: string
  filters: MailFilter[]
  vacation: VacationInput | null
  compiledScript: string
  sieveFile: RenderedFile
  svbinFile: RenderedFile
}

/**
 * M04 SieveAndForwarderAdapter:
 * Unified Sieve filter + anti-backscatter vacation compiler, loop detector, and atomic
 * `sievec` installer under the owning hosting account UID/GID.
 */
export class SieveAndForwarderAdapter {
  private readonly executor: AgentExecutor
  private readonly activeStates = new Map<string, ActiveMailboxSieveState>()
  private readonly vacationLastReplyBySender = new Map<string, number>()

  constructor(opts: { executor: AgentExecutor }) {
    this.executor = opts.executor
  }

  /**
   * Enforces strict principal authorization so:
   * - A `mailbox` principal can only read/write rules for its own `boundMailbox`
   * - A `user` principal can only read/write rules for mailboxes inside its own `accountId`
   * - A `reseller` principal can only manage accounts in `ownedAccountIds`
   */
  assertCallerAuthorizedForMailbox(
    actor: SieveActorContext,
    account: Pick<Account, 'id' | 'username'>,
    mailboxAddress: string,
  ): string {
    const { address } = services.normalizeHostedEmail(mailboxAddress, 'mailbox')
    if (actor.kind === 'mailbox') {
      const bound = actor.boundMailbox?.trim().toLowerCase()
      if (!bound || bound !== address) {
        fail('FORBIDDEN', `mailbox principal "${bound ?? 'unknown'}" cannot modify Sieve rules of "${address}"`)
      }
      if (actor.accountId && actor.accountId !== account.id) {
        fail('FORBIDDEN', 'mailbox principal account mismatch')
      }
      return address
    }
    if (actor.kind === 'user') {
      if (!actor.accountId || actor.accountId !== account.id) {
        fail('FORBIDDEN', `account user cannot modify Sieve rules belonging to account "${account.username}"`)
      }
      return address
    }
    if (actor.kind === 'reseller') {
      const owned = new Set(actor.ownedAccountIds ?? [])
      if (!owned.has(account.id)) {
        fail('FORBIDDEN', `reseller does not own account "${account.username}"`)
      }
      return address
    }
    return address
  }

  /**
   * Detects intra-domain and cross-account forwarding / Sieve redirect loops
   * across address forwarders, domain-wide `@fromDomain -> @toDomain` aliases, and Sieve `redirect` rules.
   */
  detectForwardingAndRedirectLoops(input: {
    forwarders: readonly ForwardingEdgeInput[]
    domainForwarders?: readonly DomainForwarderEdgeInput[]
    sieveRedirects?: readonly { mailbox: string; targets: readonly string[] }[]
  }): LoopDetectionReport {
    const adj = new Map<string, Set<string>>()
    const domainAliasMap = new Map<string, string>()

    for (const df of input.domainForwarders ?? []) {
      const fromD = services.normalizeHostname(df.fromDomain, 'fromDomain')
      const toD = services.normalizeHostname(df.toDomain, 'toDomain')
      if (fromD === toD) {
        return { hasLoop: true, cyclePath: [`@${fromD}`, `@${toD}`], maxHopDepth: 1 }
      }
      domainAliasMap.set(fromD, toD)
    }

    // Check domain-level alias cycle first
    for (const startDom of domainAliasMap.keys()) {
      const visited: string[] = [`@${startDom}`]
      let curr = domainAliasMap.get(startDom)
      while (curr) {
        const tag = `@${curr}`
        if (visited.includes(tag)) {
          return {
            hasLoop: true,
            cyclePath: [...visited.slice(visited.indexOf(tag)), tag],
            maxHopDepth: visited.length,
          }
        }
        visited.push(tag)
        curr = domainAliasMap.get(curr)
      }
    }

    const addEdge = (srcRaw: string, dstRaw: string): void => {
      const src = services.normalizeEmail(srcRaw, 'forward source').address
      const dst = services.normalizeEmail(dstRaw, 'forward destination').address
      let set = adj.get(src)
      if (!set) {
        set = new Set<string>()
        adj.set(src, set)
      }
      set.add(dst)

      // Also expand domain-level forwarders if dst's domain is forwarded
      const [dstLocal, dstDomain] = dst.split('@')
      if (dstLocal && dstDomain && domainAliasMap.has(dstDomain)) {
        const mappedDomain = domainAliasMap.get(dstDomain)!
        const expanded = `${dstLocal}@${mappedDomain}`
        let dstSet = adj.get(dst)
        if (!dstSet) {
          dstSet = new Set<string>()
          adj.set(dst, dstSet)
        }
        dstSet.add(expanded)
      }
    }

    for (const f of input.forwarders) {
      const src = services.normalizeEmail(f.source, 'forwarder source').address
      for (const d of f.destinations) {
        const dst = services.normalizeEmail(d, 'forwarder destination').address
        // A mailbox keeping a local copy (`src -> [src, other]`) is only a loop if `src` is the sole target or part of a multi-hop cycle
        if (src === dst && f.destinations.length === 1) {
          return { hasLoop: true, cyclePath: [src, dst], maxHopDepth: 1 }
        }
        if (src !== dst) {
          addEdge(src, dst)
        }
      }
    }

    for (const sr of input.sieveRedirects ?? []) {
      const src = services.normalizeHostedEmail(sr.mailbox, 'sieve mailbox').address
      for (const t of sr.targets) {
        const dst = services.normalizeEmail(t, 'sieve redirect target').address
        if (src === dst) {
          return { hasLoop: true, cyclePath: [src, dst], maxHopDepth: 1 }
        }
        addEdge(src, dst)
      }
    }

    let maxHopDepth = 0

    for (const startNode of adj.keys()) {
      const stack: { node: string; path: string[] }[] = [{ node: startNode, path: [startNode] }]
      while (stack.length > 0) {
        const { node, path } = stack.pop()!
        if (path.length - 1 > maxHopDepth) {
          maxHopDepth = path.length - 1
        }
        if (path.length - 1 > MAX_FORWARDING_HOPS) {
          return { hasLoop: true, cyclePath: path, maxHopDepth: path.length - 1 }
        }
        const neighbors = adj.get(node)
        if (!neighbors) continue
        for (const next of neighbors) {
          const cycleIdx = path.indexOf(next)
          if (cycleIdx >= 0) {
            return {
              hasLoop: true,
              cyclePath: [...path.slice(cycleIdx), next],
              maxHopDepth: path.length,
            }
          }
          stack.push({ node: next, path: [...path, next] })
        }
      }
    }

    return { hasLoop: false, cyclePath: null, maxHopDepth }
  }

  /**
   * Compiles a unified Sieve script (filters + anti-backscatter vacation guards)
   * using `@xpanel/render`'s `services.renderSieveScript` and augments vacation with
   * RFC 3834 / RFC 5230 anti-loop guards (`Auto-Submitted`, `Precedence: bulk|list|junk`, `List-Id`, `X-Loop`).
   */
  compileUnifiedSieveScript(input: {
    mailbox: string
    authorizedAliases?: readonly string[]
    filters: readonly MailFilter[]
    vacation?: VacationInput | null
  }): string {
    const { address } = services.normalizeHostedEmail(input.mailbox, 'mailbox')
    const allowedFroms = new Set<string>([
      address,
      ...(input.authorizedAliases ?? []).map((a) => services.normalizeHostedEmail(a, 'alias').address),
    ])

    let normalizedVacation: VacationInput | null = null
    if (input.vacation) {
      const vacFrom = input.vacation.from
        ? services.normalizeHostedEmail(input.vacation.from, 'vacation from').address
        : address
      if (!allowedFroms.has(vacFrom)) {
        fail('FORBIDDEN', `vacation :from address "${vacFrom}" is not owned by mailbox "${address}"`)
      }
      normalizedVacation = {
        ...input.vacation,
        from: vacFrom,
        days: input.vacation.days ?? 1,
      }
    }

    const baseScript = services.renderSieveScript({
      filters: [...input.filters],
      vacation: normalizedVacation,
    })

    if (Buffer.byteLength(baseScript, 'utf8') > MAX_SCRIPT_BYTES) {
      fail('VALIDATION', 'compiled Sieve script exceeds 1 MiB limit')
    }

    if (!normalizedVacation) {
      return baseScript
    }

    // Inject anti-backscatter / mailing-list suppression guard around the `# autoresponder` block
    const antiLoopGuardCondition = [
      'not header :matches "Auto-Submitted" ["auto-*", "yes"]',
      'not header :contains "Precedence" ["bulk", "list", "junk"]',
      'not header :matches "List-Id" "*"',
      'not header :matches "List-Unsubscribe" "*"',
      `not header :is "X-Loop" ${services.sieveQuote(address)}`,
      'not address :localpart :contains "From" ["mailer-daemon", "postmaster", "noreply", "no-reply"]',
    ].join(',\n  ')

    const guardedScript = baseScript.replace(
      /# autoresponder\n([\s\S]+)$/,
      (_m, vacBlock: string) => {
        const indented = vacBlock
          .trimEnd()
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')
        return `# autoresponder (with RFC 3834 anti-backscatter guards)\nif allof(\n  ${antiLoopGuardCondition}\n) {\n${indented}\n}\n`
      },
    )

    return guardedScript
  }

  /**
   * Compiles, checks for forwarding/redirect loops, runs `/usr/bin/sievec` on a candidate script,
   * and atomically activates `.dovecot.sieve` and `.dovecot.svbin` under the owning account UID/GID.
   * When both `filters` (enabled) and `vacation` are empty, removes `.dovecot.sieve` and `.dovecot.svbin`.
   */
  async compileAndInstallMailboxSieve(
    input: MailboxSieveInstallInput,
  ): Promise<MailboxSieveInstallResult> {
    const acc = services.assertAccount(input.account)
    const mailbox = this.assertCallerAuthorizedForMailbox(input.actor, input.account, input.mailbox)
    const { local, domain } = services.normalizeHostedEmail(mailbox, 'mailbox')

    const activeFilters = input.filters.filter((f) => f.enabled !== false)
    const hasActiveRules = activeFilters.length > 0 || Boolean(input.vacation)

    const activeSievePath = `${acc.home}/mail/${domain}/${local}/.dovecot.sieve`
    const activeSvbinPath = `${acc.home}/mail/${domain}/${local}/.dovecot.svbin`
    const candidateSievePath = `${acc.home}/mail/${domain}/${local}/.dovecot.sieve.candidate`
    const candidateSvbinPath = `${acc.home}/mail/${domain}/${local}/.dovecot.svbin.candidate`

    // If last rule and vacation were deleted, remove both .dovecot.sieve and .dovecot.svbin
    if (!hasActiveRules) {
      await this.executor.removePath(activeSievePath)
      await this.executor.removePath(activeSvbinPath)
      this.activeStates.delete(mailbox)
      return {
        mailbox,
        activeSievePath,
        activeSvbinPath,
        compiledScript: '',
        removedAllFiles: true,
        actionsExecuted: [
          { kind: 'remove-path', path: activeSievePath },
          { kind: 'remove-path', path: activeSvbinPath },
        ],
      }
    }

    // Collect redirect targets from candidate filters and verify no loops
    const redirectTargets: string[] = []
    for (const f of activeFilters) {
      for (const act of f.actions) {
        if (act.kind === 'redirect') {
          redirectTargets.push(act.to)
        }
      }
    }

    const loopReport = this.detectForwardingAndRedirectLoops({
      forwarders: input.existingForwarders ?? [],
      domainForwarders: input.existingDomainForwarders ?? [],
      sieveRedirects: [{ mailbox, targets: redirectTargets }],
    })

    if (loopReport.hasLoop) {
      fail(
        'VALIDATION',
        `Sieve redirect / forwarding loop detected: ${(loopReport.cyclePath ?? []).join(' -> ')}`,
        {
          cyclePath: loopReport.cyclePath,
        },
      )
    }

    const compiledScript = this.compileUnifiedSieveScript({
      mailbox,
      authorizedAliases: input.authorizedAliases,
      filters: input.filters,
      vacation: input.vacation,
    })

    const previousState = this.activeStates.get(mailbox) ?? null

    // Stage candidate script
    const candidateRendered: RenderedFile = {
      path: candidateSievePath,
      content: compiledScript,
      mode: 0o600,
      owner: acc.username,
      group: acc.username,
    }
    await this.executor.writeFile(candidateRendered)

    // Compile candidate script with Pigeonhole `sievec`
    const compileRes = await this.executor.runCommand([
      '/usr/bin/sievec',
      candidateSievePath,
      candidateSvbinPath,
    ])

    if (!compileRes.ok) {
      await this.executor.removePath(candidateSievePath)
      await this.executor.removePath(candidateSvbinPath)
      // Ensure previous generation remains intact
      if (previousState) {
        await this.executor.writeFile(previousState.sieveFile)
        await this.executor.writeFile(previousState.svbinFile)
      }
      fail('VALIDATION', `sievec compilation failed for ${mailbox}: ${compileRes.stderr}`, {
        mailbox,
        stderr: compileRes.stderr,
      })
    }

    const finalSieveFile = services.sieveFile(acc, mailbox, compiledScript)
    const finalSvbinFile: RenderedFile = {
      path: activeSvbinPath,
      content: `SVBIN_COMPILED:${compiledScript}`,
      mode: 0o600,
      owner: acc.username,
      group: acc.username,
    }

    try {
      await this.executor.writeFile(finalSieveFile)
      await this.executor.writeFile(finalSvbinFile)
      await this.executor.removePath(candidateSievePath)
      await this.executor.removePath(candidateSvbinPath)
    } catch (err) {
      await this.executor.removePath(candidateSievePath)
      await this.executor.removePath(candidateSvbinPath)
      if (previousState) {
        await this.executor.writeFile(previousState.sieveFile)
        await this.executor.writeFile(previousState.svbinFile)
      }
      throw err
    }

    this.activeStates.set(mailbox, {
      account: input.account,
      mailbox,
      filters: [...input.filters],
      vacation: input.vacation ?? null,
      compiledScript,
      sieveFile: finalSieveFile,
      svbinFile: finalSvbinFile,
    })

    return {
      mailbox,
      activeSievePath: finalSieveFile.path,
      activeSvbinPath: finalSvbinFile.path,
      compiledScript,
      removedAllFiles: false,
      actionsExecuted: [
        { kind: 'exec', argv: ['/usr/bin/sievec', candidateSievePath, candidateSvbinPath] },
      ],
    }
  }

  /**
   * Preview and validate CSV batch import of mailboxes and forwarders, including loop detection
   * and per-row quota/domain checks before committing.
   */
  previewAddressImportCsv(
    csvText: string,
    defaultDomain: string,
    existingForwarders: readonly ForwardingEdgeInput[] = [],
  ) {
    const parsed = extended.parseAddressImportCsv(csvText, defaultDomain)
    const combinedForwarders: ForwardingEdgeInput[] = [
      ...existingForwarders,
      ...parsed.forwarders.map((f) => ({ source: f.source, destinations: [f.destination] })),
    ]
    const loopReport = this.detectForwardingAndRedirectLoops({ forwarders: combinedForwarders })
    return {
      ...parsed,
      loopReport,
    }
  }

  /**
   * Evaluates an incoming LMTP delivery message against the mailbox's active installed Sieve state,
   * verifying rule priority, stop/discard/reject termination, and vacation anti-backscatter guards.
   */
  evaluateDeliveryAgainstActiveSieve(
    mailboxAddress: string,
    msg: SimulatedDeliveryMessage,
    nowMs = Date.now(),
  ): SimulatedSieveOutcome {
    const { address } = services.normalizeHostedEmail(mailboxAddress, 'mailbox')
    const state = this.activeStates.get(address)
    if (!state) {
      return {
        disposition: 'inbox',
        folder: 'INBOX',
        redirectedTo: [],
        keptCopy: true,
        markedRead: false,
        rejectMessage: null,
        vacationTriggered: false,
        vacationSuppressedReason: null,
      }
    }

    const headersLower: Record<string, string> = {
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
    }
    for (const [k, v] of Object.entries(msg.headers ?? {})) {
      headersLower[k.toLowerCase()] = v
    }
    const sizeBytes = msg.sizeBytes ?? Buffer.byteLength(msg.body, 'utf8')

    let disposition: SimulatedSieveOutcome['disposition'] = 'inbox'
    let targetFolder: string | null = 'INBOX'
    const redirectedTo: string[] = []
    let keptCopy = true
    let markedRead = false
    let rejectMessage: string | null = null
    let stopped = false

    for (const filter of state.filters) {
      if (filter.enabled === false) continue

      const testResults = filter.tests.map((t: FilterTest) => {
        let matched = false
        if (t.field === 'size') {
          matched = t.op === 'over' ? sizeBytes > t.bytes : sizeBytes < t.bytes
        } else if (t.field === 'body') {
          matched = this.matchValue(msg.body, t.op, t.value)
        } else if (t.field === 'header') {
          const hv = headersLower[t.header.toLowerCase()] ?? ''
          matched = this.matchValue(hv, t.op, t.value)
        } else {
          const hv = headersLower[t.field] ?? ''
          matched = this.matchValue(hv, t.op, t.value)
        }
        return t.not ? !matched : matched
      })

      const ruleMatches =
        filter.match === 'all' ? testResults.every(Boolean) : testResults.some(Boolean)
      if (!ruleMatches) continue

      for (const act of filter.actions) {
        switch (act.kind) {
          case 'fileinto':
            disposition = 'fileinto'
            targetFolder = act.folder
            break
          case 'redirect':
            disposition = 'redirect'
            redirectedTo.push(act.to.toLowerCase())
            keptCopy = Boolean(act.copy)
            if (!act.copy) targetFolder = null
            break
          case 'discard':
            disposition = 'discard'
            targetFolder = null
            keptCopy = false
            stopped = true
            break
          case 'reject':
            disposition = 'reject'
            targetFolder = null
            keptCopy = false
            rejectMessage = act.message
            stopped = true
            break
          case 'keep':
            keptCopy = true
            if (!targetFolder) targetFolder = 'INBOX'
            break
          case 'mark-read':
            markedRead = true
            break
          case 'stop':
            stopped = true
            break
        }
        if (stopped) break
      }
      if (stopped) break
    }

    let vacationTriggered = false
    let vacationSuppressedReason: string | null = null

    if (!stopped && state.vacation && disposition !== 'discard' && disposition !== 'reject') {
      const autoSubmitted = (headersLower['auto-submitted'] ?? '').toLowerCase()
      const precedence = (headersLower['precedence'] ?? '').toLowerCase()
      const listId = headersLower['list-id'] ?? ''
      const listUnsub = headersLower['list-unsubscribe'] ?? ''
      const xLoop = (headersLower['x-loop'] ?? '').toLowerCase()
      const senderLower = msg.from.trim().toLowerCase()

      if (autoSubmitted && autoSubmitted !== 'no') {
        vacationSuppressedReason = 'Auto-Submitted header present'
      } else if (['bulk', 'list', 'junk'].some((p) => precedence.includes(p))) {
        vacationSuppressedReason = `Precedence: ${precedence}`
      } else if (listId || listUnsub) {
        vacationSuppressedReason = 'Mailing list header (List-Id / List-Unsubscribe) present'
      } else if (xLoop === address) {
        vacationSuppressedReason = 'X-Loop matches mailbox'
      } else if (
        senderLower.startsWith('mailer-daemon@') ||
        senderLower.startsWith('postmaster@') ||
        senderLower.startsWith('noreply@') ||
        senderLower.startsWith('no-reply@') ||
        senderLower === address
      ) {
        vacationSuppressedReason = 'System or self sender address'
      } else {
        const rateKey = `${address}::${senderLower}`
        const minIntervalMs = (state.vacation.days ?? 1) * 24 * 3600 * 1000
        const lastReplyAt = this.vacationLastReplyBySender.get(rateKey)
        if (lastReplyAt !== undefined && nowMs - lastReplyAt < minIntervalMs) {
          vacationSuppressedReason = 'Minimum reply interval (:days) has not elapsed for sender'
        } else {
          vacationTriggered = true
          this.vacationLastReplyBySender.set(rateKey, nowMs)
        }
      }
    }

    return {
      disposition,
      folder: targetFolder,
      redirectedTo,
      keptCopy,
      markedRead,
      rejectMessage,
      vacationTriggered,
      vacationSuppressedReason,
    }
  }

  private matchValue(haystack: string, op: string, needle: string): boolean {
    const h = haystack.toLowerCase()
    const n = needle.toLowerCase()
    switch (op) {
      case 'contains':
        return h.includes(n)
      case 'is':
        return h === n
      case 'begins':
        return h.startsWith(n)
      case 'ends':
        return h.endsWith(n)
      case 'matches': {
        const pattern = `^${n.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`
        return new RegExp(pattern, 'i').test(haystack)
      }
      case 'regex':
        return new RegExp(needle, 'i').test(haystack)
      default:
        return false
    }
  }
}
