import { randomBytes } from 'node:crypto'
import { createAccount, safeResponse, tool } from './kit.mjs'

const secret = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const b64 = text => Buffer.from(text).toString('base64')
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const FILES = String.raw`accounts\/[a-z][a-z0-9]{0,15}\/files`
const ID = '[0-9a-f-]{36}', ACC = 'xq[0-9a-f]{8}[a-z]{1,2}'
const SCRATCH = ['feature-lists', `feature-lists/${ID}`, 'plans', `plans/${ID}`, 'accounts', `accounts/${ACC}`]
const CAPS = { addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8 }
const RESOURCES = { diskMb: 2048, bandwidthMbMonth: 10240, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 }
const gone = response => [200, 204, 404].includes(response.status)

let scratchSeq = 0
async function scratch(x, label, caps = {}) {
  const { root, tag, undo, signIn } = x
  const list = await root.post('/api/feature-lists', { name: `xq-${tag}-${label}`, ownerId: null, disabled: [] }), listId = list.data?.featureList?.id
  if (list.status !== 201 || typeof listId !== 'string') return null
  undo(`feature list ${label}`, async () => gone(await root.delete(`/api/feature-lists/${listId}`)))
  const plan = await root.post('/api/plans', { name: `xq-${tag}-${label}`, featureListId: listId, resources: RESOURCES, caps: { ...CAPS, ...caps } }), planId = plan.data?.plan?.id
  if (plan.status !== 201 || typeof planId !== 'string') return null
  undo(`plan ${label}`, async () => gone(await root.delete(`/api/plans/${planId}`)))
  const username = `xq${tag}${label}`, password = secret(), primary = `${username}.example.net`
  undo(`account ${label}`, async () => gone(await root.delete(`/api/accounts/${username}`, { confirmUsername: username })))
  const created = await createAccount(root, { username, password, primaryDomain: primary, planId }, { idempotencyKey: `xq-${tag}-${label}-${++scratchSeq}` }, x)
  if (!created.created || typeof created.data?.account?.id !== 'string') return null
  const session = await signIn('owner', { username, password })
  return session.client ? { client: session.client, id: created.data.account.id, username, primary } : null
}
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
    checks: ['OUTSIDE-HOME-REJECTED', 'UPLOAD-MODE-0640', 'UPLOAD-LISTED-AND-READABLE', 'REUPLOAD-ALREADY-EXISTS'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const site = await siteOf(owner), send = filesOf(owner, fixture)
      if (!site.rel) return
      refused('OUTSIDE-HOME-REJECTED', await put(send, `../xq-${tag}-escape.txt`, 'xq'), 'VALIDATION')
      const path = `${site.rel}/xq-${tag}.txt`
      undo('uploaded file', discard(send, path))
      const first = await put(send, path, 'xq', { overwrite: false })
      check('UPLOAD-MODE-0640', first.status === 200 && first.data?.mode === 0o640, { status: first.status, mode: first.data?.mode ?? null })
      const listed = await send({ op: 'list', path: site.rel }), readBack = await send({ op: 'read', path })
      check('UPLOAD-LISTED-AND-READABLE', first.status === 200 && listed.status === 200 && listed.data?.entries?.some(entry => entry.path === path && entry.sizeBytes === 2 && entry.mode === 0o640) === true && readBack.status === 200 && readBack.data?.content === 'xq', { listStatus: listed.status, readStatus: readBack.status })
      refused('REUPLOAD-ALREADY-EXISTS', await put(send, path, 'xq2', { overwrite: false }), 'CONFLICT')
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
      refused('RESTORE-TARGET-EXISTS', await send({ op: 'restore', trashId: two.data?.id }), 'CONFLICT')
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
      refused('OPEN-OVER-1MB-TOO-LARGE', await send({ op: 'read', path: big }), 'LIMIT_EXCEEDED')
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
    page: { route: '/files/directory-privacy', read: '/api/auth/me', shows: () => ['Directory privacy'] },
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
      const authFiles = directives.filter(line => /^AuthUserFile\s+/.test(line)).map(line => line.replace(/^AuthUserFile\s+/, '').replace(/^"|"$/g, ''))
      check('PASSWORD-FILE-OUTSIDE-DOCROOT', saved.status === 200 && authFiles.length > 0 && authFiles.every(file => file.startsWith(`/home/${fixture.username}/.htpasswds/`) && !file.startsWith(`/home/${fixture.username}/${place.rel}/`)), { directives: directives.length })
      const again = await folder()
      const removed = await owner.put(api, { path: dir, expectedRevision: again.data?.directories?.[0]?.revision, enabled: true, authName: 'xq', users: [] })
      const denied = await until(() => site.get(fixture.domain, url, { headers: { authorization: basic } }), response => response.status === 401, { attempts: 8, delayMs: 1500 })
      check('DELETED-USER-401', removed.status === 200 && denied.settled, { saveStatus: removed.status, status: denied.last?.status ?? null })
    },
  }),

  tool('leech-protection', {
    prefix: 'LEECH', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    page: { route: '/files/directory-privacy', read: '/api/auth/me', shows: () => ['Directory privacy'] },
    paths: new RegExp(String.raw`^\/api\/(?:domains|${FILES}|account\/leech-protection|web-features\/[a-z][a-z0-9]{0,15}\/directory-privacy(?:\?path=[A-Za-z0-9._\/-]+)?)$`), requests: 50,
    unit: [{ id: 'LEECH-UNIT-1', file: 'apps/agent/src/leech-protection.test.ts', name: 'leech protection monitor redirects, disables and alerts when a user passes the limit, as the cPanel acceptance asks' }],
    checks: ['RULE-APPLIED', 'ONE-ADDRESS-STAYS-SERVED', 'STALE-REVISION-CONFLICT', 'OUTSIDE-HOME-REFUSED', 'MISSING-FOLDER-REMOVE-REFUSED', 'RULE-REMOVED'],
    async run({ owner, fixture, tag, site, check, refused, undo, until }) {
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
      refused('STALE-REVISION-CONFLICT', await owner.post(leech, { expectedRevision: '0'.repeat(64), remove: dir }), 'CONFLICT')
      const mid = await owner.get(leech)
      refused('OUTSIDE-HOME-REFUSED', await owner.post(leech, { expectedRevision: mid.data?.revision, folder: { path: '../escape', maxLogins: 3, redirectUrl: `https://${fixture.domain}/`, alertEmail: null, disableUsers: true } }), 'VALIDATION')
      refused('MISSING-FOLDER-REMOVE-REFUSED', await owner.post(leech, { expectedRevision: mid.data?.revision, remove: `${place.rel}/xq-${tag}-absent` }), 'VALIDATION')
      const current = await owner.get(leech), removed = await owner.post(leech, { expectedRevision: current.data?.revision, remove: dir })
      check('RULE-REMOVED', removed.status === 200 && !removed.data?.folders?.some(item => item.path === dir), { status: removed.status })
    },
  }),

  tool('ftp-accounts', {
    prefix: 'FTPA', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|service-users(?:\/${ID})?|${SCRATCH.join('|')})$`), accounts: 1, requests: 50, deadlineMs: 300_000,
    unit: [{ id: 'FTPA-UNIT-1', file: 'apps/api/src/authorization-security.test.ts', name: 'HTTP authorization security regressions email and FTP capabilities are gated independently and service verifiers never appear in reads' }],
    checks: ['OUTSIDE-HOME-REJECTED', 'ACCOUNT-CREATED-IN-FOLDER', 'PORT-21-GREETING', 'ONE-OVER-LIMIT-REFUSED'],
    async run(x) {
      const { owner, fixture, tag, net, check, refused, undo } = x
      const site = await siteOf(owner)
      if (!site.rel) return
      const short = tag.slice(0, 4), mine = `f${short}`, bad = `g${short}`
      undo('FTP accounts', async () => {
        const listed = await owner.get('/api/service-users')
        if (listed.status !== 200) return false
        for (const user of listed.data.serviceUsers.filter(item => item.login.startsWith(`${mine}@`) || item.login.startsWith(`${bad}@`))) await owner.delete(`/api/service-users/${user.id}`)
        const after = await owner.get('/api/service-users')
        return after.status === 200 && !after.data.serviceUsers.some(item => item.login.startsWith(`${mine}@`) || item.login.startsWith(`${bad}@`))
      })
      const body = (local, ftpDir, dom = fixture.domain) => ({ login: `${local}@${dom}`, password: secret(), services: { email: false, ftp: true, webdisk: false }, ftpDir })
      refused('OUTSIDE-HOME-REJECTED', await owner.post('/api/service-users', body(bad, '../x')), 'VALIDATION')
      const created = await owner.post('/api/service-users', body(mine, site.rel))
      check('ACCOUNT-CREATED-IN-FOLDER', created.status === 201 && created.data?.serviceUser?.services?.ftp === true && created.data.serviceUser.ftpDir === site.rel, { status: created.status })
      const greeting = created.status === 201 ? await net.tcpBanner(21) : { ok: false, banner: '' }
      check('PORT-21-GREETING', created.status === 201 && greeting.ok && /^220[\s-]/.test(greeting.banner), { status: created.status, open: greeting.ok })
      const small = await scratch(x, 'ft', { ftpAccounts: 1 })
      if (!small) return check('ONE-OVER-LIMIT-REFUSED', false, { setup: false })
      const first = await small.client.post('/api/service-users', body('f1', 'public_html', small.primary))
      if (first.status === 201 && typeof first.data?.serviceUser?.id === 'string') undo('scratch ftp', async () => gone(await small.client.delete(`/api/service-users/${first.data.serviceUser.id}`)))
      if (first.status !== 201) return check('ONE-OVER-LIMIT-REFUSED', false, safeResponse(first))
      refused('ONE-OVER-LIMIT-REFUSED', await small.client.post('/api/service-users', body('f2', 'public_html', small.primary)), 'LIMIT_EXCEEDED')
    },
  }),

  tool('git-version-control', {
    prefix: 'GITV', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:account\/git|${FILES})$`), requests: 30,
    unit: [
      { id: 'GITV-UNIT-1', file: 'apps/api/src/git-workspace.test.ts', name: 'account Git API boundary binds every dispatch to the current account and projects only the reviewed reply fields' },
      { id: 'GITV-UNIT-DEPLOY', file: 'apps/web/src/account-git-client.test.ts', name: 'Git account page and controller deploys the read repository after a confirmation that names the risk, and shows the recorded commit' },
    ],
    checks: ['CLONE-CREDENTIALS-REJECTED', 'INIT-CREATED-REPOSITORY', 'DEPLOY-DIRTY-TREE', 'DEPLOY-EMPTY-BRANCH-REFUSED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
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
      check('INIT-CREATED-REPOSITORY', init.status === 200 && init.data?.selected?.branch === 'main', { status: init.status })
      refused('DEPLOY-EMPTY-BRANCH-REFUSED', await owner.post('/api/account/git', { op: 'deploy', path: repo, expectedRevision: await revision() }), 'PRECONDITION_FAILED')
    },
  }),

  tool('mysql-databases', {
    prefix: 'MDBS', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:databases(?:\/users(?:\/${ID})?|\/${ID}(?:\/rename)?)?|${SCRATCH.join('|')})$`), accounts: 1, requests: 50, deadlineMs: 300_000,
    unit: [{ id: 'MDBS-UNIT-1', file: 'apps/api/src/completion-database-workspace-security.test.ts', name: 'database workspace API using isolated desired state and real SQLite creates a full owned database name with real state/index readback and no native activation claim' }],
    checks: ['NAME-TOO-LONG', 'ONE-OVER-LIMIT-REFUSED', 'RENAME-DROPS-OLD-NAME', 'GRANTS-PRESERVED-ON-RENAME'],
    async run(x) {
      const { owner, fixture, tag, check, refused, undo } = x
      const prefix = `${fixture.username}_xq${tag}`
      undo('databases', dropDatabases(owner, prefix))
      refused('NAME-TOO-LONG', await owner.post('/api/databases', { name: `${prefix}${'a'.repeat(60)}` }), 'VALIDATION')
      const small = await scratch(x, 'db', { databases: 1 })
      if (small) {
        undo('scratch databases', dropDatabases(small.client, `${small.username}_d`))
        const first = await small.client.post('/api/databases', { name: `${small.username}_d1` })
        if (first.status === 201) refused('ONE-OVER-LIMIT-REFUSED', await small.client.post('/api/databases', { name: `${small.username}_d2` }), 'LIMIT_EXCEEDED')
        else check('ONE-OVER-LIMIT-REFUSED', false, safeResponse(first))
      } else check('ONE-OVER-LIMIT-REFUSED', false, { setup: false })
      const created = await owner.post('/api/databases', { name: `${prefix}a` })
      const id = created.data?.database?.id
      const granted = typeof id === 'string' ? await owner.post('/api/databases/users', { name: `${prefix}u`, password: secret(), databaseId: id, privileges: ['SELECT'] }) : created
      const renamed = typeof id === 'string' ? await owner.post(`/api/databases/${id}/rename`, { name: `${prefix}b` }) : created
      const listed = await owner.get('/api/databases'), names = listed.data?.databases?.map(item => item.name) ?? []
      check('RENAME-DROPS-OLD-NAME', created.status === 201 && renamed.status === 200 && names.includes(`${prefix}b`) && !names.includes(`${prefix}a`), { createStatus: created.status, renameStatus: renamed.status })
      const users = await owner.get('/api/databases/users'), holder = users.data?.users?.find(item => item.name === `${prefix}u`)
      check('GRANTS-PRESERVED-ON-RENAME', granted.status === 201 && renamed.status === 200 && holder?.grants?.some(grant => grant.databaseId === id && sameJson(grant.privileges, ['SELECT'])) === true, { userStatus: granted.status, listStatus: users.status })
    },
  }),

  tool('mysql-users', {
    prefix: 'MDBU', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DB_PATHS, requests: 20,
    unit: [{ id: 'MDBU-UNIT-1', file: 'apps/api/src/completion-database-grants-security.test.ts', name: 'conditional database grant API with isolated SQLite and desired state adds a grant only when the last read had no grant and returns safe owned readback' }],
    checks: ['GRANT-SELECT-ONLY', 'INVALID-PRIVILEGE-REFUSED', 'USER-NAME-TOO-LONG'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const name = `${fixture.username}_xq${tag}`
      undo('databases and users', dropDatabases(owner, name))
      const database = await owner.post('/api/databases', { name })
      const dbId = database.data?.database?.id
      const user = await owner.post('/api/databases/users', { name, password: secret(), databaseId: dbId, privileges: ['SELECT'] })
      const listed = await owner.get('/api/databases/users'), row = listed.data?.users?.find(item => item.name === name)
      check('GRANT-SELECT-ONLY', user.status === 201 && row?.grants?.length === 1 && row.grants[0].databaseId === dbId && sameJson(row.grants[0].privileges, ['SELECT']), { status: user.status, listStatus: listed.status })
      refused('INVALID-PRIVILEGE-REFUSED', await owner.post('/api/databases/users', { name: `${name}b`, password: secret(), databaseId: dbId, privileges: ['SUPER'] }), 'VALIDATION')
      refused('USER-NAME-TOO-LONG', await owner.post('/api/databases/users', { name: `${name}${'u'.repeat(60)}`, password: secret() }), 'VALIDATION')
    },
  }),

  tool('database-insights', {
    prefix: 'DBIN', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:account\/database-insights(?:\?database=xq)?|databases(?:\/users)?(?:\/${ID})?)$`), requests: 20,
    unit: [{ id: 'DBIN-UNIT-1', file: 'apps/api/src/account-database-insights-workspace.test.ts', name: "account database insights workspace returns the owner's observed databases and users through the agent" }],
    checks: ['OWN-DATABASES-ONLY', 'DATABASE-PRESENT-ON-SERVER', 'SELECTOR-REFUSED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const prefix = `${fixture.username}_xq${tag}`
      undo('database', dropDatabases(owner, prefix))
      await owner.post('/api/databases', { name: prefix })
      const view = await owner.get('/api/account/database-insights'), rows = view.data?.databases
      const found = Array.isArray(rows) ? rows.find(row => row.name === prefix) : null
      check('OWN-DATABASES-ONLY', view.status === 200 && Array.isArray(rows) && found !== undefined && found !== null && rows.every(row => row.name.startsWith(`${fixture.username}_`)), { status: view.status, databases: Array.isArray(rows) ? rows.length : null })
      check('DATABASE-PRESENT-ON-SERVER', view.status === 200 && found?.server === 'present' && Array.isArray(found.largestTables), { status: view.status, server: found?.server ?? null })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/database-insights?database=xq'), 'VALIDATION')
    },
  }),

  tool('cron-jobs', {
    prefix: 'CRON', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/account\/cron(?:\/${ID})?$`), requests: 30,
    unit: [{ id: 'CRON-UNIT-1', file: 'apps/api/src/cron-workspace.test.ts', name: 'account cron validation and revisions preserves the exact shell command and supports a bounded runtime or infinity' }],
    checks: ['WEEKDAY-8-REFUSED', 'MINUTE-61-REFUSED', 'EMPTY-COMMAND-REFUSED', 'JOB-LISTED-ONCE', 'JOB-SCHEDULE-SAVED', 'DELETE-REMOVES-JOB', 'OUTPUT-EMAIL-REPORTED-UNSUPPORTED'],
    async run({ owner, tag, check, refused, undo }) {
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
      check('JOB-SCHEDULE-SAVED', created.status === 201 && jobs[0]?.schedule === '*/5 * * * *' && jobs[0]?.comment === mine, { status: listed.status })
      check('OUTPUT-EMAIL-REPORTED-UNSUPPORTED', listed.status === 200 && listed.data?.capabilities?.outputEmail === false, { status: listed.status, outputEmail: listed.data?.capabilities?.outputEmail ?? null })
      const removed = jobs[0] ? await owner.delete(`/api/account/cron/${jobs[0].id}`, { expectedRevision: listed.data.revision, confirmation: command }) : created
      const after = await view()
      check('DELETE-REMOVES-JOB', removed.status === 200 && !after.data?.jobs?.some(item => item.command === command), { status: removed.status })
    },
  }),

  tool('track-dns', {
    prefix: 'TDNS', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:account\/network-tools\/dns|feature-lists(?:\/${ID})?)$`), requests: 20,
    unit: [{ id: 'TDNS-UNIT-1', file: 'apps/api/src/network-tools-workspace.test.ts', name: 'account network tools workspace runs each tool through the agent and returns the pinned view' }],
    checks: ['A-AAAA-ANSWER-ARRAYS', 'MX-ANSWER-ARRAY', 'BAD-NAME-REFUSED', 'LONG-NAME-REFUSED', 'FEATURE-DISABLED-REFUSED'],
    async run({ root, owner, fixture, check, refused, undo }) {
      const lookup = (name, type) => owner.post('/api/account/network-tools/dns', { name, type })
      const a = await lookup('example.com', 'A'), aaaa = await lookup('example.com', 'AAAA'), mx = await lookup('example.com', 'MX')
      check('A-AAAA-ANSWER-ARRAYS', a.status === 200 && aaaa.status === 200 && a.data?.result?.records?.length > 0 && Array.isArray(aaaa.data?.result?.records), { aStatus: a.status, aaaaStatus: aaaa.status })
      check('MX-ANSWER-ARRAY', mx.status === 200 && mx.data?.result?.records?.length > 0, { status: mx.status })
      refused('BAD-NAME-REFUSED', await lookup('bad..name', 'A'), 'VALIDATION')
      refused('LONG-NAME-REFUSED', await lookup(`${'a'.repeat(60)}.`.repeat(5) + 'example.com', 'A'), 'VALIDATION')
      const find = async () => (await root.get('/api/feature-lists')).data?.featureLists?.find(item => item.name === `xq-${fixture.username.slice(2)}`)
      const list = await find()
      if (!list) return check('FEATURE-DISABLED-REFUSED', false, { featureList: false })
      undo('run feature list', async () => {
        const now = await find()
        if (!now) return false
        if (sameJson(now.disabled, list.disabled)) return true
        const back = await root.patch(`/api/feature-lists/${list.id}`, { disabled: list.disabled })
        return back.status === 200 && sameJson(back.data?.featureList?.disabled, list.disabled)
      })
      const changed = await root.patch(`/api/feature-lists/${list.id}`, { disabled: [...new Set([...list.disabled, 'track-dns'])] })
      if (changed.status !== 200) return check('FEATURE-DISABLED-REFUSED', false, safeResponse(changed))
      refused('FEATURE-DISABLED-REFUSED', await lookup('example.com', 'A'), 'FORBIDDEN')
    },
  }),

  tool('indexes', {
    prefix: 'IDXS', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DIRECTIVE_PATHS('indexes'), requests: 40,
    unit: [{ id: 'IDXS-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace reads a feature model and saves only its managed block with the captured revision' }],
    page: { route: '/advanced/indexes', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    checks: ['DISABLED-LISTING-403', 'ENABLED-LISTING-SERVED', 'INHERIT-REMOVES-DIRECTIVE', 'OUTSIDE-HOME-REJECTED'],
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
      const enabled = await rule.write({ listing: 'enabled' })
      const shown = await until(() => site.get(fixture.domain, url), response => response.status === 200 && response.text.includes(name), { attempts: 8, delayMs: 1500 })
      check('ENABLED-LISTING-SERVED', enabled.status === 200 && shown.settled, { saveStatus: enabled.status, status: shown.last?.status ?? null })
      const inherit = await rule.write({ listing: 'inherit' }), now = await rule.read()
      check('INHERIT-REMOVES-DIRECTIVE', inherit.status === 200 && now.data?.document?.managedFeatures?.includes('indexes') === false, { status: inherit.status })
      refused('OUTSIDE-HOME-REJECTED', await rule.write({ listing: 'disabled', path: '../x' }), 'VALIDATION')
    },
  }),

  tool('error-pages', {
    prefix: 'ERRP', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DIRECTIVE_PATHS('error-pages'), requests: 40,
    unit: [{ id: 'ERRP-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace refuses stale revisions, field errors, extra keys and no-op saves before any write' }],
    page: { route: '/advanced/error-pages', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    checks: ['CUSTOM-404-SERVED', 'PATH-TRAVERSAL-REFUSED', 'CODE-OUTSIDE-RANGE-REFUSED'],
    async run({ owner, fixture, tag, site, check, refused, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel || !place.id) return
      const rule = directiveOf(owner, place.id, 'error-pages'), before = await rule.read()
      if (before.status !== 200) return
      undo('error pages rule', rule.restore(before, { entries: [] }))
      const page = `${place.rel}/xq-${tag}-404.html`, missing = `/xq-${tag}-missing`
      undo('error page file', discard(send, page))
      await send({ op: 'write', path: page, content: `Custom 404 xq-${tag}\n` })
      refused('CODE-OUTSIDE-RANGE-REFUSED', await rule.write({ entries: [{ code: 200, path: `/xq-${tag}-404.html` }] }), 'VALIDATION')
      refused('PATH-TRAVERSAL-REFUSED', await rule.write({ entries: [{ code: 404, path: '/../etc/passwd' }] }), 'VALIDATION')
      const saved = await rule.write({ entries: [{ code: 404, path: `/xq-${tag}-404.html` }] })
      const served = await until(() => site.get(fixture.domain, missing), response => response.status === 404 && response.text.includes(`Custom 404 xq-${tag}`), { attempts: 8, delayMs: 1500 })
      check('CUSTOM-404-SERVED', saved.status === 200 && served.settled, { saveStatus: saved.status, status: served.last?.status ?? null })
    },
  }),

  tool('mime-types', {
    prefix: 'MIME', as: 'owner', needs: ['account'], probe: '/api/auth/me', paths: DIRECTIVE_PATHS('mime-types'), requests: 40,
    unit: [{ id: 'MIME-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace refuses stale revisions, field errors, extra keys and no-op saves before any write' }],
    page: { route: '/advanced/mime-types', read: '/api/domains', shows: data => [data?.domains?.[0]?.name] },
    checks: ['FOO-CONTENT-TYPE', 'TYPE-WITHOUT-SLASH-REFUSED', 'EXECUTABLE-TYPE-REFUSED'],
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
      refused('EXECUTABLE-TYPE-REFUSED', await rule.write({ entries: [{ type: 'application/x-httpd-php', extensions: ['.foo'] }] }), 'VALIDATION')
    },
  }),

  tool('virus-scanner', {
    prefix: 'VSCN', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: new RegExp(String.raw`^\/api\/(?:domains|account\/virus-scan(?:\?path=public_html)?|${FILES})$`), requests: 60, deadlineMs: 240_000,
    unit: [{ id: 'VSCN-UNIT-1', file: 'apps/api/src/account-virus-scan-workspace.test.ts', name: 'account virus scan workspace starts one scan with an empty body after fresh authority and returns the read-back' }],
    checks: ['EICAR-LISTED-INFECTED', 'SCAN-SUMMARY-RECORDED', 'SELECTOR-REFUSED', 'BAD-SCAN-TYPE-REFUSED'],
    async run({ owner, fixture, tag, check, refused, undo, until }) {
      const place = await siteOf(owner), send = filesOf(owner, fixture)
      if (!place.rel) return
      const path = `${place.rel}/xq-${tag}-eicar.txt`
      undo('test file', discard(send, path))
      await put(send, path, EICAR)
      refused('BAD-SCAN-TYPE-REFUSED', await owner.post('/api/account/virus-scan', { scan_type: 'bogus' }), 'VALIDATION')
      refused('SELECTOR-REFUSED', await owner.get('/api/account/virus-scan?path=public_html'), 'VALIDATION')
      const started = await owner.post('/api/account/virus-scan', {}), jobId = started.data?.started?.jobId
      const finished = await until(() => owner.get('/api/account/virus-scan'), view => view.data?.scans?.some(scan => scan.jobId === jobId && ['succeeded', 'failed', 'cancelled'].includes(scan.status)), { attempts: 30, delayMs: 2000 })
      const scan = finished.last?.data?.scans?.find(item => item.jobId === jobId)
      check('EICAR-LISTED-INFECTED', started.status === 202 && scan?.infected?.some(item => item.path === path) === true, { status: started.status, scanStatus: scan?.status ?? null })
      check('SCAN-SUMMARY-RECORDED', started.status === 202 && scan?.status === 'succeeded' && (scan?.summary?.infectedFiles ?? 0) >= 1, { scanStatus: scan?.status ?? null, infectedFiles: scan?.summary?.infectedFiles ?? null })
    },
  }),

  tool('remote-database-access', {
    prefix: 'RDBA', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/account\/database-remote-access$/, requests: 15,
    unit: [{ id: 'RDBA-UNIT-1', file: 'apps/api/src/database-remote-access-workspace.test.ts', name: 'remote database owner API boundary forwards only a session-derived owner target with exact parsed body and validated acknowledgement' }],
    checks: ['RANGE-ADDED', 'DUPLICATE-HOST-CONFLICT', 'DNS-HOSTNAME-REFUSED', 'RANGE-REMOVED', 'ANY-HOST-WILDCARD-REFUSED', 'NOTE-TOO-LONG-REFUSED'],
    async run({ owner, tag, check, refused, undo }) {
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
      const afterAddRev = added.data?.revision ?? before.data.revision
      refused('DUPLICATE-HOST-CONFLICT', await owner.post(path, { action: 'add', expectedRevision: afterAddRev, host, comment: 'dup' }), 'CONFLICT')
      refused('DNS-HOSTNAME-REFUSED', await owner.post(path, { action: 'add', expectedRevision: afterAddRev, host: 'db.example.com', comment: 'dns' }), 'VALIDATION')
      const removed = await owner.post(path, { action: 'remove', expectedRevision: afterAddRev, host })
      check('RANGE-REMOVED', removed.status === 200 && removed.data?.entries?.some(entry => entry.host === host) === false, { status: removed.status })
      const now = await owner.get(path)
      refused('ANY-HOST-WILDCARD-REFUSED', await owner.post(path, { action: 'add', expectedRevision: now.data?.revision, host: '0.0.0.0/0', comment: 'any' }), 'VALIDATION')
      refused('NOTE-TOO-LONG-REFUSED', await owner.post(path, { action: 'add', expectedRevision: now.data?.revision, host: '198.51.100.7', comment: 'n'.repeat(256) }), 'VALIDATION')
    },
  }),

  tool('api-shell', {
    prefix: 'APSH', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/account\/developer$/, requests: 10,
    unit: [{ id: 'APSH-UNIT-1', file: 'apps/api/src/developer-workspace.test.ts', name: 'finite interactive API explorer ignores unrelated paths, lists only fixed GET operations and rejects every selector/body extension' }],
    checks: ['MANIFEST-READ-ONLY', 'IDENTITY-DISPATCHED', 'ROOT-OPERATION-FORBIDDEN'],
    async run({ owner, fixture, check, refused }) {
      const manifest = await owner.get('/api/account/developer')
      check('MANIFEST-READ-ONLY', manifest.status === 200 && manifest.data?.surface === 'account' && manifest.data?.writes === false && manifest.data?.rawResponses === false, { status: manifest.status })
      const identity = await owner.post('/api/account/developer', { operation: 'identity' })
      check('IDENTITY-DISPATCHED', identity.status === 200 && identity.data?.state === 'read' && identity.data?.fields?.some(field => field.key === 'username' && field.value === fixture.username) === true, { status: identity.status })
      refused('ROOT-OPERATION-FORBIDDEN', await owner.post('/api/account/developer', { operation: 'tokens' }), 'FORBIDDEN')
    },
  }),
]
