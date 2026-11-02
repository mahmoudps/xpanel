import { describe, expect, it } from 'vitest'
import { handoffLandingPath, handoffTokenHash, impersonationForbidsRoute, newHandoffToken, parseHandoffForm, parseHandoffLanding } from './panel-handoff-protocol.ts'
import { entryPointAdmitsPrincipal, entryPointAllowsApiRoute, isMailboxPrincipalUsername } from './entry-points.ts'
import { policyForRequest } from './authorization.ts'

const FORM = 'application/x-www-form-urlencoded'

describe('one-time handoff protocol rules', () => {
  it('issues 256-bit base64url secrets and stores only a domain-separated hash', () => {
    const token = newHandoffToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newHandoffToken()).not.toBe(token)
    expect(handoffTokenHash(token)).toMatch(/^[0-9a-f]{64}$/)
    expect(handoffTokenHash(token)).not.toContain(token)
  })

  it('accepts exactly one token field in a bounded urlencoded body', () => {
    const token = newHandoffToken()
    expect(parseHandoffForm(FORM, `token=${token}`)).toBe(token)
    expect(parseHandoffForm(`${FORM}; charset=UTF-8`, `token=${token}`)).toBe(token)
    for (const [type, body] of [
      ['application/json', `token=${token}`], [null, `token=${token}`], [FORM, `token=${token}&token=${token}`], [FORM, `token=${token}&next=/whm`],
      [FORM, `code=${token}`], [FORM, 'token=short'], [FORM, `token=${token}x`], [FORM, ''], [FORM, `token=${token}${'&'.repeat(300)}`],
    ] as const) expect(parseHandoffForm(type, body), `${type} ${body.slice(0, 20)}`).toBeNull()
  })

  it('lands only on the fixed homes of the target panel', () => {
    expect(handoffLandingPath('xpanel', 'home')).toBe('/panel')
    expect(handoffLandingPath('xmail', 'home')).toBe('/mail')
    expect(handoffLandingPath('xmail', 'calendar')).toBe('/mail/calendar')
    expect(handoffLandingPath('xmail', 'contacts')).toBe('/mail/contacts')
    expect(parseHandoffLanding(undefined)).toBe('home')
    expect(() => parseHandoffLanding('/whm')).toThrow(/landing/)
  })

  it('keeps an impersonated session away from the sign-in identity of its target', () => {
    for (const [method, path] of [['POST', '/api/auth/change-password'], ['POST', '/api/auth/2fa/setup'], ['POST', '/api/auth/2fa/disable'], ['PATCH', '/api/account/preferences'],
      ['POST', '/api/account/team'], ['PUT', '/api/account/team/77777777-7777-4777-8777-000000000001'], ['POST', '/api/server/panel/api-tokens'], ['PATCH', '/api/accounts/alice'], ['POST', '/api/handoff/xmail'], ['PUT', '/api/auth/ui-preferences']] as const) {
      expect(impersonationForbidsRoute(path, method), `${method} ${path}`).toBe(true)
    }
    for (const [method, path] of [['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['GET', '/api/account/preferences'], ['GET', '/api/account/team'], ['POST', '/api/domains'], ['GET', '/api/webmail/inbox'], ['GET', '/api/auth/ui-preferences']] as const) {
      expect(impersonationForbidsRoute(path, method), `${method} ${path}`).toBe(false)
    }
  })

  it('admits only the exact UI preference read and write on all interactive listeners', () => {
    for (const entry of ['xpanel', 'xwhm', 'xmail'] as const) {
      for (const method of ['GET', 'PUT']) expect(entryPointAllowsApiRoute(entry, '/api/auth/ui-preferences', method)).toBe(true)
      for (const method of ['POST', 'PATCH', 'DELETE', 'HEAD']) expect(entryPointAllowsApiRoute(entry, '/api/auth/ui-preferences', method)).toBe(false)
      expect(entryPointAllowsApiRoute(entry, '/api/auth/ui-preferences/other', 'GET')).toBe(false)
    }
    expect(policyForRequest('/api/auth/ui-preferences', 'GET')).toEqual({ resource: 'auth' })
    expect(policyForRequest('/api/auth/ui-preferences', 'PUT')).toEqual({ resource: 'auth' })
  })

  it('admits mailbox identities only on xMail and confines issuance to the one crossing each listener owns', () => {
    const mailbox = { kind: 'user' as const, username: 'mbx0123456789abcdef0123456789ab' }
    const owner = { kind: 'user' as const, username: 'alice' }
    expect(isMailboxPrincipalUsername(mailbox.username)).toBe(true)
    expect(entryPointAdmitsPrincipal('xmail', mailbox)).toBe(true)
    expect(entryPointAdmitsPrincipal('xmail', owner)).toBe(false)
    expect(entryPointAdmitsPrincipal('xmail', { kind: 'root', username: 'root' })).toBe(false)
    expect(entryPointAdmitsPrincipal('xpanel', owner)).toBe(true)
    expect(entryPointAdmitsPrincipal('xpanel', mailbox)).toBe(false)
    expect(entryPointAdmitsPrincipal('xwhm', { kind: 'reseller', username: 'reseller' })).toBe(true)
    expect((['xpanel', 'xwhm', 'xmail'] as const).filter(entry => entryPointAllowsApiRoute(entry, '/api/handoff/xpanel', 'POST'))).toEqual(['xwhm'])
    expect((['xpanel', 'xwhm', 'xmail'] as const).filter(entry => entryPointAllowsApiRoute(entry, '/api/handoff/xmail', 'POST'))).toEqual(['xpanel'])
    expect(entryPointAllowsApiRoute('xwhm', '/api/handoff/xpanel', 'GET')).toBe(false)
    expect(policyForRequest('/api/handoff/xpanel', 'POST')).toEqual({ resource: 'handoff', acl: 'edit-account' })
    expect(policyForRequest('/api/handoff/xmail', 'POST')).toEqual({ resource: 'handoff', acl: 'edit-account', toolIds: ['email-accounts'] })
  })
})
