import { isIP } from 'node:net'
import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { addVerifiedIp, findPrincipalByUsername, listSecurityQuestions, listVerifiedIps, MAX_SECURITY_QUESTIONS, MAX_VERIFIED_IPS, removeVerifiedIp, replaceSecurityQuestions, VERIFIED_IP } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { hashPasswordArgon2id, verifyPasswordArgon2id } from './auth.ts'
import { assertAccountFeatures } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertOwnSession, bodyOf, expectedRevision, invalid, json, object, reauthenticate, revisionOf, unchanged } from './identity-http.ts'
import type { ReauthenticationPorts } from './identity-http.ts'

/**
 * cPanel Security Policy "Limit logins to verified IP addresses" with Security Questions: once root turns the
 * policy on, a principal that set questions and signs in with the right password from an address it has not
 * verified must also answer them; the address is then verified. An enrolled second factor replaces the questions.
 */
export const SECURITY_QUESTIONS_POLICY = 'extended/panel/security-questions.json'
export const MIN_SECURITY_QUESTIONS = 2
const ROUTE = '/api/auth/security-questions', ADDRESSES = '/api/auth/security-questions/addresses', SERVER = '/api/server/sec/security-questions', RESET = '/api/server/sec/security-questions/reset'

export interface SecurityQuestionsPolicy { verifiedIpSignIn: boolean }

const readPolicyRaw = async (store: Pick<StateStore, 'rootDir'>): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, SECURITY_QUESTIONS_POLICY)) } catch { return { invalid: true } }
}
const parsePolicy = (raw: unknown): SecurityQuestionsPolicy | null =>
  object(raw) && Object.keys(raw).sort().join() === 'updatedAt,verifiedIpSignIn,version' && raw.version === 1 && typeof raw.verifiedIpSignIn === 'boolean' && typeof raw.updatedAt === 'string'
    ? { verifiedIpSignIn: raw.verifiedIpSignIn } : null
/** An unreadable saved policy keeps the questions on: a damaged file must not quietly drop a sign-in check. */
export const readSecurityQuestionsPolicy = async (store: Pick<StateStore, 'rootDir'>): Promise<SecurityQuestionsPolicy> => {
  const raw = await readPolicyRaw(store)
  return raw === null ? { verifiedIpSignIn: false } : parsePolicy(raw) ?? { verifiedIpSignIn: true }
}

/** The request's client address in the stored form: dotted IPv4 (also from an IPv4-mapped IPv6 address) or compressed lowercase IPv6. */
export const clientAddress = (ip: string | null | undefined): string | null => {
  if (!ip) return null
  const value = /^::ffff:([0-9.]+)$/i.exec(ip)?.[1] ?? ip
  const family = isIP(value)
  if (family === 4) return value
  if (family === 6) return new URL(`http://[${value}]`).hostname.slice(1, -1).toLowerCase()
  return null
}
/** A listed entry: an exact address or an IPv4 address whose last octet is '*'. */
export const parseVerifiedAddress = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 45) return invalid('an IP address is required')
  const trimmed = value.trim()
  const wildcard = /^(.+)\.\*$/.exec(trimmed)
  const address = wildcard ? (isIP(wildcard[1] + '.0') === 4 ? trimmed : null) : clientAddress(trimmed)
  return address && VERIFIED_IP.test(address) ? address : invalid('enter an IPv4 or IPv6 address; an IPv4 address may end in *')
}
export const addressVerified = (address: string, entries: readonly string[]): boolean =>
  entries.some(entry => entry === address || (entry.endsWith('.*') && isIP(address) === 4 && address.slice(0, address.lastIndexOf('.') + 1) === entry.slice(0, -1)))

/** Answers compare case-insensitively and without surrounding or repeated spaces. */
export const normalizeAnswer = (answer: string): string => answer.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()

const singleLine = (value: unknown, min: number, max: number, what: string): string =>
  typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) && value.trim().length >= min && value.trim().length <= max ? value.trim().replace(/\s+/gu, ' ') : invalid(`${what} must be ${min} to ${max} characters on one line`)

/** Validates a submitted set: none (questions off) or 2 to 5 distinct questions with answers of at least 3 characters. */
export function parseQuestionSet(value: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(value) || value.length > MAX_SECURITY_QUESTIONS || (value.length > 0 && value.length < MIN_SECURITY_QUESTIONS))
    return invalid(`choose ${MIN_SECURITY_QUESTIONS} to ${MAX_SECURITY_QUESTIONS} security questions, or none to turn them off`)
  const items = value.map(item => object(item) && Object.keys(item).sort().join() === 'answer,question'
    ? { question: singleLine(item.question, 8, 200, 'a security question'), answer: normalizeAnswer(singleLine(item.answer, 3, 200, 'an answer')) }
    : invalid('each security question needs a question and an answer'))
  if (new Set(items.map(item => item.question.toLowerCase())).size !== items.length) return invalid('each security question must be different')
  if (new Set(items.map(item => item.answer)).size !== items.length) return invalid('use a different answer for each question')
  return items
}

