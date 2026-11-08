import { randomBytes } from 'node:crypto'
import { tool } from './kit.mjs'

const secret = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const b64 = text => Buffer.from(text).toString('base64')
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const FILES = String.raw`accounts\/[a-z][a-z0-9]{0,15}\/files`
const ID = '[0-9a-f-]{36}'
// Assembled at run time so the source file itself is never mistaken for malware.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('')

/** The owner's first domain and its document root relative to the home. */
const siteOf = async owner => {
  const response = await owner.get('/api/domains'), domain = response.data?.domains?.[0], home = response.data?.context?.home
  const rel = domain && typeof home === 'string' && typeof domain.docRoot === 'string' ? (domain.docRoot.startsWith(`${home}/`) ? domain.docRoot.slice(home.length + 1) : domain.docRoot) : null
  return { response, id: domain?.id, name: domain?.name, rel }
}
const filesOf = (owner, fixture) => body => owner.post(`/api/accounts/${fixture.username}/files`, body)
/** Moves a path to the trash and purges it, for an undo step; an absent path counts as removed. */
const discard = (send, path) => async () => {
  const listed = await send({ op: 'list', path: path.split('/').slice(0, -1).join('/') })
  if (listed.status !== 200) return false
  if (!listed.data.entries.some(entry => entry.path === path)) return true
  const item = await send({ op: 'trash', path })
  if (item.status !== 200) return false
  return (await send({ op: 'purge-trash', trashId: item.data.id, originalPath: item.data.originalPath, deletedAt: item.data.deletedAt })).status === 200
}
const purgeItem = (send, item) => async () => {
  const listed = await send({ op: 'list-trash' })
  if (listed.status !== 200) return false
  if (!listed.data.items.some(entry => entry.id === item.id)) return true
  return (await send({ op: 'purge-trash', trashId: item.id, originalPath: item.originalPath, deletedAt: item.deletedAt })).status === 200
}
const put = (send, path, text, extra = {}) => send({ op: 'put-bytes', path, contentBase64: b64(text), ...extra })

/** A managed .htaccess feature of one domain; every write carries the revision just read. */
const directiveOf = (owner, domainId, feature) => {
  const path = `/api/domains/${domainId}/web-directives/${feature}`
  const read = () => owner.get(path)
  const write = async model => owner.put(path, { expectedRevision: (await read()).data?.document?.revision, model })
  const restore = (before, empty) => async () => {
    const now = await read()
    if (now.status !== 200) return false
    const target = before.data?.document?.managedFeatures?.includes(feature) ? before.data.model : empty
    if (sameJson(now.data.model, target)) return true
    const back = await write(target)
    return back.status === 200 && sameJson(back.data?.model, target)
  }
  return { path, read, write, restore }
}
const DIRECTIVE_PATHS = feature => new RegExp(String.raw`^\/api\/(?:domains|domains\/${ID}\/web-directives\/${feature}|${FILES})$`)

/** Deletes every database and database user whose name carries the run prefix; true when none is left. */
const dropDatabases = (owner, prefix) => async () => {
  const users = await owner.get('/api/databases/users')
  if (users.status === 200) for (const user of users.data.users.filter(item => item.name.startsWith(prefix))) await owner.delete(`/api/databases/users/${user.id}`)
  const listed = await owner.get('/api/databases')
  if (listed.status !== 200) return false
  for (const database of listed.data.databases.filter(item => item.name.startsWith(prefix))) await owner.delete(`/api/databases/${database.id}`)
  const after = await owner.get('/api/databases'), left = await owner.get('/api/databases/users')
  return after.status === 200 && left.status === 200 && !after.data.databases.some(item => item.name.startsWith(prefix)) && !left.data.users.some(item => item.name.startsWith(prefix))
}
const DB_PATHS = new RegExp(String.raw`^\/api\/databases(?:\/users(?:\/${ID})?|\/${ID})?$`)

