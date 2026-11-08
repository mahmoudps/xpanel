import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleRegisteredAppsRoute, readRegisteredApps } from './registered-apps.ts'
import type { RegisteredAppsHelpers } from './registered-apps.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' } } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' } } as AuthenticatedCaller
const app = { name: 'acme', displayName: 'Acme Backup', surface: 'xwhm', url: 'https://backup.example.test/whm', acls: ['list-accounts'], features: [], description: 'Off-site copies.' }
let root = '', dir = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-apps-')); dir = join(root, 'extended', 'panel', 'apps'); await mkdir(dir, { recursive: true }) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const put = (name: string, value: unknown) => writeFile(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))

describe('registered applications', { tags: ['unit'] }, () => {
  it('lists the built-in surfaces and every registration file, keeps invalid files with their reason, and forgets removed files', async () => {
    await put('acme.json', app)
    await put('webmail-notes.json', { ...app, name: 'webmail-notes', surface: 'xmail', acls: [], features: ['webmail-message-list'] })
    await put('bad-url.json', { ...app, name: 'bad-url', url: 'http://plain.example.test' })
    await put('wrong-name.json', app)
    await put('reseller-feature.json', { ...app, name: 'reseller-feature', features: ['file-manager'] })
    await put('unknown-acl.json', { ...app, name: 'unknown-acl', acls: ['root-shell'] })
    await put('Bad Name.json', app)
    await put('broken.json', '{')
    await symlink(join(dir, 'acme.json'), join(dir, 'linked.json'))
    const view = await readRegisteredApps(root)
    expect(view.truncated).toBe(false)
    expect(view.apps.slice(0, 3).map(item => [item.origin, item.name, item.entryUrl])).toEqual([['internal', 'xwhm', '/whm'], ['internal', 'xpanel', '/panel'], ['internal', 'xmail', '/mail']])
    const rows = Object.fromEntries(view.apps.slice(3).map(item => [item.origin, item.state === 'registered' ? item : item.reason]))
    expect(rows['acme.json']).toEqual({ origin: 'acme.json', state: 'registered', name: 'acme', displayName: 'Acme Backup', surface: 'xwhm', entryUrl: app.url, acls: ['list-accounts'], features: [], description: 'Off-site copies.', reason: null })
    expect(rows['webmail-notes.json']).toMatchObject({ surface: 'xmail', features: ['webmail-message-list'] })
    expect(rows).toMatchObject({ 'bad-url.json': 'registration_url', 'wrong-name.json': 'registration_name', 'reseller-feature.json': 'registration_privileges', 'unknown-acl.json': 'registration_privileges',
      'Bad Name.json': 'registration_file_name', 'broken.json': 'registration_unreadable', 'linked.json': 'registration_file' })
    await rm(join(dir, 'acme.json'))
    expect((await readRegisteredApps(root)).apps.some(item => item.name === 'acme')).toBe(false)
  })

  it('is a root-only read without selectors', async () => {
    const helpers = (caller: AuthenticatedCaller) => ({ requireCaller: async () => caller, store: { rootDir: root },
      assertRoot: async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') } }) as unknown as RegisteredAppsHelpers
    const send = (caller: AuthenticatedCaller, method = 'GET', path = '/api/server/registered-apps') => handleRegisteredAppsRoute(new Request('http://api.test' + path, { method }), new URL('http://api.test' + path), method, helpers(caller))
    expect((await (await send(ROOT))!.json()).apps).toHaveLength(3)
    await expect(send(RESELLER)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(send(ROOT, 'GET', '/api/server/registered-apps?surface=xwhm')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await send(ROOT, 'POST'))!.status).toBe(405)
    expect(await send(ROOT, 'GET', '/api/server/other')).toBeNull()
  })
})