export interface SecurityQuestionGateDeps {
  db: Db
  store: Pick<StateStore, 'rootDir'>
  emitAudit: ExtendedRouteHelpers['emitAudit']
}
export interface SecurityQuestionCheck {
  principalId: string
  username: string
  ip: string | null
  answers: unknown
  /** This sign-in already verified an enrolled second factor. */
  secondFactorVerified: boolean
  /** The identity provider authenticated this sign-in; the questions guard password sign-in. */
  external: boolean
  recordFailure: (reason: string) => Promise<void>
}

/** The sign-in step after the password (and second factor): returns when the sign-in may continue, throws otherwise. */
export async function checkSecurityQuestions(deps: SecurityQuestionGateDeps, input: SecurityQuestionCheck): Promise<void> {
  if (input.external || input.secondFactorVerified || !(await readSecurityQuestionsPolicy(deps.store)).verifiedIpSignIn) return
  const questions = await listSecurityQuestions(deps.db, input.principalId)
  if (!questions.length) return
  const address = clientAddress(input.ip)
  if (address && addressVerified(address, (await listVerifiedIps(deps.db, input.principalId)).map(entry => entry.address))) return
  const challenge = { securityQuestionsRequired: true, questions: questions.map(item => ({ position: item.position, question: item.question })) }
  if (input.answers === undefined) return fail('UNAUTHENTICATED', 'security questions must be answered for a sign-in from this address', challenge)
  const answers = Array.isArray(input.answers) && input.answers.length === questions.length && input.answers.every(answer => typeof answer === 'string' && answer.length <= 400)
    ? input.answers as string[] : invalid('answer every security question')
  // Every answer is checked, so the response time does not tell which one was wrong; one at a time keeps the memory peak within the budget.
  let correct = true
  for (const [index, item] of questions.entries()) correct = await verifyPasswordArgon2id(normalizeAnswer(answers[index]!), item.answerHash) && correct
  if (!correct) {
    await input.recordFailure('invalid_security_answers')
    await deps.emitAudit({ actor: input.username, action: 'auth.security_questions_failed', target: `principal:${input.username}`, outcome: 'denied', principalId: input.principalId, ...(input.ip ? { ip: input.ip } : {}) }).catch(() => undefined)
    return fail('UNAUTHENTICATED', 'the security answers are incorrect', challenge)
  }
  let stored = false
  if (address) try { stored = await addVerifiedIp(deps.db, input.principalId, address, 'answered') } catch (error) { if (!isXpanelError(error) || error.code !== 'LIMIT_EXCEEDED') throw error }
  await deps.emitAudit({ actor: input.username, action: 'auth.security_questions_answered', target: `principal:${input.username}`, outcome: 'ok', principalId: input.principalId, detail: { addressVerified: stored }, ...(input.ip ? { ip: input.ip } : {}) })
}

export interface SecurityQuestionsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'>, Omit<ReauthenticationPorts, 'requireCaller' | 'emitAudit'> {
  db: Db
  store: StateStore
  clientIp: (request: Request) => string | null
  now?: () => Date
}

const selfView = async (helpers: SecurityQuestionsHelpers, caller: AuthenticatedCaller, request: Request) => {
  const [policy, questions, addresses] = await Promise.all([readSecurityQuestionsPolicy(helpers.store), listSecurityQuestions(helpers.db, caller.principal.id), listVerifiedIps(helpers.db, caller.principal.id)])
  const address = clientAddress(helpers.clientIp(request))
  return { policy, questions: questions.map(item => ({ position: item.position, question: item.question })), addresses,
    client: { address, verified: address !== null && addressVerified(address, addresses.map(entry => entry.address)) },
    limits: { minQuestions: MIN_SECURITY_QUESTIONS, maxQuestions: MAX_SECURITY_QUESTIONS, maxAddresses: MAX_VERIFIED_IPS } }
}

