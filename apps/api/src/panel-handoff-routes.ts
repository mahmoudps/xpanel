import { fail, isUuid, isXpanelError } from '@xpanel/core'
import type { Account, AuditEntry, Id } from '@xpanel/core'
import {
  consumePanelHandoff,
  createAuthenticatedSession,
  findPrincipalByUsername,
  getPrincipal,
  issuePanelHandoff,
  type Db,
  type PanelHandoffAudience,
  type PanelHandoffRecord,
} from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { formatSessionCookie, type AuthenticatedCaller, type TeamMemberResolver } from './auth.ts'
import { assertAccountAuthorized, assertAccountPlanFeatures, isMailboxPrincipal } from './authorization.ts'
import { sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { HANDOFF_FORM_MAX_BYTES, HANDOFF_SESSION_TTL_MS, handoffLandingPath, handoffTokenHash, newHandoffToken, parseHandoffForm, parseHandoffLanding } from './panel-handoff-protocol.ts'
import { establishHandoffMailboxSession, normalizeMailbox } from './mail/inbox.ts'
import { handoffAuthority } from './panel-handoff-authority.ts'

type AuditInput = {
  actor: string
  action: string
  target: string
  detail?: Record<string, unknown>
  outcome: 'ok' | 'denied' | 'failed'
  principalId?: Id | null
  ip?: string | null
}

export interface HandoffRouteDeps {
  db: Db
  store: StateStore
  entryPoint?: EntryPoint
  /** Exact HTTPS origin of the one panel this listener may open (xWHM: xPanel, xPanel: xMail). Server configuration only. */
  targetOrigin?: string
  /** Exact HTTPS origin whose handoffs this listener consumes (xPanel: xWHM, xMail: xPanel). Server configuration only. */
  issuerOrigin?: string
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  emitAudit: (input: AuditInput, scope?: { accountId: Id | null; resellerId: Id | null }) => Promise<AuditEntry>
  clientIp: (req: Request) => string
  secureCookies: (req: Request) => boolean
  teamMember: TeamMemberResolver
}

const PRIVATE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } as const

const readJsonObject = async (req: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
  let body: unknown
  try { body = await req.json() } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) {
    return fail('VALIDATION', `only ${keys.join(' and ')} may be supplied`, { stateChanged: false })
  }
  return body as Record<string, unknown>
}

const readBoundedText = async (req: Request, limit: number): Promise<string | null> => {
  if (!req.body) return ''
  const reader = req.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) { await reader.cancel(); return null }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { return null }
}

/** Only a completed, first-hand interactive session may hand a panel to another person's identity. */
const assertFirstHandSession = (caller: AuthenticatedCaller): void => {
  if (caller.sessionId === null || caller.apiTokenId !== null || !caller.mfaVerified) {
    fail('FORBIDDEN', 'an interactive signed-in session is required', { stateChanged: false })
  }
  if (caller.impersonator) fail('FORBIDDEN', 'an impersonated session cannot open another panel', { stateChanged: false })
}

const sameSession = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean =>
  a.principal.id === b.principal.id && a.principal.kind === b.principal.kind && a.sessionId === b.sessionId && a.team?.id === b.team?.id

const activeAccount = async (store: StateStore, accountId: Id): Promise<Account | null> => {
  const account = await store.getAccount(accountId)
  return account && account.status === 'active' ? account : null
}