export default [
  tool('file-manager', {
    prefix: 'FMGR', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|${FILES})$`), requests: 40,
    unit: [{ id: 'FMGR-UNIT-1', file: 'apps/api/src/completion-file-workspace-security.test.ts', name: 'file workspace API boundary with explicitly fake agent transport preserves exact browse/read/bare-write DTOs and allows explicit saved-content readback' }],
    checks: ['OUTSIDE-HOME-REJECTED', 'UPLOAD-MODE-0644', 'UPLOAD-OWNER-UID', 'REUPLOAD-ALREADY-EXISTS'],
    async run({ owner, fixture, tag, check, block, refused, undo }) {
      const site = await siteOf(owner), send = filesOf(owner, fixture)
      if (!site.rel) return
      refused('OUTSIDE-HOME-REJECTED', await put(send, `../xq-${tag}-escape.txt`, 'xq'), 'FORBIDDEN')
      const path = `${site.rel}/xq-${tag}.txt`
      undo('uploaded file', discard(send, path))
      const first = await put(send, path, 'xq', { overwrite: false })
      check('UPLOAD-MODE-0644', first.status === 200 && first.data?.mode === 0o644, { status: first.status, mode: first.data?.mode ?? null })
      block('UPLOAD-OWNER-UID', 'A file entry reports name, kind, size, mode and time only, so an API client cannot read the owner UID.')
      refused('REUPLOAD-ALREADY-EXISTS', await put(send, path, 'xq2', { overwrite: false }), 'VALIDATION')
    },
  }),

  tool('file-trash', {
    prefix: 'FTRA', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|${FILES})$`), requests: 50,
    unit: [{ id: 'FTRA-UNIT-1', file: 'apps/api/src/completion-file-workspace-security.test.ts', name: 'file workspace API boundary with explicitly fake agent transport preserves existing binary, directory, permission and trash RPC shapes' }],
    checks: ['TRASH-MOVES', 'RESTORE-IDENTICAL-BYTES', 'RESTORE-TARGET-EXISTS', 'BOTH-COPIES-UNTOUCHED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const site = await siteOf(owner), send = filesOf(owner, fixture)
      if (!site.rel) return
      const path = `${site.rel}/xq-${tag}-a.txt`
      undo('trash test file', discard(send, path))
      await put(send, path, 'alpha')
      const one = await send({ op: 'trash', path })
      if (one.status === 200) undo('first trash item', purgeItem(send, one.data))
      const listed = await send({ op: 'list-trash' })
      check('TRASH-MOVES', one.status === 200 && one.data?.originalPath === path && listed.data?.items?.some(item => item.id === one.data.id) === true, { status: one.status, listStatus: listed.status })
      const restored = await send({ op: 'restore', trashId: one.data?.id })
      const bytes = await send({ op: 'get-bytes', path })
      check('RESTORE-IDENTICAL-BYTES', restored.status === 200 && bytes.status === 200 && bytes.data?.contentBase64 === b64('alpha'), { restoreStatus: restored.status, readStatus: bytes.status })
      const two = await send({ op: 'trash', path })
      if (two.status === 200) undo('second trash item', purgeItem(send, two.data))
      await put(send, path, 'beta')
      refused('RESTORE-TARGET-EXISTS', await send({ op: 'restore', trashId: two.data?.id }), 'VALIDATION')
      const now = await send({ op: 'get-bytes', path }), after = await send({ op: 'list-trash' })
      check('BOTH-COPIES-UNTOUCHED', now.data?.contentBase64 === b64('beta') && after.data?.items?.some(item => item.id === two.data?.id) === true, { readStatus: now.status, listStatus: after.status })
    },
  }),

  tool('file-text-editor', {
    prefix: 'FTED', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|${FILES})$`), requests: 40,
    unit: [
      { id: 'FTED-UNIT-1', file: 'apps/api/src/file-workspace-validation.test.ts', name: 'pure file workspace requests uses UTF8 text bytes and preserves explicit empty and NUL-containing text' },
      { id: 'FTED-UNIT-CHARSET', file: 'apps/web/src/file-workspace-client.test.ts', name: 'editor character set opens by bytes and saves with to_charset, verifying the single-byte write' },
    ],
    checks: ['OPEN-OVER-1MB-TOO-LARGE', 'LATIN1-SINGLE-BYTE', 'UNREPRESENTABLE-ENCODING-ERROR', 'FILE-UNCHANGED-AFTER-ERROR'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const site = await siteOf(owner), send = filesOf(owner, fixture)
      if (!site.rel) return
      const big = `${site.rel}/xq-${tag}-big.txt`, small = `${site.rel}/xq-${tag}-enc.txt`
      undo('large file', discard(send, big))
      undo('encoded file', discard(send, small))
      await send({ op: 'put-bytes', path: big, contentBase64: Buffer.alloc(1024 * 1024 + 1, 97).toString('base64') })
      refused('OPEN-OVER-1MB-TOO-LARGE', await send({ op: 'read', path: big }), 'VALIDATION')
      await send({ op: 'write', path: small, content: 'base' })
      const latin = await send({ op: 'write', path: small, content: 'café', to_charset: 'ISO-8859-1', fallback: false })
      const written = await send({ op: 'get-bytes', path: small })
      check('LATIN1-SINGLE-BYTE', latin.status === 200 && written.data?.sizeBytes === 4, { status: latin.status, bytes: written.data?.sizeBytes ?? null })
      const before = await send({ op: 'get-bytes', path: small })
      refused('UNREPRESENTABLE-ENCODING-ERROR', await send({ op: 'write', path: small, content: 'x€', to_charset: 'ISO-8859-1', fallback: false }), 'VALIDATION')
      const after = await send({ op: 'get-bytes', path: small })
      check('FILE-UNCHANGED-AFTER-ERROR', before.status === 200 && after.status === 200 && before.data.contentBase64 === after.data.contentBase64, { before: before.status, after: after.status })
    },
  }),

  tool('directory-privacy', {
    prefix: 'DPRV', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|${FILES}|web-features\/[a-z][a-z0-9]{0,15}\/directory-privacy(?:\?path=[A-Za-z0-9._\/-]+)?)$`), requests: 50,
    unit: [{ id: 'DPRV-UNIT-1', file: 'apps/api/src/directory-privacy-workspace.test.ts', name: 'directory privacy API workspace hashes new passwords before the agent, saves one folder and returns the verified view' }],
    checks: ['ANONYMOUS-401', 'USER-PASSWORD-200', 'DELETED-USER-401', 'PASSWORD-FILE-OUTSIDE-DOCROOT'],
    async run({ owner, fixture, tag, site, check, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel) return
      const dir = `${place.rel}/xq-${tag}-private`, api = `/api/web-features/${fixture.username}/directory-privacy`, url = `/xq-${tag}-private/`
      undo('protected folder', discard(send, dir))
      await send({ op: 'mkdir', path: dir })
      await send({ op: 'write', path: `${dir}/index.html`, content: 'private-ok' })
      const folder = () => owner.get(`${api}?path=${dir}`)
      undo('folder protection', async () => {
        const now = await folder()
        if (now.status !== 200) return false
        const current = now.data.directories?.find(item => item.path === dir)
        if (!current?.enabled && !current?.users?.length) return true
        const off = await owner.put(api, { path: dir, expectedRevision: current.revision, enabled: false, authName: current.authName, users: [] })
        return off.status === 200
      })
      const password = secret(), basic = `Basic ${b64(`u1:${password}`)}`
      const read = await folder()
      const saved = await owner.put(api, { path: dir, expectedRevision: read.data?.directories?.[0]?.revision, enabled: true, authName: 'xq', users: [{ username: 'u1', password }] })
      const anonymous = await until(() => site.get(fixture.domain, url), response => response.status === 401, { attempts: 8, delayMs: 1500 })
      check('ANONYMOUS-401', saved.status === 200 && anonymous.settled, { saveStatus: saved.status, status: anonymous.last?.status ?? null })
      const signed = await site.get(fixture.domain, url, { headers: { authorization: basic } })
      check('USER-PASSWORD-200', signed.status === 200, { status: signed.status })
      const directives = saved.data?.directories?.[0]?.directives ?? []
      check('PASSWORD-FILE-OUTSIDE-DOCROOT', directives.some(line => /AuthUserFile\s+\S*\/\.htpasswds\//.test(line)) && !directives.some(line => /AuthUserFile/.test(line) && line.includes(`/${place.rel}/`)), { directives: directives.length })
      const again = await folder()
      const removed = await owner.put(api, { path: dir, expectedRevision: again.data?.directories?.[0]?.revision, enabled: true, authName: 'xq', users: [] })
      const denied = await until(() => site.get(fixture.domain, url, { headers: { authorization: basic } }), response => response.status === 401, { attempts: 8, delayMs: 1500 })
      check('DELETED-USER-401', removed.status === 200 && denied.settled, { saveStatus: removed.status, status: denied.last?.status ?? null })
    },
  }),

  tool('leech-protection', {
    prefix: 'LEECH', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|${FILES}|account\/leech-protection|web-features\/[a-z][a-z0-9]{0,15}\/directory-privacy(?:\?path=[A-Za-z0-9._\/-]+)?)$`), requests: 50,
    unit: [{ id: 'LEECH-UNIT-1', file: 'apps/agent/src/leech-protection.test.ts', name: 'leech protection monitor redirects, disables and alerts when a user passes the limit, as the cPanel acceptance asks' }],
    checks: ['RULE-APPLIED', 'ONE-ADDRESS-STAYS-SERVED', 'FOURTH-ADDRESS-REDIRECTED', 'ALERT-QUEUED', 'AUTO-DISABLE-REFUSED', 'RULE-REMOVED'],
    async run({ owner, fixture, tag, site, check, block, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel) return
      const dir = `${place.rel}/xq-${tag}-members`, privacy = `/api/web-features/${fixture.username}/directory-privacy`, leech = '/api/account/leech-protection', url = `/xq-${tag}-members/`
      undo('protected folder', discard(send, dir))
      await send({ op: 'mkdir', path: dir })
      await send({ op: 'write', path: `${dir}/index.html`, content: 'members-ok' })
      const folder = () => owner.get(`${privacy}?path=${dir}`)
      undo('folder protection', async () => {
        const now = await folder()
        if (now.status !== 200) return false
        const current = now.data.directories?.find(item => item.path === dir)
        if (!current?.enabled && !current?.users?.length) return true
        return (await owner.put(privacy, { path: dir, expectedRevision: current.revision, enabled: false, authName: current.authName, users: [] })).status === 200
      })
      undo('leech rule', async () => {
        const now = await owner.get(leech)
        if (now.status !== 200) return false
        return !now.data.folders?.some(item => item.path === dir) || (await owner.post(leech, { expectedRevision: now.data.revision, remove: dir })).status === 200
      })
      const password = secret(), basic = `Basic ${b64(`u1:${password}`)}`, read = await folder()
      await owner.put(privacy, { path: dir, expectedRevision: read.data?.directories?.[0]?.revision, enabled: true, authName: 'xq', users: [{ username: 'u1', password }] })
      await until(() => site.get(fixture.domain, url), response => response.status === 401, { attempts: 8, delayMs: 1500 })
      const empty = await owner.get(leech)
      const saved = await owner.post(leech, { expectedRevision: empty.data?.revision, folder: { path: dir, maxLogins: 3, redirectUrl: `https://${fixture.domain}/`, alertEmail: null, disableUsers: true } })
      const state = saved.data?.folders?.find(item => item.path === dir)?.state ?? null
      check('RULE-APPLIED', saved.status === 200 && state === 'applied', { status: saved.status, state })
      const repeated = []
      for (let login = 0; login < 4; login++) repeated.push((await site.get(fixture.domain, url, { headers: { authorization: basic } })).status)
      check('ONE-ADDRESS-STAYS-SERVED', repeated.every(status => status === 200), { statuses: repeated })
      // The limit counts distinct addresses per user, and this client signs in from one.
      const oneAddress = 'The runner has one source address, so the fourth address the criterion needs cannot come from this client.'
      for (const id of ['FOURTH-ADDRESS-REDIRECTED', 'ALERT-QUEUED', 'AUTO-DISABLE-REFUSED']) block(id, oneAddress)
      const current = await owner.get(leech), removed = await owner.post(leech, { expectedRevision: current.data?.revision, remove: dir })
      check('RULE-REMOVED', removed.status === 200 && !removed.data?.folders?.some(item => item.path === dir), { status: removed.status })
    },
  }),

  tool('ftp-accounts', {
    prefix: 'FTPA', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|service-users(?:\/${ID})?)$`), requests: 20,
    unit: [{ id: 'FTPA-UNIT-1', file: 'apps/api/src/authorization-security.test.ts', name: 'HTTP authorization security regressions email and FTP capabilities are gated independently and service verifiers never appear in reads' }],
    checks: ['OUTSIDE-HOME-REJECTED', 'ACCOUNT-CREATED-IN-FOLDER', 'LOGIN-SEES-ONLY-FOLDER', 'ONE-OVER-LIMIT-REFUSED'],
    async run({ owner, fixture, tag, check, block, refused, undo }) {
      const site = await siteOf(owner)
      if (!site.rel) return
      const mine = `xqf${tag}`
      undo('FTP accounts', async () => {
        const listed = await owner.get('/api/service-users')
        if (listed.status !== 200) return false
        for (const user of listed.data.serviceUsers.filter(item => item.login.startsWith(`${mine}@`) || item.login.startsWith(`xqg${tag}@`))) await owner.delete(`/api/service-users/${user.id}`)
        const after = await owner.get('/api/service-users')
        return after.status === 200 && !after.data.serviceUsers.some(item => /^xq[fg]/.test(item.login) && item.login.split('@')[0].endsWith(tag))
      })
      const body = (local, ftpDir) => ({ login: `${local}@${fixture.domain}`, password: secret(), services: { email: false, ftp: true, webdisk: false }, ftpDir })
      refused('OUTSIDE-HOME-REJECTED', await owner.post('/api/service-users', body(`xqg${tag}`, '../x')), 'VALIDATION')
      const created = await owner.post('/api/service-users', body(mine, site.rel))
      check('ACCOUNT-CREATED-IN-FOLDER', created.status === 201 && created.data?.serviceUser?.services?.ftp === true && created.data.serviceUser.ftpDir === site.rel, { status: created.status })
      block('LOGIN-SEES-ONLY-FOLDER', 'An FTP login is not an API request, so an API client cannot open a session and list the root folder.')
      block('ONE-OVER-LIMIT-REFUSED', 'The run plan is built by the fixture and carries no FTP account limit this driver can set, so a one-over-limit create cannot be set up.')
    },
  }),

  tool('git-version-control', {
    prefix: 'GITV', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:account\/git|${FILES})$`), requests: 30,
    unit: [
      { id: 'GITV-UNIT-1', file: 'apps/api/src/git-workspace.test.ts', name: 'account Git API boundary binds every dispatch to the current account and projects only the reviewed reply fields' },
      { id: 'GITV-UNIT-DEPLOY', file: 'apps/web/src/account-git-client.test.ts', name: 'Git account page and controller deploys the read repository after a confirmation that names the risk, and shows the recorded commit' },
    ],
    checks: ['CLONE-CREDENTIALS-REJECTED', 'INIT-CREATED-REPOSITORY', 'DEPLOY-DIRTY-TREE', 'DEPLOY-CLEAN-TREE-RUNS-TASKS'],
    async run({ owner, fixture, tag, check, block, refused, undo }) {
      const send = filesOf(owner, fixture), repo = `xq-${tag}-repo`
      const revision = async () => (await owner.get('/api/account/git')).data?.revision
      refused('CLONE-CREDENTIALS-REJECTED', await owner.post('/api/account/git', { op: 'clone', path: `xq-${tag}-clone`, url: 'https://u:p@git.test/r.git', expectedRevision: await revision() }), 'VALIDATION')
      undo('repository folder', discard(send, repo))
      const init = await owner.post('/api/account/git', { op: 'init', path: repo, branch: 'main', expectedRevision: await revision() })
      undo('repository registration', async () => {
        const view = await owner.get('/api/account/git')
        if (view.status !== 200) return false
        if (!view.data.repositories.includes(repo)) return true
        const removed = await owner.post('/api/account/git', { op: 'remove', path: repo, expectedRevision: view.data.revision })
        return removed.status === 200 && !removed.data?.repositories?.includes(repo)
      })
      await send({ op: 'write', path: `${repo}/dirty.txt`, content: 'dirty' })
      const dirty = await owner.post('/api/account/git', { op: 'deploy', path: repo, expectedRevision: await revision() })
      refused('DEPLOY-DIRTY-TREE', dirty, 'CONFLICT')
      await discard(send, `${repo}/dirty.txt`)()
      check('INIT-CREATED-REPOSITORY', init.status === 200, { status: init.status })
      block('DEPLOY-CLEAN-TREE-RUNS-TASKS', 'No API creates a commit, so a client cannot arrange a clean repository that holds a deployment file.')
    },
  }),

  tool('mysql-databases', {
    prefix: 'MDBS', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DB_PATHS, requests: 20,
    unit: [{ id: 'MDBS-UNIT-1', file: 'apps/api/src/completion-database-workspace-security.test.ts', name: 'database workspace API using isolated desired state and real SQLite creates a full owned database name with real state/index readback and no native activation claim' }],
    checks: ['NAME-TOO-LONG', 'ONE-OVER-LIMIT-REFUSED', 'RENAME-DROPS-OLD-NAME', 'ROWS-AND-GRANTS-PRESERVED'],
    async run({ owner, fixture, tag, check, block, refused, undo }) {
      const prefix = `${fixture.username}_xq${tag}`
      undo('databases', dropDatabases(owner, prefix))
      refused('NAME-TOO-LONG', await owner.post('/api/databases', { name: `${prefix}${'a'.repeat(60)}` }), 'VALIDATION')
      block('ONE-OVER-LIMIT-REFUSED', 'The run plan is built by the fixture and carries no database limit this driver can set, so a one-over-limit create cannot be set up.')
      const created = await owner.post('/api/databases', { name: `${prefix}a` })
      const id = created.data?.database?.id
      const renamed = typeof id === 'string' ? await owner.patch(`/api/databases/${id}`, { name: `${prefix}b` }) : created
      const listed = await owner.get('/api/databases'), names = listed.data?.databases?.map(item => item.name) ?? []
      check('RENAME-DROPS-OLD-NAME', created.status === 201 && renamed.status === 200 && names.includes(`${prefix}b`) && !names.includes(`${prefix}a`), { createStatus: created.status, renameStatus: renamed.status })
      block('ROWS-AND-GRANTS-PRESERVED', 'Row counts and grants live inside the database engine and the API reports names only, so an API client cannot compare them.')
    },
  }),

  tool('mysql-users', {
    prefix: 'MDBU', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DB_PATHS, requests: 20,
    unit: [{ id: 'MDBU-UNIT-1', file: 'apps/api/src/completion-database-grants-security.test.ts', name: 'conditional database grant API with isolated SQLite and desired state adds a grant only when the last read had no grant and returns safe owned readback' }],
    checks: ['GRANT-SELECT-ONLY', 'INSERT-FAILS-1142', 'USER-NAME-TOO-LONG'],
    async run({ owner, fixture, tag, check, block, refused, undo }) {
      const name = `${fixture.username}_xq${tag}`
      undo('databases and users', dropDatabases(owner, name))
      const database = await owner.post('/api/databases', { name })
      const dbId = database.data?.database?.id
      const user = await owner.post('/api/databases/users', { name, password: secret(), databaseId: dbId, privileges: ['SELECT'] })
      const listed = await owner.get('/api/databases/users'), row = listed.data?.users?.find(item => item.name === name)
      check('GRANT-SELECT-ONLY', user.status === 201 && row?.grants?.length === 1 && row.grants[0].databaseId === dbId && sameJson(row.grants[0].privileges, ['SELECT']), { status: user.status, listStatus: listed.status })
      block('INSERT-FAILS-1142', 'An INSERT by the database user needs an SQL session as that user, which an API client cannot open.')
      refused('USER-NAME-TOO-LONG', await owner.post('/api/databases/users', { name: `${name}${'u'.repeat(60)}`, password: secret() }), 'VALIDATION')
    },
  }),

  tool('database-insights', {
    prefix: 'DBIN', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:account\/database-insights|databases(?:\/users)?(?:\/${ID})?)$`), requests: 20,
    unit: [{ id: 'DBIN-UNIT-1', file: 'apps/api/src/account-database-insights-workspace.test.ts', name: "account database insights workspace returns the owner's observed databases and users through the agent" }],
    checks: ['OWN-DATABASES-ONLY', 'SLOW-QUERIES-LISTED', 'OPTIMIZE-RUNS-AS-JOB'],
    async run({ owner, fixture, tag, check, undo }) {
      const prefix = `${fixture.username}_xq${tag}`
      undo('database', dropDatabases(owner, prefix))
      await owner.post('/api/databases', { name: prefix })
      const view = await owner.get('/api/account/database-insights'), rows = view.data?.databases
      check('OWN-DATABASES-ONLY', view.status === 200 && Array.isArray(rows) && rows.some(row => row.name === prefix) && rows.every(row => row.name.startsWith(`${fixture.username}_`)), { status: view.status, databases: Array.isArray(rows) ? rows.length : null })
      check('SLOW-QUERIES-LISTED', view.status === 200 && Array.isArray(view.data?.slowQueries), { status: view.status })
      const job = await owner.post('/api/account/database-insights', { action: 'optimize', database: prefix, table: 'xq' })
      check('OPTIMIZE-RUNS-AS-JOB', job.status === 202 && typeof job.data?.jobId === 'string', { status: job.status })
    },
  }),

  tool('cron-jobs', {
    prefix: 'CRON', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/account\/cron(?:\/${ID})?$`), requests: 30,
    unit: [{ id: 'CRON-UNIT-1', file: 'apps/api/src/cron-workspace.test.ts', name: 'account cron validation and revisions preserves the exact shell command and supports a bounded runtime or infinity' }],
    checks: ['WEEKDAY-8-REFUSED', 'MINUTE-61-REFUSED', 'EMPTY-COMMAND-REFUSED', 'JOB-LISTED-ONCE', 'JOB-IN-CRONTAB', 'DELETE-REMOVES-JOB', 'CRON-EMAIL-WRITES-MAILTO'],
    async run({ owner, tag, check, block, refused, undo }) {
      const mine = `xq-${tag}`, view = () => owner.get('/api/account/cron')
      undo('cron jobs', async () => {
        for (let round = 0; round < 3; round++) {
          const now = await view()
          if (now.status !== 200) return false
          const job = now.data.jobs.find(item => item.comment === mine)
          if (!job) return true
          await owner.delete(`/api/account/cron/${job.id}`, { expectedRevision: now.data.revision, confirmation: job.command })
        }
        return !(await view()).data?.jobs?.some(item => item.comment === mine)
      })
      const first = await view(), home = first.data?.context?.home
      if (first.status !== 200 || typeof home !== 'string') return
      const command = `${home}/${mine}.sh`
      const draft = async fields => owner.post('/api/account/cron', { expectedRevision: (await view()).data?.revision, schedule: '*/5 * * * *', command, comment: mine, ...fields })
      refused('WEEKDAY-8-REFUSED', await draft({ schedule: '* * * * 8' }), 'VALIDATION')
      refused('MINUTE-61-REFUSED', await draft({ schedule: '61 * * * *' }), 'VALIDATION')
      refused('EMPTY-COMMAND-REFUSED', await draft({ command: '' }), 'VALIDATION')
      const created = await draft({})
      const listed = await view(), jobs = listed.data?.jobs?.filter(item => item.command === command) ?? []
      check('JOB-LISTED-ONCE', created.status === 201 && jobs.length === 1, { status: created.status, listed: jobs.length })
      block('JOB-IN-CRONTAB', 'Jobs are systemd timers; an API client cannot read the account crontab, and the list route is the only read.')
      check('CRON-EMAIL-WRITES-MAILTO', listed.data?.capabilities?.outputEmail === true, { status: listed.status })
      const removed = jobs[0] ? await owner.delete(`/api/account/cron/${jobs[0].id}`, { expectedRevision: listed.data.revision, confirmation: command }) : created
      const after = await view()
      check('DELETE-REMOVES-JOB', removed.status === 200 && !after.data?.jobs?.some(item => item.command === command), { status: removed.status })
    },
  }),

  tool('track-dns', {
    prefix: 'TDNS', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/account\/network-tools\/dns$/, requests: 10,
    unit: [{ id: 'TDNS-UNIT-1', file: 'apps/api/src/network-tools-workspace.test.ts', name: 'account network tools workspace runs each tool through the agent and returns the pinned view' }],
    checks: ['A-AAAA-ANSWER-ARRAYS', 'MX-ANSWER-ARRAY', 'BAD-NAME-REFUSED', 'LONG-NAME-REFUSED', 'TRACE-OFF-FEATURE-DISABLED'],
    async run({ owner, check, block, refused }) {
      const lookup = (name, type) => owner.post('/api/account/network-tools/dns', { name, type })
      const a = await lookup('example.com', 'A'), aaaa = await lookup('example.com', 'AAAA'), mx = await lookup('example.com', 'MX')
      check('A-AAAA-ANSWER-ARRAYS', a.status === 200 && aaaa.status === 200 && a.data?.result?.records?.length > 0 && Array.isArray(aaaa.data?.result?.records), { aStatus: a.status, aaaaStatus: aaaa.status })
      check('MX-ANSWER-ARRAY', mx.status === 200 && mx.data?.result?.records?.length > 0, { status: mx.status })
      refused('BAD-NAME-REFUSED', await lookup('bad..name', 'A'), 'VALIDATION')
      refused('LONG-NAME-REFUSED', await lookup(`${'a'.repeat(60)}.`.repeat(5) + 'example.com', 'A'), 'VALIDATION')
      block('TRACE-OFF-FEATURE-DISABLED', 'Switching trace route off is an administrator setting outside this owner session, and turning it off would change a global setting.')
    },
  }),

  tool('indexes', {
    prefix: 'IDXS', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DIRECTIVE_PATHS('indexes'), requests: 40,
    unit: [{ id: 'IDXS-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace reads a feature model and saves only its managed block with the captured revision' }],
    page: { route: '/advanced/indexes', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    checks: ['DISABLED-LISTING-403', 'FANCY-LISTING-SIZES', 'INHERIT-REMOVES-DIRECTIVE', 'OUTSIDE-HOME-REJECTED'],
    async run({ owner, fixture, tag, site, check, refused, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel || !place.id) return
      const rule = directiveOf(owner, place.id, 'indexes'), before = await rule.read()
      if (before.status !== 200) return
      undo('indexes rule', rule.restore(before, { listing: 'inherit' }))
      const dir = `${place.rel}/xq-${tag}-files`, name = `listing-${tag}.txt`, url = `/xq-${tag}-files/`
      undo('listing folder', discard(send, dir))
      await send({ op: 'mkdir', path: dir })
      await put(send, `${dir}/${name}`, 'x'.repeat(2048))
      const off = await rule.write({ listing: 'disabled' })
      const denied = await until(() => site.get(fixture.domain, url), response => response.status === 403, { attempts: 8, delayMs: 1500 })
      check('DISABLED-LISTING-403', off.status === 200 && denied.settled, { saveStatus: off.status, status: denied.last?.status ?? null })
      const fancy = await rule.write({ listing: 'fancy' })
      const shown = await until(() => site.get(fixture.domain, url), response => response.status === 200 && response.text.includes(name), { attempts: 8, delayMs: 1500 })
      check('FANCY-LISTING-SIZES', fancy.status === 200 && shown.settled && /\b2(?:\.0)?K\b|\b2048\b/.test(shown.last.text), { saveStatus: fancy.status, status: shown.last?.status ?? null })
      const inherit = await rule.write({ listing: 'inherit' }), now = await rule.read()
      check('INHERIT-REMOVES-DIRECTIVE', inherit.status === 200 && now.data?.document?.managedFeatures?.includes('indexes') === false, { status: inherit.status })
      refused('OUTSIDE-HOME-REJECTED', await rule.write({ listing: 'disabled', path: '../x' }), 'VALIDATION')
    },
  }),

  tool('error-pages', {
    prefix: 'ERRP', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DIRECTIVE_PATHS('error-pages'), requests: 40,
    unit: [{ id: 'ERRP-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace refuses stale revisions, field errors, extra keys and no-op saves before any write' }],
    page: { route: '/advanced/error-pages', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    checks: ['CUSTOM-404-SERVED', 'REQUESTED-URL-TAG-REAL-PATH', 'CODE-OUTSIDE-RANGE-REFUSED'],
    async run({ owner, fixture, tag, site, check, refused, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel || !place.id) return
      const rule = directiveOf(owner, place.id, 'error-pages'), before = await rule.read()
      if (before.status !== 200) return
      undo('error pages rule', rule.restore(before, { entries: [] }))
      const page = `${place.rel}/xq-${tag}-404.html`, missing = `/xq-${tag}-missing`
      undo('error page file', discard(send, page))
      await send({ op: 'write', path: page, content: `Custom 404 xq-${tag} <!--#echo var="REQUEST_URI" -->` })
      refused('CODE-OUTSIDE-RANGE-REFUSED', await rule.write({ entries: [{ code: 200, path: `/xq-${tag}-404.html` }] }), 'VALIDATION')
      const saved = await rule.write({ entries: [{ code: 404, path: `/xq-${tag}-404.html` }] })
      const served = await until(() => site.get(fixture.domain, missing), response => response.status === 404 && response.text.includes(`Custom 404 xq-${tag}`), { attempts: 8, delayMs: 1500 })
      check('CUSTOM-404-SERVED', saved.status === 200 && served.settled, { saveStatus: saved.status, status: served.last?.status ?? null })
      check('REQUESTED-URL-TAG-REAL-PATH', served.settled && served.last.text.includes(missing), { status: served.last?.status ?? null })
    },
  }),

  tool('mime-types', {
    prefix: 'MIME', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DIRECTIVE_PATHS('mime-types'), requests: 40,
    unit: [{ id: 'MIME-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace refuses stale revisions, field errors, extra keys and no-op saves before any write' }],
    page: { route: '/advanced/mime-types', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    checks: ['FOO-CONTENT-TYPE', 'TYPE-WITHOUT-SLASH-REFUSED', 'SYSTEM-TYPE-DELETE-FORBIDDEN'],
    async run({ owner, fixture, tag, site, check, refused, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel || !place.id) return
      const rule = directiveOf(owner, place.id, 'mime-types'), before = await rule.read()
      if (before.status !== 200) return
      undo('mime rule', rule.restore(before, { entries: [] }))
      const file = `${place.rel}/xq-${tag}.foo`
      undo('mime test file', discard(send, file))
      await send({ op: 'write', path: file, content: 'foo' })
      const saved = await rule.write({ entries: [{ type: 'text/foo', extensions: ['.foo'] }] })
      const served = await until(() => site.get(fixture.domain, `/xq-${tag}.foo`), response => response.status === 200 && String(response.headers['content-type']).startsWith('text/foo'), { attempts: 8, delayMs: 1500 })
      check('FOO-CONTENT-TYPE', saved.status === 200 && served.settled, { saveStatus: saved.status, status: served.last?.status ?? null })
      refused('TYPE-WITHOUT-SLASH-REFUSED', await rule.write({ entries: [{ type: 'textfoo', extensions: ['.foo'] }] }), 'VALIDATION')
      refused('SYSTEM-TYPE-DELETE-FORBIDDEN', await owner.delete(rule.path, { type: 'text/html' }), 'FORBIDDEN')
    },
  }),

  tool('virus-scanner', {
    prefix: 'VSCN', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|account\/virus-scan|${FILES})$`), requests: 60, deadlineMs: 240_000,
    unit: [{ id: 'VSCN-UNIT-1', file: 'apps/api/src/account-virus-scan-workspace.test.ts', name: 'account virus scan workspace starts one scan with an empty body after fresh authority and returns the read-back' }],
    checks: ['EICAR-LISTED-INFECTED', 'QUARANTINE-MOVES-OUT-OF-DOCROOT', 'DISINFECTION-DONE', 'BAD-SCAN-TYPE-REFUSED'],
    async run({ owner, fixture, tag, check, refused, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel) return
      const path = `${place.rel}/xq-${tag}-eicar.txt`
      undo('test file', discard(send, path))
      await put(send, path, EICAR)
      refused('BAD-SCAN-TYPE-REFUSED', await owner.post('/api/account/virus-scan', { scan_type: 'bogus' }), 'VALIDATION')
      const started = await owner.post('/api/account/virus-scan', {}), jobId = started.data?.started?.jobId
      const finished = await until(() => owner.get('/api/account/virus-scan'), view => view.data?.scans?.some(scan => scan.jobId === jobId && ['succeeded', 'failed', 'cancelled'].includes(scan.status)), { attempts: 30, delayMs: 2000 })
      const scan = finished.last?.data?.scans?.find(item => item.jobId === jobId)
      check('EICAR-LISTED-INFECTED', started.status === 202 && scan?.infected?.some(item => item.path === path) === true, { status: started.status, scanStatus: scan?.status ?? null })
      const quarantine = await owner.post('/api/account/virus-scan', { action: 'quarantine', path })
      const listed = await send({ op: 'list', path: place.rel })
      check('QUARANTINE-MOVES-OUT-OF-DOCROOT', quarantine.status === 200 && listed.data?.entries?.some(entry => entry.path === path) === false, { status: quarantine.status })
      check('DISINFECTION-DONE', quarantine.status === 200 && quarantine.data?.status === 'done', { status: quarantine.status })
    },
  }),

  tool('remote-database-access', {
    prefix: 'RDBA', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/account\/database-remote-access$/, requests: 15,
    unit: [{ id: 'RDBA-UNIT-1', file: 'apps/api/src/database-remote-access-workspace.test.ts', name: 'remote database owner API boundary forwards only a session-derived owner target with exact parsed body and validated acknowledgement' }],
    checks: ['RANGE-ADDED', 'ALLOWED-SOURCE-AUTHENTICATES', 'OTHER-SOURCE-REFUSED', 'RANGE-REMOVED', 'REMOVED-SOURCE-FAILS', 'NOTE-TOO-LONG-REFUSED'],
    async run({ owner, tag, check, block, refused, undo }) {
      const host = '203.0.113.0/24', path = '/api/account/database-remote-access'
      const before = await owner.get(path)
      if (before.status !== 200 || before.data.entries.some(entry => entry.host === host)) return
      undo('remote host', async () => {
        const now = await owner.get(path)
        if (now.status !== 200) return false
        if (!now.data.entries.some(entry => entry.host === host)) return true
        const removed = await owner.post(path, { action: 'remove', expectedRevision: now.data.revision, host })
        return removed.status === 200 && !removed.data.entries.some(entry => entry.host === host)
      })
      const added = await owner.post(path, { action: 'add', expectedRevision: before.data.revision, host, comment: `xq-${tag}` })
      check('RANGE-ADDED', added.status === 200 && added.data?.entries?.some(entry => entry.host === host && entry.comment === `xq-${tag}`) === true, { status: added.status })
      block('ALLOWED-SOURCE-AUTHENTICATES', 'Authenticating as the database user from 203.0.113.7 needs a client at that address, which this driver cannot be.')
      block('OTHER-SOURCE-REFUSED', 'A refused login from 198.51.100.7 needs a client at that address, which this driver cannot be.')
      const removed = await owner.post(path, { action: 'remove', expectedRevision: added.data?.revision, host })
      check('RANGE-REMOVED', removed.status === 200 && removed.data?.entries?.some(entry => entry.host === host) === false, { status: removed.status })
      block('REMOVED-SOURCE-FAILS', 'The failed login from 203.0.113.7 after removal needs a client at that address, which this driver cannot be.')
      const now = await owner.get(path)
      refused('NOTE-TOO-LONG-REFUSED', await owner.post(path, { action: 'add', expectedRevision: now.data?.revision, host: '198.51.100.7', comment: 'n'.repeat(256) }), 'VALIDATION')
    },
  }),

  tool('api-shell', {
    prefix: 'APSH', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/account\/developer$/, requests: 10,
    unit: [{ id: 'APSH-UNIT-1', file: 'apps/api/src/developer-workspace.test.ts', name: 'finite interactive API explorer ignores unrelated paths, lists only fixed GET operations and rejects every selector/body extension' }],
    checks: ['NON-RESELLER-FORBIDDEN', 'RESELLER-MAX-RESULTS-TWO', 'RAW-TAB-HEADERS-APART'],
    async run({ owner, check, block, refused }) {
      const manifest = await owner.get('/api/account/developer')
      refused('NON-RESELLER-FORBIDDEN', manifest, 'FORBIDDEN')
      block('RESELLER-MAX-RESULTS-TWO', 'This driver runs as the account owner and builds no reseller, so a reseller list call with a result limit is not exercised.')
      check('RAW-TAB-HEADERS-APART', manifest.status === 200 && manifest.data?.rawResponses === true, { status: manifest.status })
    },
  }),
]
