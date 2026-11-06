import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Domain, Plan, ServerSettings } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { handleDirectoryPrivacyRoute } from './directory-privacy-workspace.ts'
import { parseDirectoryPrivacyRequest, runDirectoryPrivacyRequest } from '../../agent/src/directory-privacy.ts'
import type { DirectoryPrivacyFiles } from '../../agent/src/directory-privacy.ts'
import type { FileEntry, FileText } from '../../agent/src/file-manager.ts'

// The agent side is the actual runDirectoryPrivacyRequest; only the confined runner and the transport are test doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', home: '/home/alice', status: 'active', planId: 'plan' } as Account
const domains = [{ id: 'd1', accountId: ACCOUNT, name: 'alice.example.test', kind: 'primary', docRoot: '/home/alice/public_html', siteType: 'php', suspended: false }] as Domain[]
const owner = { principal: { kind: 'user', id: 'p-user', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller

function setup(options: { disabled?: string[]; reply?: (value: Record<string, any>) => unknown } = {}) {
  const files = new Map<string, FileText>(), folders = new Set(['public_html', 'public_html/private'])
  let tick = 0
  const parent = (path: string) => path.split('/').slice(0, -1).join('/')
  const runner: DirectoryPrivacyFiles = {
    list: async (path = '') => folders.has(path) ? [...[...folders].filter(dir => parent(dir) === path).map(dir => ({ name: dir.split('/').at(-1)!, path: dir, kind: 'directory' as const, sizeBytes: 0, mode: 0o750, mtime: new Date(0).toISOString() })),
      ...[...files.values()].filter(file => parent(file.path) === path).map(file => ({ name: file.path.split('/').at(-1)!, path: file.path, kind: 'file' as const, sizeBytes: file.sizeBytes, mode: 0o640, mtime: file.mtime }))] as FileEntry[] : fail('NOT_FOUND', 'missing', { stateChanged: false }),
    readText: async path => files.get(path) ?? fail('NOT_FOUND', 'missing', { stateChanged: false }),
    mkdir: async path => { if (folders.has(path)) return fail('CONFLICT', 'exists', { stateChanged: false }); folders.add(path); return { name: path, path, kind: 'directory', sizeBytes: 0, mode: 0o750, mtime: new Date(0).toISOString() } },
    writeTextChecked: async (path, content, expected) => {
      if (JSON.stringify(files.get(path) ?? null) !== JSON.stringify(expected)) return fail('CONFLICT', 'changed', { stateChanged: false })
      if (content === null) { files.delete(path); return null }
      const file = { path, content, sizeBytes: Buffer.byteLength(content), mtime: new Date(1_700_000_000_000 + ++tick * 1000).toISOString() }
      files.set(path, file)
      return { name: path.split('/').at(-1)!, path, kind: 'file', sizeBytes: file.sizeBytes, mode: 0o640, mtime: file.mtime }
    },
  }
  const sent: unknown[] = []
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string, input?: unknown) => {
    expect(path).toBe('/accounts/alice/directory-privacy')
    sent.push(input)
    const view = await runDirectoryPrivacyRequest({ account, domains, settings: { engine: 'apache', backendPort: 8080 } as ServerSettings, files: runner, request: parseDirectoryPrivacyRequest(input), authorize: async () => undefined, probe: async () => 401 })
    return options.reply ? options.reply(view as unknown as Record<string, any>) : view
  })
  const store = { getPlan: async () => ({ id: 'plan', featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }) } as unknown as StateStore
  const audit = vi.fn(async () => undefined)
  const ports = { store, requireCaller: async () => owner, resolveAccountParam: async (id: string) => id === 'alice' || id === ACCOUNT ? account : fail('NOT_FOUND', 'account not found'),
    assertCanAccessAccount: async () => undefined, emitAudit: audit, readAgent: readAgent as unknown as ReadAgent }
  const route = (method = 'GET', body?: unknown, search = '') => { const url = new URL('http://panel.test/api/web-features/alice/directory-privacy' + search); return handleDirectoryPrivacyRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
  return { route, readAgent, sent, files, audit }
}

describe('directory privacy API workspace', { tags: ['unit'] }, () => {
  it('hashes new passwords before the agent, saves one folder and returns the verified view', async () => {
    const t = setup()
    const folder = await (await t.route('GET', undefined, '?path=public_html/private'))!.json() as Record<string, any>
    expect(folder.directories[0]).toMatchObject({ path: 'public_html/private', enabled: false, conflict: null })
    const saved = await t.route('PUT', { path: 'public_html/private', expectedRevision: folder.directories[0].revision, enabled: true, authName: 'Members', users: [{ username: 'bob', password: 'correct horse battery' }] })
    expect(saved!.status).toBe(200)
    const body = await saved!.json() as Record<string, any>
    expect(body.application).toEqual({ status: 'saved', httpStatus: 401, protectionVerified: true, nativeQualified: false })
    expect(body.directories[0].directives).toContain('Require valid-user')
    const agentBody = JSON.stringify(t.sent.at(-1))
    expect(agentBody).not.toContain('correct horse')
    expect(agentBody).toMatch(/"passwordHash":"\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}"/)
    expect(t.files.get('.htpasswds/public_html/private/passwd')!.content).toMatch(/^bob:\$6\$/)
    expect(t.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'web_features.directory_privacy.updated', outcome: 'ok', detail: { path: 'public_html/private', enabled: true, users: 1, httpStatus: 401 } }))
    expect(JSON.stringify(await (await t.route('GET'))!.json())).not.toMatch(/\$6\$/)
  })

  it.each([
    ['traversal', { path: '../etc' }], ['absolute path', { path: '/home/alice' }], ['hidden root', { path: '.htpasswds/x' }],
    ['quote in name', { authName: 'a"b' }], ['newline in name', { authName: 'a\nRequire all granted' }], ['empty name when enabled', { authName: '' }],
    ['short password', { users: [{ username: 'bob', password: 'short' }] }], ['bad user', { users: [{ username: 'a:b', password: 'correct horse' }] }],
    ['duplicate user', { users: [{ username: 'bob' }, { username: 'bob' }] }], ['client hash', { users: [{ username: 'bob', passwordHash: '$6$x' }] }],
    ['unknown field', { extra: true }], ['stale revision shape', { expectedRevision: 'x' }],
  ])('refuses %s before the agent is asked', async (_name, patch) => {
    const t = setup()
    const response = await t.route('PUT', { path: 'public_html/private', expectedRevision: 'a'.repeat(64), enabled: true, authName: 'Members', users: [{ username: 'bob', password: 'correct horse' }], ...patch })
      .catch((error: { code: string }) => ({ status: error.code === 'VALIDATION' ? 422 : 500 }))
    expect(response!.status).toBe(422)
    expect(t.readAgent).not.toHaveBeenCalled()
  })

  it('refuses query selectors other than one folder, and keeps the feature policy', async () => {
    const t = setup()
    for (const search of ['?path=../x', '?account=bob', '?path=a&path=b']) await expect(t.route('GET', undefined, search)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(setup({ disabled: ['directory-privacy'] }).route('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('never reports an unverifiable agent answer as state', async () => {
    const foreign = setup({ reply: view => ({ ...view, context: { ...view.context, accountId: '22222222-2222-4222-8222-222222222222' } }) })
    await expect(foreign.route('GET')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const leaked = setup({ reply: view => ({ ...view, directories: view.directories.map((item: Record<string, unknown>) => ({ ...item, users: [{ username: 'bob', passwordHash: '$6$x' }] })) }) })
    const folder = await (await setup().route('GET', undefined, '?path=public_html/private'))!.json() as Record<string, any>
    await expect(leaked.route('PUT', { path: 'public_html/private', expectedRevision: folder.directories[0].revision, enabled: true, authName: 'Members', users: [{ username: 'bob', password: 'correct horse' }] }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
})