export function createHandoffRoutes(deps: HandoffRouteDeps) {
  const grant = (audience: PanelHandoffAudience, record: PanelHandoffRecord, token: string): Response =>
    Response.json({ action: `${deps.targetOrigin}/login/handoff`, token, expiresAt: record.expiresAt, audience }, { status: 201, headers: PRIVATE_HEADERS })

  /** Re-reads the same session right before the write, so a revocation during the checks wins. */
  const freshCaller = async (req: Request, initial: AuthenticatedCaller): Promise<void> => {
    const fresh = await deps.requireCaller(req)
    if (!sameSession(initial, fresh)) fail('FORBIDDEN', 'session authorization changed', { stateChanged: false })
  }

  const issueXpanel = async (req: Request): Promise<Response> => {
    const caller = await deps.requireCaller(req)
    assertFirstHandSession(caller)
    if (caller.principal.kind !== 'root' && caller.principal.kind !== 'reseller') return fail('FORBIDDEN', 'a server administrator or reseller is required', { stateChanged: false })
    const body = await readJsonObject(req, ['accountId'])
    if (!isUuid(body.accountId)) return fail('VALIDATION', 'accountId must be an account id', { stateChanged: false })
    const account = await deps.store.getAccount(body.accountId)
    if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
    await assertAccountAuthorized(deps.store, caller, account, 'handoff.issue', false)
    if (account.status !== 'active') return fail('CONFLICT', 'the account is not active', { stateChanged: false, accountStatus: account.status })
    const owner = await findPrincipalByUsername(deps.db, account.username)
    if (!owner || owner.kind !== 'user' || owner.accountId !== account.id || owner.disabled) return fail('PRECONDITION_FAILED', 'the account owner sign-in is unavailable', { stateChanged: false })
    if (owner.forcePasswordChange) return fail('PRECONDITION_FAILED', 'the account owner must change the password first', { stateChanged: false })
    if (!deps.targetOrigin) return fail('SERVICE_UNAVAILABLE', 'the xPanel address is not configured', { stateChanged: false })
    await freshCaller(req, caller)
    if (!await activeAccount(deps.store, account.id)) return fail('CONFLICT', 'the account is not active', { stateChanged: false })
    const token = newHandoffToken()
    const record = await issuePanelHandoff(deps.db, {
      tokenHash: handoffTokenHash(token), audience: 'xpanel', landing: 'home',
      target: { kind: 'account-owner', accountId: account.id, principalId: owner.id },
      issuer: { principalId: caller.principal.id, entryPoint: 'xwhm', login: caller.principal.username },
    })
    await deps.emitAudit({
      actor: caller.principal.username, action: 'handoff.issued', target: `account:${account.username}`, outcome: 'ok', principalId: caller.principal.id, ip: deps.clientIp(req),
      detail: { audience: 'xpanel', targetKind: 'account-owner', targetPrincipalId: owner.id, accountId: account.id, expiresAt: record.expiresAt },
    }, { accountId: account.id, resellerId: account.ownerId })
    return grant('xpanel', record, token)
  }

  const issueXmail = async (req: Request): Promise<Response> => {
    const caller = await deps.requireCaller(req)
    assertFirstHandSession(caller)
    if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'the hosting account owner or a team member with email access is required', { stateChanged: false })
    const body = await readJsonObject(req, ['mailbox', 'landing'])
    if (typeof body.mailbox !== 'string' || body.mailbox.length > 254) return fail('VALIDATION', 'mailbox must be an email address', { stateChanged: false })
    const mailbox = normalizeMailbox(body.mailbox)
    const landing = parseHandoffLanding(body.landing)
    const account = await activeAccount(deps.store, caller.principal.accountId)
    if (!account) return fail('FORBIDDEN', 'the hosting account is suspended or terminating', { stateChanged: false })
    await assertAccountAuthorized(deps.store, caller, account, 'handoff.issue')
    await assertAccountPlanFeatures(deps.store, account, ['email-accounts'])
    const serviceUser = await deps.store.getServiceUserByLogin(mailbox)
    if (!serviceUser || serviceUser.accountId !== account.id || !serviceUser.services.email || serviceUser.login.toLowerCase() !== mailbox) {
      return fail('NOT_FOUND', 'mailbox not found', { stateChanged: false })
    }
    if (!deps.targetOrigin) return fail('SERVICE_UNAVAILABLE', 'the xMail address is not configured', { stateChanged: false })
    await freshCaller(req, caller)
    const issuerLogin = caller.team?.login ?? caller.principal.username
    const token = newHandoffToken()
    const record = await issuePanelHandoff(deps.db, {
      tokenHash: handoffTokenHash(token), audience: 'xmail', landing,
      target: { kind: 'mailbox', accountId: account.id, serviceUserId: serviceUser.id, mailbox },
      issuer: { principalId: caller.principal.id, entryPoint: 'xpanel', login: issuerLogin, ...(caller.team ? { teamMemberId: caller.team.id } : {}) },
    })
    await deps.emitAudit({
      actor: issuerLogin, action: 'handoff.issued', target: `mailbox:${mailbox}`, outcome: 'ok', principalId: caller.principal.id, ip: deps.clientIp(req),
      detail: { audience: 'xmail', targetKind: 'mailbox', serviceUserId: serviceUser.id, accountId: account.id, landing, expiresAt: record.expiresAt, ...(caller.team ? { teamMemberId: caller.team.id } : {}) },
    }, { accountId: account.id, resellerId: null })
    return grant('xmail', record, token)
  }

  const consume = async (req: Request, audience: PanelHandoffAudience): Promise<Response> => {
    const ip = deps.clientIp(req)
    const refuse = async (reason: string, record?: PanelHandoffRecord): Promise<Response> => {
      await deps.emitAudit({
        actor: 'anonymous', action: 'handoff.refused', target: `handoff:${audience}`, outcome: 'denied', ip,
        detail: { reason, ...(record ? { issuerPrincipalId: record.issuer.principalId, accountId: record.target.accountId } : {}) },
      })
      // One generic outcome for every failure; the reason stays in the audit trail.
      return new Response(null, { status: 303, headers: { ...PRIVATE_HEADERS, location: '/login?handoff=failed' } })
    }
    if (!deps.issuerOrigin || req.headers.get('origin') !== deps.issuerOrigin) return refuse('origin')
    const text = await readBoundedText(req, HANDOFF_FORM_MAX_BYTES)
    const token = text === null ? null : parseHandoffForm(req.headers.get('content-type'), text)
    if (!token) return refuse('malformed')
    const consumed = await consumePanelHandoff(deps.db, handoffTokenHash(token), audience)
    if ('refused' in consumed) return refuse(consumed.refused)
    const { record } = consumed
    // Both identities are read again at consumption (and on every later request): a revocation after issuance wins.
    const authority = await handoffAuthority(deps, record.issuer, record.target).catch(() => 'unavailable' as const)
    if (authority !== 'ok') return refuse(authority, record)
    const impersonator = { principalId: record.issuer.principalId, login: record.issuer.login, ...(record.issuer.teamMemberId ? { teamMemberId: record.issuer.teamMemberId } : {}) }
    const userAgent = req.headers.get('user-agent') ?? 'xpanel-client'
    let rawToken: string, sessionId: Id, targetPrincipalId: Id, targetLabel: string
    if (record.target.kind === 'account-owner') {
      const owner = await getPrincipal(deps.db, record.target.principalId)
      if (!owner) return refuse('target', record)
      rawToken = newHandoffToken()
      const session = await createAuthenticatedSession(deps.db, {
        principalId: owner.id, tokenHash: sessionTokenHash(rawToken, audience), expiresAt: new Date(Date.now() + HANDOFF_SESSION_TTL_MS).toISOString(),
        ip, userAgent, mfaVerified: true, impersonator,
        expectedPasswordHash: owner.passwordHash, expectedTotpEnabled: owner.totpEnabled, expectedSealedSecret: owner.totpSecretEnc,
      })
      if (!session) return refuse('target', record)
      sessionId = session.id; targetPrincipalId = owner.id; targetLabel = `principal:${owner.username}`
    } else {
      let established: Awaited<ReturnType<typeof establishHandoffMailboxSession>>
      try {
        established = await establishHandoffMailboxSession({
          db: deps.db, entryPoint: audience, mailbox: record.target.mailbox, serviceUserId: record.target.serviceUserId, accountId: record.target.accountId,
          impersonator, ttlMs: HANDOFF_SESSION_TTL_MS, ip, userAgent,
        })
      } catch (error) {
        // A mailbox identity bound to another account, or one changed meanwhile, is a refused target, never a raw error page.
        if (isXpanelError(error)) return refuse('target', record)
        throw error
      }
      rawToken = established.rawToken; sessionId = established.session.id; targetPrincipalId = established.principal.id; targetLabel = `mailbox:${established.mailbox}`
    }
    await deps.emitAudit({
      actor: record.target.kind === 'mailbox' ? record.target.mailbox : targetLabel.slice('principal:'.length), action: 'handoff.consumed', target: targetLabel, outcome: 'ok',
      principalId: targetPrincipalId, ip,
      detail: { audience, sessionId, impersonator, issuerEntryPoint: record.issuer.entryPoint, ...(record.issuer.teamMemberId ? { teamMemberId: record.issuer.teamMemberId } : {}) },
    }, { accountId: record.target.accountId, resellerId: null })
    return new Response(null, { status: 303, headers: {
      ...PRIVATE_HEADERS,
      location: handoffLandingPath(audience, record.landing),
      'set-cookie': formatSessionCookie(rawToken, { entryPoint: audience, secure: deps.secureCookies(req), maxAgeSec: HANDOFF_SESSION_TTL_MS / 1000 }),
    } })
  }

  return async (req: Request, pathname: string, method: string): Promise<Response | null> => {
    if (pathname === '/api/handoff/xpanel' || pathname === '/api/handoff/xmail') {
      const issuer: EntryPoint = pathname.endsWith('/xpanel') ? 'xwhm' : 'xpanel'
      if (deps.entryPoint !== issuer) return fail('NOT_FOUND', 'route is unavailable on this entry point')
      if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
      return pathname.endsWith('/xpanel') ? issueXpanel(req) : issueXmail(req)
    }
    if (pathname === '/login/handoff' && (deps.entryPoint === 'xpanel' || deps.entryPoint === 'xmail')) {
      if (method !== 'POST') return new Response(null, { status: 405, headers: { ...PRIVATE_HEADERS, allow: 'POST' } })
      return consume(req, deps.entryPoint)
    }
    return null
  }
}
