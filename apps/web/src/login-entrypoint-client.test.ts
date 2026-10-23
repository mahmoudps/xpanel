import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'

const execute = (audience: string | null, kind: string, ar = false) => {
  const match = /function redirectToWorkspace\(\) \{([\s\S]*?)\n  \}/.exec(LOGIN_CLIENT_SCRIPT)
  expect(match).not.toBeNull()
  const paths: string[] = []
  const errors: unknown[][] = []
  let cleared = 0
  runInNewContext('function redirectToWorkspace() {' + match![1] + '\n}\nredirectToWorkspace()', {
    principal: { kind }, ar, shell: { getAttribute: () => audience },
    clearCredentials: () => { cleared++ }, clearEnrollment: () => { cleared++ },
    copy: { unexpected: 'Unexpected server response.' }, message: (...args: unknown[]) => errors.push(args),
    window: { location: { assign: (path: string) => paths.push(path) } },
  })
  return { paths, errors, cleared }
}

describe('listener-selected login destinations', () => {
  it.each([['xpanel', 'user', '/panel'], ['xwhm', 'root', '/whm'], ['xwhm', 'reseller', '/whm'], ['xmail', 'user', '/mail/inbox']])('keeps %s %s on its own workspace', (audience, kind, path) => {
    for (const ar of [false, true]) {
      const result = execute(audience!, kind!, ar)
      expect(result.paths).toEqual([path + '?lang=' + (ar ? 'ar' : 'en')])
      expect(result.errors).toHaveLength(0)
      expect(result.cleared).toBe(2)
    }
  })
  it.each([['xpanel', 'root'], ['xpanel', 'reseller'], ['xmail', 'root'], ['xmail', 'reseller'], ['xwhm', 'user'], ['https://untrusted.example.test/', 'user'], ['__proto__', 'user'], ['xpanel', 'unknown']])('refuses an incompatible or unrecognized destination %s %s', (audience, kind) => {
    const result = execute(audience!, kind!)
    expect(result.paths).toHaveLength(0)
    expect(result.errors).toEqual([['Unexpected server response.', true]])
    expect(result.cleared).toBe(2)
  })
  it('retains the explicit legacy renderer role-based destination', () => {
    expect(execute(null, 'user').paths).toEqual(['/panel?lang=en'])
    expect(execute(null, 'root').paths).toEqual(['/whm?lang=en'])
  })
})
