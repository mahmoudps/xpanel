import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import type { FileEntry, FileText } from './file-manager.ts'
import { directoryPrivacyRevision, parseDirectoryPrivacyRequest, runDirectoryPrivacyRequest, sha512Crypt, type DirectoryPrivacyFiles, type DirectoryPrivacyRequest } from './directory-privacy.ts'
import { inspectHtaccess } from './htaccess-policy.ts'
import { parseManagedHtaccess, readWebDirective } from './htaccess-managed.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const account = { id: ACCOUNT, username: 'alice', home: '/home/alice', status: 'active' } as Account
const domains = [{ id: 'd1', accountId: ACCOUNT, name: 'alice.example.test', kind: 'primary', docRoot: '/home/alice/public_html', siteType: 'php', suspended: false }] as Domain[]
const settings = { engine: 'apache', backendPort: 8080 } as ServerSettings
const HASH = sha512Crypt('correct horse battery', 'saltsaltsaltsalt')

/** In-memory confined runner: mkdirat EEXIST is CONFLICT and every write compares the exact preimage. */
function memoryFiles(initial: Record<string, string> = {}, dirs: string[] = ['public_html', 'public_html/private']) {
  let tick = 0
  const stamp = () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString()
  const files = new Map<string, FileText>(Object.entries(initial).map(([path, content]) => [path, { path, content, sizeBytes: Buffer.byteLength(content), mtime: stamp() }]))
  const folders = new Set(dirs)
  const parent = (path: string) => path.split('/').slice(0, -1).join('/')
  const order: string[] = []
  const api: DirectoryPrivacyFiles = {
    list: async (path = '') => {
      if (path && !folders.has(path)) return fail('NOT_FOUND', 'missing', { stateChanged: false })
      const children: FileEntry[] = []
      for (const dir of folders) if (parent(dir) === path) children.push({ name: dir.split('/').at(-1)!, path: dir, kind: 'directory', sizeBytes: 0, mode: 0o750, mtime: stamp() })
      for (const file of files.values()) if (parent(file.path) === path) children.push({ name: file.path.split('/').at(-1)!, path: file.path, kind: 'file', sizeBytes: file.sizeBytes, mode: 0o640, mtime: file.mtime })
      return children
    },
    readText: async path => files.has(path) ? { ...files.get(path)! } : fail('NOT_FOUND', 'missing', { stateChanged: false }),
    mkdir: async (path, mode = 0o750) => {
      if (folders.has(path)) return fail('CONFLICT', 'exists', { stateChanged: false })
      if (parent(path) && !folders.has(parent(path))) return fail('NOT_FOUND', 'missing parent', { stateChanged: false })
      folders.add(path); order.push('mkdir ' + path)
      return { name: path.split('/').at(-1)!, path, kind: 'directory', sizeBytes: 0, mode, mtime: stamp() }
    },
    writeTextChecked: async (path, content, expected, mode = 0o640) => {
      if (JSON.stringify(files.get(path) ?? null) !== JSON.stringify(expected)) return fail('CONFLICT', 'changed preimage', { stateChanged: false })
      if (!folders.has(parent(path))) return fail('NOT_FOUND', 'missing parent', { stateChanged: false })
      order.push((content === null ? 'remove ' : 'write ') + path)
      if (content === null) { files.delete(path); return null }
      const file = { path, content, sizeBytes: Buffer.byteLength(content), mtime: stamp() }
      files.set(path, file)
      return { name: path.split('/').at(-1)!, path, kind: 'file', sizeBytes: file.sizeBytes, mode, mtime: file.mtime }
    },
  }
  return { api, files, folders, order }
}
const run = (files: DirectoryPrivacyFiles, request: DirectoryPrivacyRequest, extra: { settings?: ServerSettings | null; probe?: (domain: string, path: string) => Promise<number>; authorize?: () => Promise<void>; relabelPasswords?: () => Promise<void> } = {}) =>
  runDirectoryPrivacyRequest({ account, domains, settings: extra.settings === undefined ? settings : extra.settings, files, request, authorize: extra.authorize ?? (async () => undefined), ...(extra.probe ? { probe: extra.probe } : {}), ...(extra.relabelPasswords ? { relabelPasswords: extra.relabelPasswords } : {}) })
const readOne = async (files: DirectoryPrivacyFiles, path = 'public_html/private') => (await run(files, { op: 'read', path })).directories[0]!
const save = (revision: string, patch: Partial<Extract<DirectoryPrivacyRequest, { op: 'save' }>> = {}): DirectoryPrivacyRequest =>
  ({ op: 'save', path: 'public_html/private', expectedRevision: revision, enabled: true, authName: 'Members only', users: [{ username: 'bob', passwordHash: HASH }], ...patch })

