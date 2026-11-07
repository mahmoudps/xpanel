import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createRootPrincipal, createTestDb, deletePrincipal, listSecurityQuestions, listVerifiedIps, replaceSecurityQuestions } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import type { AuthenticatedCaller } from './auth.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { addressVerified, checkSecurityQuestions, clientAddress, handleSecurityQuestionsRoute, normalizeAnswer, parseQuestionSet, parseVerifiedAddress, SECURITY_QUESTIONS_POLICY } from './security-questions.ts'
import type { SecurityQuestionsHelpers } from './security-questions.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const reason = async (run: () => Promise<unknown>) => { try { await run(); return 'passed' } catch (error) { return isXpanelError(error) ? `${error.code}:${error.detail.securityQuestionsRequired === true ? 'challenge' : String(error.detail.reason ?? '')}` : error } }

describe('security question rules', () => {
  it('normalises answers and accepts only bounded, distinct sets', () => {
    expect(normalizeAnswer('  Blue   Sky ')).toBe('blue sky')
    expect(parseQuestionSet([])).toEqual([])
    expect(parseQuestionSet([{ question: 'First pet name?', answer: ' Rex ' }, { question: 'City of birth?', answer: 'Amman' }])).toEqual([{ question: 'First pet name?', answer: 'rex' }, { question: 'City of birth?', answer: 'amman' }])
    for (const bad of [[{ question: 'First pet name?', answer: 'rex' }], [{ question: 'Short', answer: 'rex' }, { question: 'City of birth?', answer: 'amman' }],
      [{ question: 'First pet name?', answer: 'ab' }, { question: 'City of birth?', answer: 'amman' }], [{ question: 'First pet name?', answer: 'rex' }, { question: 'first pet NAME?', answer: 'amman' }],
      [{ question: 'First pet name?', answer: 'same' }, { question: 'City of birth?', answer: 'SAME' }], [{ question: 'First pet name?', answer: 'rex', extra: 1 }, { question: 'City of birth?', answer: 'amman' }]])
      expect(() => parseQuestionSet(bad)).toThrow()
  })
  it('matches exact addresses, IPv4-mapped clients and a trailing IPv4 wildcard', () => {
    expect(clientAddress('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(clientAddress('2001:DB8:0:0::1')).toBe('2001:db8::1')
    expect(parseVerifiedAddress(' 203.0.113.* ')).toBe('203.0.113.*')
    expect(() => parseVerifiedAddress('203.0.*.*')).toThrow()
    expect(() => parseVerifiedAddress('example.test')).toThrow()
    expect(addressVerified('203.0.113.9', ['203.0.113.*'])).toBe(true)
    expect(addressVerified('203.0.114.9', ['203.0.113.*'])).toBe(false)
    expect(addressVerified('2001:db8::1', ['2001:db8::1'])).toBe(true)
  })
  it('is admitted on the panel listeners only', () => {
    expect(entryPointAllowsApiRoute('xwhm', '/api/auth/security-questions', 'PUT')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/auth/security-questions/addresses', 'POST')).toBe(true)
    expect(entryPointAllowsApiRoute('xmail', '/api/auth/security-questions', 'GET')).toBe(false)
  })
})

describe('verified-address sign-in', () => {
  let db: TestDbHandle, root = '', principalId = ''
  beforeEach(async () => {
    db = await createTestDb(); root = await mkdtemp(join(tmpdir(), 'xp-sq-'))
    principalId = (await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })).id
  })
  afterEach(async () => { await db.close(); await rm(root, { recursive: true, force: true }) })
  const policy = async (value: unknown) => { await mkdir(join(root, 'extended/panel'), { recursive: true }); await writeFile(join(root, SECURITY_QUESTIONS_POLICY), JSON.stringify(value)) }
  const caller = () => ({ principal: { kind: 'root', id: principalId, username: 'root' }, principalRecord: {}, sessionId: 's1', apiTokenId: null, scopes: [] }) as unknown as AuthenticatedCaller
  const harness = (ip = '198.51.100.7') => {
    const events: string[] = []
    const lease = { assertFencingToken: async () => undefined, release: async () => undefined }
    const helpers: SecurityQuestionsHelpers = {
      db: db.db, store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) } as unknown as SecurityQuestionsHelpers['store'],
      requireCaller: async () => caller(), assertRoot: async () => undefined, emitAudit: async entry => { events.push(entry.action + ':' + entry.outcome) },
      clientIp: () => ip, verifyPassword: async (_caller, password) => password === 'current-password', checkLockout: async () => null,
      recordFailure: async (_caller, why) => { events.push('failure:' + why) },
    }
    const send = (path: string, method: string, body?: unknown) => handleSecurityQuestionsRoute(new Request('https://whm.test' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('https://whm.test' + path), method, helpers)
    return { helpers, events, send }
  }
  const sign = (h: ReturnType<typeof harness>, input: { ip?: string; answers?: unknown; secondFactorVerified?: boolean; external?: boolean } = {}) => {
    const recordFailure = vi.fn(async () => undefined)
    return { recordFailure, run: () => checkSecurityQuestions(h.helpers, { principalId, username: 'root', ip: input.ip ?? '198.51.100.7', answers: input.answers, secondFactorVerified: input.secondFactorVerified ?? false, external: input.external ?? false, recordFailure }) }
  }

  it('asks an unverified address, verifies it on correct answers and counts wrong answers as failures', async () => {
    const h = harness()
    expect(await reason(() => h.send('/api/auth/security-questions', 'PUT', { currentPassword: 'wrong', questions: [{ question: 'First pet name?', answer: 'Rex' }, { question: 'City of birth?', answer: 'Amman' }] }))).toBe('UNAUTHENTICATED:')
    expect(h.events).toContain('failure:invalid_security_questions_reauthentication')
    const saved = await (await h.send('/api/auth/security-questions', 'PUT', { currentPassword: 'current-password', questions: [{ question: 'First pet name?', answer: 'Rex' }, { question: 'City of birth?', answer: 'Amman' }] }))!.json()
    expect(saved.questions).toEqual([{ position: 1, question: 'First pet name?' }, { position: 2, question: 'City of birth?' }])
    expect((await listSecurityQuestions(db.db, principalId)).every(item => item.answerHash.startsWith('$argon2id$') && !item.answerHash.includes('rex'))).toBe(true)

    // Off by default: the questions exist but no sign-in asks them.
    expect(await reason(sign(h).run)).toBe('passed')
    await policy({ version: 1, verifiedIpSignIn: true, updatedAt: '2026-11-07T00:00:00.000Z' })
    expect(await reason(sign(h).run)).toBe('UNAUTHENTICATED:challenge')
    const wrong = sign(h, { answers: ['rex', 'paris'] })
    expect(await reason(wrong.run)).toBe('UNAUTHENTICATED:challenge')
    expect(wrong.recordFailure).toHaveBeenCalledWith('invalid_security_answers')
    expect(await reason(sign(h, { answers: [' REX ', 'amman'] }).run)).toBe('passed')
    expect((await listVerifiedIps(db.db, principalId)).map(item => [item.address, item.source])).toEqual([['198.51.100.7', 'answered']])
    expect(await reason(sign(h).run)).toBe('passed')
    expect(await reason(sign(h, { ip: '198.51.100.8' }).run)).toBe('UNAUTHENTICATED:challenge')
    // An enrolled second factor or a provider sign-in replaces the questions.
    expect(await reason(sign(h, { ip: '198.51.100.8', secondFactorVerified: true }).run)).toBe('passed')
    expect(await reason(sign(h, { ip: '198.51.100.8', external: true }).run)).toBe('passed')
    // A damaged policy file keeps the questions on.
    await writeFile(join(root, SECURITY_QUESTIONS_POLICY), '{"version":1')
    expect(await reason(sign(h, { ip: '198.51.100.8' }).run)).toBe('UNAUTHENTICATED:challenge')
    await deletePrincipal(db.db, principalId)
    expect(await listSecurityQuestions(db.db, principalId)).toEqual([])
  })

  it('lists, adds and removes verified addresses for the signed-in principal only', async () => {
    const h = harness('2001:db8::5')
    expect(await (await h.send('/api/auth/security-questions', 'GET'))!.json()).toMatchObject({ policy: { verifiedIpSignIn: false }, questions: [], addresses: [], client: { address: '2001:db8::5', verified: false } })
    const added = await (await h.send('/api/auth/security-questions/addresses', 'POST', { action: 'add', address: '2001:DB8::5' }))!.json()
    expect(added.client.verified).toBe(true)
    expect(await reason(() => h.send('/api/auth/security-questions/addresses', 'POST', { action: 'remove', address: '192.0.2.1' }))).toBe('NOT_FOUND:')
    expect(await reason(() => h.send('/api/auth/security-questions/addresses', 'POST', { action: 'add', address: '192.0.2.1', principalId: 'x' }))).toBe('VALIDATION:')
    const team = { ...caller(), team: { memberId: 'm' } } as unknown as AuthenticatedCaller
    expect(await reason(() => handleSecurityQuestionsRoute(new Request('https://whm.test/api/auth/security-questions'), new URL('https://whm.test/api/auth/security-questions'), 'GET', { ...h.helpers, requireCaller: async () => team }))).toBe('FORBIDDEN:')
    expect(h.events).toContain('auth.verified_address_added:ok')
  })

  it('lets root switch the server policy with a revision check', async () => {
    const h = harness()
    const first = await (await h.send('/api/server/sec/security-questions', 'GET'))!.json()
    expect(first).toMatchObject({ state: 'default', policy: { verifiedIpSignIn: false } })
    const saved = await (await h.send('/api/server/sec/security-questions', 'PUT', { verifiedIpSignIn: true, expectedRevision: first.revision }))!.json()
    expect(saved).toMatchObject({ state: 'saved', policy: { verifiedIpSignIn: true } })
    expect(await reason(() => h.send('/api/server/sec/security-questions', 'PUT', { verifiedIpSignIn: false, expectedRevision: first.revision }))).toBe('CONFLICT:')
    expect(h.events).toContain('server.sec.security_questions.saved:ok')
  })

  it('lets root clear the questions of a user who lost the answers, without reading them', async () => {
    const h = harness()
    await replaceSecurityQuestions(db.db, principalId, [{ question: 'First pet name?', answerHash: HASH }, { question: 'City of birth?', answerHash: HASH }])
    const reset = await (await h.send('/api/server/sec/security-questions/reset', 'POST', { username: ' ROOT ' }))!.json()
    expect(reset).toEqual({ username: 'root', removed: 2 })
    expect(await listSecurityQuestions(db.db, principalId)).toEqual([])
    expect(h.events).toContain('server.sec.security_questions.reset:ok')
    expect(await reason(() => h.send('/api/server/sec/security-questions/reset', 'POST', { username: 'nobody' }))).toBe('NOT_FOUND:')
    expect((await h.send('/api/server/sec/security-questions/reset', 'GET'))!.status).toBe(405)
    expect(entryPointAllowsApiRoute('xmail', '/api/server/sec/security-questions/reset', 'POST')).toBe(false)
  })
})
