import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entryPointAllowsApiRoute } from '../entry-points.ts'
import { CLI_API_FUNCTIONS } from './functions.ts'
import { cliApiAllowsRoute } from './identity.ts'

const AUDIENCE = { xuapi: 'xpanel', xwhmapi: 'xwhm' } as const
const SAMPLE: Record<string, string> = {
  calendarId: '0123456789abcdef0123456789abcdef', ddnsId: 'ddns_ABCDEFGHIJKLMNOPQRSTUV', fingerprint: '0123456789ABCDEF0123456789ABCDEF01234567',
  backup: 'b1', section: 'general', zoneName: 'example.test', domain: 'example.test', filename: 'a.txt', artifact: 'manifest', username: 'alice', account: 'alice',
  archive: 'example.test-2026-11-05.gz', server: 'nginx', file: 'access.log.1',
}
const sample = (path: string): string => path.replace(/\{(\w+)\}/g, (_, name: string) => SAMPLE[name] ?? '00000000-0000-4000-8000-000000000000')
// Credential, sign-in and interactive-only routes a command-line caller never reaches.
const unlisted = (method: string, path: string): boolean => !cliApiAllowsRoute(sample(path), method)
  || /^\/api\/(?:health|ws)(?:\/|$)/.test(path) || /^\/api\/(?:account|server)\/(?:terminal|developer|root-password)(?:\/|$)/.test(path) || path.startsWith('/api/server/panel/developer')

describe('xuapi / xwhmapi function catalog', { tags: ['unit'] }, () => {
  it('lists only routes admitted on the listener of each command and reachable from the command line', () => {
    for (const [command, functions] of Object.entries(CLI_API_FUNCTIONS) as [keyof typeof AUDIENCE, typeof CLI_API_FUNCTIONS.xuapi][]) {
      for (const [module, fn, method, path] of functions) {
        expect(path, `${command} ${module} ${fn}`).toMatch(/^\/api\/[a-z0-9{}/._-]+$/i)
        expect(entryPointAllowsApiRoute(AUDIENCE[command], sample(path), method), `${command} ${module} ${fn}`).toBe(true)
        expect(unlisted(method, path), `${command} ${module} ${fn}`).toBe(false)
      }
    }
  })

  it('gives every function one unique name and one route', () => {
    for (const functions of Object.values(CLI_API_FUNCTIONS)) {
      const names = functions.map(([module, fn]) => `${module} ${fn}`)
      const routes = functions.map(([, , method, path]) => `${method} ${path.replace(/\{\w+\}/g, '{}')}`)
      expect(new Set(names).size).toBe(names.length)
      expect(new Set(routes).size).toBe(routes.length)
    }
  })

  it('serves per-account shell access through the account update, not an orphaned /shell route', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs/planning/authorization-route-matrix.json'), 'utf8')) as { routes: { method: string; path: string }[] }
    // Manage Shell Access is the `shell` field of PATCH /api/accounts/:id; the per-account /shell route had no handler.
    expect(matrix.routes.some(route => route.method === 'PATCH' && route.path === '/api/accounts/:id')).toBe(true)
    expect(matrix.routes.some(route => /\/accounts\/(?::username|\{username\})\/shell$/.test(route.path))).toBe(false)
    for (const functions of Object.values(CLI_API_FUNCTIONS)) {
      expect(functions.some(([, , , path]) => /\/accounts\/\{username\}\/shell$/.test(path))).toBe(false)
    }
  })

  it('lists every route of the authorization matrix that each listener admits', () => {
    const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs/planning/authorization-route-matrix.json'), 'utf8')) as { routes: { method: string; path: string; surface: string }[] }
    for (const [command, audience] of Object.entries(AUDIENCE) as [keyof typeof AUDIENCE, 'xpanel' | 'xwhm'][]) {
      const listed = new Set(CLI_API_FUNCTIONS[command].map(([, , method, path]) => `${method} ${path.replace(/\{\w+\}/g, '{}')}`))
      const missing = matrix.routes
        .filter(route => route.surface === 'api')
        .map(route => ({ method: route.method, path: route.path.replace(/:(\w+)/g, '{$1}') }))
        .filter(route => !unlisted(route.method, route.path) && entryPointAllowsApiRoute(audience, sample(route.path), route.method))
        .map(route => `${route.method} ${route.path.replace(/\{\w+\}/g, '{}')}`)
        .filter(route => !listed.has(route))
      expect(missing, command).toEqual([])
    }
  })
})