describe('sha512Crypt', { tags: ['unit'] }, () => {
  it('matches the published SHA-512-crypt test vectors', () => {
    expect(sha512Crypt('Hello world!', 'saltstring')).toBe('$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1')
    expect(sha512Crypt('Hello world!', 'saltstringsaltst', 10000)).toBe('$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.')
  })
  it('draws a fresh 16-character salt and refuses unsafe parameters', () => {
    const first = sha512Crypt('correct horse battery'), second = sha512Crypt('correct horse battery')
    expect(first).toMatch(/^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/)
    expect(first).not.toBe(second)
    for (const salt of ['', 'a$b', 'x'.repeat(17)]) expect(() => sha512Crypt('x', salt)).toThrow()
  })
})

describe('directory privacy over the confined account files', { tags: ['unit'] }, () => {
  it('protects a folder: password file first, then the .htaccess block, keeping every user line', async () => {
    const userLines = '# mine\r\nRewriteEngine On\r\n'
    const t = memoryFiles({ 'public_html/private/.htaccess': userLines })
    const before = await readOne(t.api)
    expect(before).toMatchObject({ enabled: false, users: [], conflict: null, url: { domain: 'alice.example.test', path: '/private/' } })
    const probe = vi.fn(async () => 401)
    const view = await run(t.api, save(before.revision), { probe })
    expect(t.order).toEqual(['mkdir .htpasswds', 'mkdir .htpasswds/public_html', 'mkdir .htpasswds/public_html/private', 'write .htpasswds/public_html/private/passwd', 'write public_html/private/.htaccess'])
    expect(t.files.get('.htpasswds/public_html/private/passwd')!.content).toBe(`bob:${HASH}\n`)
    const htaccess = t.files.get('public_html/private/.htaccess')!.content
    expect(htaccess).toBe('# BEGIN xPanel directory-privacy\r\nAuthType Basic\r\nAuthName "Members only"\r\nAuthUserFile "/home/alice/.htpasswds/public_html/private/passwd"\r\nRequire valid-user\r\n# END xPanel directory-privacy\r\n' + userLines)
    expect(probe).toHaveBeenCalledWith('alice.example.test', '/private/')
    expect(view.application).toEqual({ status: 'saved', httpStatus: 401, protectionVerified: true, nativeQualified: false })
    expect(view.directories[0]).toMatchObject({ enabled: true, authName: 'Members only', users: ['bob'], conflict: null })
    // the user editor's policy still accepts the file and the web directives stay editable
    expect(inspectHtaccess(htaccess).valid).toBe(true)
    expect(readWebDirective(parseManagedHtaccess(htaccess), 'redirects', { domainName: 'alice.example.test' }).conflict).toBeNull()
    expect(readWebDirective(parseManagedHtaccess(htaccess), 'ip-blocker', { domainName: 'alice.example.test' }).conflict).toMatchObject({ code: 'access_rules_present' })
    expect((await run(t.api, { op: 'read', path: null })).directories.map(item => item.path)).toEqual(['public_html/private'])
  })

  it('relabels the password tree before Apache is told to read it, and reports a failed relabel', async () => {
    const t = memoryFiles()
    const relabelPasswords = vi.fn(async () => { t.order.push('relabel') })
    await run(t.api, save((await readOne(t.api)).revision), { relabelPasswords })
    expect(t.order.slice(-3)).toEqual(['write .htpasswds/public_html/private/passwd', 'relabel', 'write public_html/private/.htaccess'])
    const failed = memoryFiles()
    await expect(run(failed.api, save((await readOne(failed.api)).revision), { relabelPasswords: async () => { throw new Error('refused') } }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
    expect(failed.files.has('public_html/private/.htaccess')).toBe(false)
  })
  it('keeps existing hashes, adds and removes users, and reports a folder the server did not protect', async () => {
    const t = memoryFiles()
    await run(t.api, save((await readOne(t.api)).revision, { users: [{ username: 'bob', passwordHash: HASH }, { username: 'carol', passwordHash: HASH }] }))
    const other = sha512Crypt('another horse battery')
    const view = await run(t.api, save((await readOne(t.api)).revision, { users: [{ username: 'carol', passwordHash: null }, { username: 'dave', passwordHash: other }] }), { probe: async () => 200 })
    expect(t.files.get('.htpasswds/public_html/private/passwd')!.content).toBe(`carol:${HASH}\ndave:${other}\n`)
    expect(view.application.protectionVerified).toBe(false)
    await expect(run(t.api, save((await readOne(t.api)).revision, { users: [{ username: 'erin', passwordHash: null }] }))).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'users.0.password', code: 'required' }] } })
  })

  it('unprotects: the block goes first, users stay while listed, and nothing remains when both are gone', async () => {
    const t = memoryFiles({ 'public_html/private/.htaccess': 'Options -Indexes\n' })
    await run(t.api, save((await readOne(t.api)).revision))
    t.order.length = 0
    await run(t.api, save((await readOne(t.api)).revision, { enabled: false, users: [{ username: 'bob', passwordHash: null }] }))
    expect(t.files.get('public_html/private/.htaccess')!.content).toBe('Options -Indexes\n')
    expect(t.files.has('.htpasswds/public_html/private/passwd')).toBe(true)
    expect((await readOne(t.api))).toMatchObject({ enabled: false, users: ['bob'] })
    await run(t.api, save((await readOne(t.api)).revision, { enabled: false, authName: '', users: [] }))
    expect(t.files.has('.htpasswds/public_html/private/passwd')).toBe(false)
    const bare = memoryFiles()
    await run(bare.api, save((await readOne(bare.api)).revision))
    bare.order.length = 0
    await run(bare.api, save((await readOne(bare.api)).revision, { enabled: false, authName: '', users: [] }))
    expect(bare.order).toEqual(['remove public_html/private/.htaccess', 'remove .htpasswds/public_html/private/passwd'])
  })

  it.each([
    ['other access rules', { 'public_html/private/.htaccess': 'Require all denied\n' }, 'access_rules_present'],
    ['a hand-written auth block', { 'public_html/private/.htaccess': 'AuthType Basic\nRequire valid-user\n' }, 'access_rules_present'],
    ['an edited managed block', { 'public_html/private/.htaccess': '# BEGIN xPanel directory-privacy\nAuthType Basic\nRequire all granted\n# END xPanel directory-privacy\n' }, 'block_modified'],
    ['an unknown marker', { 'public_html/private/.htaccess': '# BEGIN xPanel other\n# END xPanel other\n' }, 'marker_malformed'],
    ['a password file it cannot parse', { '.htpasswds/public_html/private/passwd': 'bob:plaintext\n' }, 'passwd_unrecognized'],
  ])('refuses to change a folder with %s', async (_name, initial, code) => {
    const t = memoryFiles(initial, ['public_html', 'public_html/private', '.htpasswds', '.htpasswds/public_html', '.htpasswds/public_html/private'])
    const before = await readOne(t.api)
    expect(before.conflict?.code).toBe(code)
    t.order.length = 0
    await expect(run(t.api, save(before.revision))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(t.order).toEqual([])
  })

  it('refuses stale revisions, missing folders, folders outside a site, other engines and inactive accounts without writing', async () => {
    const t = memoryFiles({}, ['public_html', 'logs'])
    await expect(run(t.api, save('0'.repeat(64)))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(run(t.api, save((await readOne(t.api)).revision))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await readOne(t.api, 'logs')).conflict).toEqual({ code: 'outside_document_root' })
    await expect(run(t.api, save((await readOne(t.api, 'logs')).revision, { path: 'logs' }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const read = await run(t.api, { op: 'read', path: null }, { settings: { ...settings, engine: 'openlitespeed' } as ServerSettings })
    expect(read.capabilities).toEqual({ canSave: false, reason: 'engine' })
    const revision = directoryPrivacyRevision(ACCOUNT, 'public_html', { htaccess: null, passwd: null })
    await expect(run(t.api, save(revision, { path: 'public_html' }), { settings: { ...settings, engine: 'openlitespeed' } as ServerSettings })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'engine' } })
    await expect(runDirectoryPrivacyRequest({ account: { ...account, status: 'suspended' }, domains, settings, files: t.api, request: save(revision, { path: 'public_html' }), authorize: async () => undefined })).rejects.toMatchObject({ detail: { reason: 'inactive' } })
    expect(t.order).toEqual([])
  })

  it('asks for fresh authority before the first write and reports a lost write as an unknown outcome', async () => {
    const t = memoryFiles()
    const authorize = vi.fn(async () => fail('FORBIDDEN', 'gone', { stateChanged: false }))
    await expect(run(t.api, save((await readOne(t.api)).revision), { authorize })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(t.order).toEqual([])
    const broken = memoryFiles()
    const revision = (await readOne(broken.api)).revision
    broken.api.writeTextChecked = async () => { throw new Error('helper crashed') }
    await expect(run(broken.api, save(revision))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })

  it('parses only the reviewed agent request grammar', () => {
    expect(parseDirectoryPrivacyRequest({ op: 'read', path: null })).toEqual({ op: 'read', path: null })
    const good = { op: 'save', path: 'public_html/private', expectedRevision: 'a'.repeat(64), enabled: true, authName: 'x', users: [{ username: 'bob', passwordHash: HASH }] }
    expect(parseDirectoryPrivacyRequest(good)).toMatchObject({ op: 'save', users: [{ username: 'bob', passwordHash: HASH }] })
    for (const bad of [{ ...good, path: '../etc' }, { ...good, path: '.htpasswds/x' }, { ...good, users: [{ username: 'bob', password: 'plain text' }] }, { ...good, users: [{ username: 'bob', passwordHash: '$2y$10$' + 'a'.repeat(53) }] },
      { ...good, extra: 1 }, { ...good, users: [{ username: 'a:b', passwordHash: null }] }, { op: 'read' }, { op: 'delete', path: 'x' }]) expect(() => parseDirectoryPrivacyRequest(bad), JSON.stringify(bad)).toThrow()
  })
})