/** The signed-in principal's own questions and verified addresses, and root's server-wide policy switch. */
export async function handleSecurityQuestionsRoute(request: Request, url: URL, method: string, helpers: SecurityQuestionsHelpers): Promise<Response | null> {
  if (url.pathname === SERVER) return serverPolicy(request, url, method, helpers)
  if (url.pathname === RESET) return resetQuestions(request, url, method, helpers)
  if (url.pathname !== ROUTE && url.pathname !== ADDRESSES) return null
  const allowed = url.pathname === ROUTE ? ['GET', 'PUT'] : ['POST']
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  if (url.search) return invalid('security questions accept no selectors')
  const caller = await helpers.requireCaller(request)
  assertOwnSession(caller)
  if (caller.principal.kind === 'user') {
    const account = await helpers.store.getAccount(caller.principal.accountId)
    if (!account) return fail('NOT_FOUND', 'account not found', unchanged)
    await assertAccountFeatures(helpers.store, caller, account, ['security-policy'])
  }
  if (method === 'GET') return json(await selfView(helpers, caller, request))
  if (url.pathname === ADDRESSES) {
    const body = await bodyOf(request, 512, ['action', 'address'], ['action', 'address'])
    if (body.action !== 'add' && body.action !== 'remove') return invalid('action must be add or remove')
    const address = parseVerifiedAddress(body.address)
    const changed = body.action === 'add' ? await addVerifiedIp(helpers.db, caller.principal.id, address, 'added', helpers.now?.()) : await removeVerifiedIp(helpers.db, caller.principal.id, address)
    if (body.action === 'remove' && !changed) return fail('NOT_FOUND', 'the address is not in your verified list', unchanged)
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: body.action === 'add' ? 'auth.verified_address_added' : 'auth.verified_address_removed', target: `principal:${caller.principal.username}`, outcome: 'ok', detail: { address } })
    return json(await selfView(helpers, caller, request))
  }
  const body = await bodyOf(request, 8 * 1024, ['currentPassword', 'questions'], ['currentPassword', 'questions'])
  const items = parseQuestionSet(body.questions)
  const fresh = await reauthenticate(request, caller, helpers, { password: body.currentPassword, action: 'security_questions' })
  const hashed: { question: string; answerHash: string }[] = []
  for (const item of items) hashed.push({ question: item.question, answerHash: await hashPasswordArgon2id(item.answer) })
  await replaceSecurityQuestions(helpers.db, fresh.principal.id, hashed, helpers.now?.())
  await helpers.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'auth.security_questions_updated', target: `principal:${fresh.principal.username}`, outcome: 'ok', detail: { questions: hashed.length } })
  return json(await selfView(helpers, fresh, request))
}

/** Root never reads or sets a user's answers; clearing them lets a user who lost the answers sign in and set new ones. */
async function resetQuestions(request: Request, url: URL, method: string, helpers: SecurityQuestionsHelpers): Promise<Response> {
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return invalid('the reset accepts no selectors')
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.sec.security_questions.reset')
  const body = await bodyOf(request, 512, ['username'], ['username'])
  if (typeof body.username !== 'string' || !body.username.trim() || body.username.length > 320) return invalid('a username is required')
  const principal = await findPrincipalByUsername(helpers.db, body.username.trim().toLowerCase())
  if (!principal) return fail('NOT_FOUND', 'that user was not found', unchanged)
  const removed = (await listSecurityQuestions(helpers.db, principal.id)).length
  await replaceSecurityQuestions(helpers.db, principal.id, [], helpers.now?.())
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.sec.security_questions.reset', target: `principal:${principal.username}`, outcome: 'ok', detail: { removed } })
  return json({ username: principal.username, removed })
}

async function serverPolicy(request: Request, url: URL, method: string, helpers: SecurityQuestionsHelpers): Promise<Response> {
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  if (url.search) return invalid('the policy accepts no selectors')
  const action = method === 'GET' ? 'server.sec.security_questions.read' : 'server.sec.security_questions.update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const view = (raw: unknown) => ({ state: raw === null ? 'default' : parsePolicy(raw) ? 'saved' : 'invalid', policy: parsePolicy(raw) ?? (raw === null ? { verifiedIpSignIn: false } : null),
    updatedAt: object(raw) && typeof raw.updatedAt === 'string' ? raw.updatedAt : null, revision: revisionOf(raw) })
  if (method === 'GET') return json(view(await readPolicyRaw(helpers.store)))
  const body = await bodyOf(request, 512, ['expectedRevision', 'verifiedIpSignIn'], ['expectedRevision', 'verifiedIpSignIn'])
  if (typeof body.verifiedIpSignIn !== 'boolean') return invalid('verifiedIpSignIn must be true or false')
  const expected = expectedRevision(body.expectedRevision)
  const next = { version: 1, verifiedIpSignIn: body.verifiedIpSignIn, updatedAt: (helpers.now?.() ?? new Date()).toISOString() }
  const lease = await helpers.store.getWriterLock().acquire()
  try {
    const fresh = await helpers.requireCaller(request)
    await helpers.assertRoot(fresh, action)
    if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'root authorization changed', unchanged)
    if (revisionOf(await readPolicyRaw(helpers.store)) !== expected) return fail('CONFLICT', 'the policy changed; reload before saving', unchanged)
    await lease.assertFencingToken()
    await atomicWriteJson(join(helpers.store.rootDir, SECURITY_QUESTIONS_POLICY), next, 0o640, () => lease.assertFencingToken())
  } finally { await lease.release() }
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.sec.security_questions.saved', target: 'server:sec:security-questions', outcome: 'ok', detail: { verifiedIpSignIn: next.verifiedIpSignIn } })
  return json(view(next))
}
