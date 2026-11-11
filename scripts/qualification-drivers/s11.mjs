import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { safeResponse, tool } from './kit.mjs'

const credential = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const b64 = value => Buffer.from(value).toString('base64')
const ID = '[0-9a-f-]{36}'
const FILES = String.raw`accounts\/[a-z][a-z0-9]{0,15}\/files`
const ZERO_REV = '0'.repeat(64)
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'

/** Minimal valid 4x2 RGBA PNG built without external tools, for image scaling and thumbnailing checks. */
function makePng4x2() {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  const crc32 = bytes => {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const head = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head, data])), 0)
    return Buffer.concat([len, head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc(2 * (1 + 4 * 4), 0)
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const off = row * 17 + 1 + col * 4
      raw[off] = 40; raw[off + 1] = 100; raw[off + 2] = 180; raw[off + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const siteOf = async owner => {
  const response = await owner.get('/api/domains')
  const domain = (response.data?.domains ?? [])[0]
  const home = response.data?.context?.home
  const rel = domain && typeof home === 'string' && typeof domain.docRoot === 'string'
    ? (domain.docRoot.startsWith(`${home}/`) ? domain.docRoot.slice(home.length + 1) : domain.docRoot)
    : null
  return { response, id: typeof domain?.id === 'string' ? domain.id : null, name: typeof domain?.name === 'string' ? domain.name : null, rel }
}

const filesOf = (owner, fixture) => body => owner.post(`/api/accounts/${fixture.username}/files`, body)

const discard = (send, path) => async () => {
  const parent = path.split('/').slice(0, -1).join('/')
  const listed = await send({ op: 'list', path: parent })
  if (listed.status !== 200) return false
  if (!(listed.data?.entries ?? []).some(entry => entry.path === path)) return true
  const trashed = await send({ op: 'trash', path })
  if (trashed.status !== 200 || typeof trashed.data?.id !== 'string') return false
  return (await send({
    op: 'purge-trash',
    trashId: trashed.data.id,
    originalPath: trashed.data.originalPath,
    deletedAt: trashed.data.deletedAt,
  })).status === 200
}

const dropDatabases = (owner, prefix) => async () => {
  const users = await owner.get('/api/databases/users')
  if (users.status === 200) {
    for (const user of (users.data?.users ?? []).filter(item => typeof item?.name === 'string' && item.name.startsWith(prefix))) {
      if (typeof user.id === 'string') await owner.delete(`/api/databases/users/${user.id}`)
    }
  }
  const listed = await owner.get('/api/databases')
  if (listed.status !== 200) return false
  for (const database of (listed.data?.databases ?? []).filter(item => typeof item?.name === 'string' && item.name.startsWith(prefix))) {
    if (typeof database.id === 'string') await owner.delete(`/api/databases/${database.id}`)
  }
  const after = await owner.get('/api/databases'), left = await owner.get('/api/databases/users')
  return after.status === 200 && left.status === 200
    && !(after.data?.databases ?? []).some(item => item?.name?.startsWith(prefix))
    && !(left.data?.users ?? []).some(item => item?.name?.startsWith(prefix))
}

const dropServiceUsers = (owner, matchLogin) => async () => {
  const listed = await owner.get('/api/service-users')
  if (listed.status !== 200) return false
  for (const user of (listed.data?.serviceUsers ?? []).filter(item => typeof item?.login === 'string' && matchLogin(item.login))) {
    if (typeof user.id === 'string') await owner.delete(`/api/service-users/${user.id}`)
  }
  const after = await owner.get('/api/service-users')
  return after.status === 200 && !(after.data?.serviceUsers ?? []).some(item => typeof item?.login === 'string' && matchLogin(item.login))
}

const dropPostgresql = (owner, prefix) => async () => {
  const read = await owner.get('/api/account/database-engines/postgresql')
  if (read.status !== 200) return false
  for (const db of (read.data?.saved?.databases ?? []).filter(item => typeof item?.name === 'string' && item.name.startsWith(prefix))) {
    if (typeof db.id !== 'string') continue
    if (db.trashedAt === null) {
      await owner.post(`/api/account/database-engines/postgresql/databases/${db.id}/trash`, { expectedTrashedAt: null, confirmation: db.name })
    }
    await owner.delete(`/api/account/database-engines/postgresql/databases/${db.id}`, { confirmation: db.name })
  }
  const mid = await owner.get('/api/account/database-engines/postgresql')
  if (mid.status === 200) {
    for (const role of (mid.data?.saved?.users ?? []).filter(item => typeof item?.name === 'string' && item.name.startsWith(prefix))) {
      if (typeof role.id === 'string') {
        await owner.delete(`/api/account/database-engines/postgresql/users/${role.id}`, { confirmation: role.name })
      }
    }
  }
  const after = await owner.get('/api/account/database-engines/postgresql')
  return after.status === 200
    && !(after.data?.saved?.databases ?? []).some(item => item?.name?.startsWith(prefix))
    && !(after.data?.saved?.users ?? []).some(item => item?.name?.startsWith(prefix))
}

export default [
  tool('html-editor', {
    prefix: 'S11T01', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:domains|${FILES})$`), requests: 35,
    unit: [{ id: 'S11T01-UNIT-1', file: 'apps/web/src/account-owner-tools-client.test.ts', name: 'HTML editor round trip keeps every byte outside the edited markup, scripts included' }],
    checks: ['OUTSIDE-HOME-REFUSED', 'MARKUP-SAVED-MODE-KEPT', 'SCRIPT-BYTES-ROUNDTRIP'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const site = await siteOf(owner), send = filesOf(owner, fixture)
      refused('OUTSIDE-HOME-REFUSED', await send({ op: 'write', path: `../xq-${tag}-escape.html`, content: '<h1>x</h1>' }), 'FORBIDDEN')
      const rel = site.rel ?? 'public_html', path = `${rel}/xq-${tag}-editor.html`
      const script = '<script>window.__xqHtml = 42;</script>'
      const initial = `<!doctype html><html><body><h1>Before</h1>${script}</body></html>\n`
      const edited = `<!doctype html><html><body><h1>After ${tag}</h1>${script}</body></html>\n`
      undo('html editor test file', discard(send, path))
      const created = await send({ op: 'put-bytes', path, contentBase64: b64(initial), overwrite: true })
      const saved = await send({ op: 'write', path, content: edited })
      const listed = await send({ op: 'list', path: rel })
      const entry = (listed.data?.entries ?? []).find(item => item?.path === path)
      check('MARKUP-SAVED-MODE-KEPT', created.status === 200 && saved.status === 200 && typeof created.data?.mode === 'number' && entry?.mode === created.data.mode, {
        createStatus: created.status, saveStatus: saved.status, mode: entry?.mode ?? null,
      })
      const readBack = await send({ op: 'get-bytes', path })
      const decoded = typeof readBack.data?.contentBase64 === 'string' ? Buffer.from(readBack.data.contentBase64, 'base64').toString('utf8') : ''
      check('SCRIPT-BYTES-ROUNDTRIP', readBack.status === 200 && decoded === edited && decoded.includes(script), {
        status: readBack.status, exactMatch: decoded === edited,
      })
    },
  }),

  tool('images', {
    prefix: 'S11T02', as: 'owner', needs: ['account'], probe: '/api/account/images',
    paths: new RegExp(String.raw`^\/api\/(?:account\/images|domains|${FILES})$`), requests: 35,
    unit: [{ id: 'S11T02-UNIT-1', file: 'apps/agent/src/owner-tools.test.ts', name: 'image operations bounds every request and keeps paths inside the home' }],
    checks: ['STATUS-READ', 'OUTSIDE-HOME-REFUSED', 'BAD-SCALE-REFUSED', 'THUMBNAIL-OR-ENGINE-GATE'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const read = await owner.get('/api/account/images')
      check('STATUS-READ', read.status === 200 && read.data?.context?.accountId === fixture.accountId && typeof read.data?.engine === 'boolean', {
        status: read.status, engine: read.data?.engine ?? null,
      })
      refused('OUTSIDE-HOME-REFUSED', await owner.post('/api/account/images', { op: 'thumbnail', path: '../escape', widthPercent: 50, heightPercent: 50 }), 'VALIDATION')
      refused('BAD-SCALE-REFUSED', await owner.post('/api/account/images', { op: 'scale', path: 'public_html/a.png', width: 0, height: 100 }), 'VALIDATION')
      if (read.status === 200 && read.data?.engine === true) {
        const site = await siteOf(owner), send = filesOf(owner, fixture)
        const dir = `${site.rel ?? 'public_html'}/xq-${tag}-img`, file = `${dir}/a.png`
        undo('image test folder', discard(send, dir))
        await send({ op: 'mkdir', path: dir })
        await send({ op: 'put-bytes', path: file, contentBase64: makePng4x2().toString('base64'), overwrite: true })
        const thumb = await owner.post('/api/account/images', { op: 'thumbnail', path: dir, widthPercent: 50, heightPercent: 50 })
        const out = (thumb.data?.results ?? [])[0]
        check('THUMBNAIL-OR-ENGINE-GATE', thumb.status === 200 && out?.width === 2 && out?.height === 1, {
          status: thumb.status, width: out?.width ?? null, height: out?.height ?? null,
        })
      } else {
        const gated = await owner.post('/api/account/images', { op: 'read', path: 'public_html/a.png' })
        check('THUMBNAIL-OR-ENGINE-GATE', read.status === 200 && gated.status === 412 && gated.data?.code === 'PRECONDITION_FAILED', safeResponse(gated))
      }
    },
  }),

  tool('disk-usage', {
    prefix: 'S11T03', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:accounts|domains|${FILES})$`), requests: 30,
    unit: [{ id: 'S11T03-UNIT-1', file: 'apps/web/src/themes/v2/pages/xpanel/resources.test.ts', name: 'v2 account resources separates plan values, applied readback and measured values' }],
    checks: ['ACCOUNT-SCOPED-READ', 'HOME-FILE-SIZE-OBSERVED', 'OUTSIDE-HOME-REFUSED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const accounts = await owner.get('/api/accounts')
      const rows = accounts.data?.accounts ?? []
      check('ACCOUNT-SCOPED-READ', accounts.status === 200 && rows.length === 1 && rows[0]?.id === fixture.accountId && rows[0]?.username === fixture.username, {
        status: accounts.status, count: Array.isArray(rows) ? rows.length : null,
      })
      const site = await siteOf(owner), send = filesOf(owner, fixture)
      const rel = site.rel ?? 'public_html', path = `${rel}/xq-${tag}-usage.bin`
      undo('disk usage sample file', discard(send, path))
      const written = await send({ op: 'put-bytes', path, contentBase64: Buffer.alloc(4096, 0x61).toString('base64'), overwrite: true })
      const listed = await send({ op: 'list', path: rel })
      const entry = (listed.data?.entries ?? []).find(item => item?.path === path)
      check('HOME-FILE-SIZE-OBSERVED', written.status === 200 && listed.status === 200 && entry?.sizeBytes === 4096, {
        writeStatus: written.status, listStatus: listed.status, bytes: entry?.sizeBytes ?? null,
      })
      refused('OUTSIDE-HOME-REFUSED', await send({ op: 'list', path: '../escape' }), 'FORBIDDEN')
    },
  }),

  tool('web-disk', {
    prefix: 'S11T04', as: 'owner', needs: ['account'], probe: '/api/account/web-disk',
    paths: new RegExp(String.raw`^\/api\/(?:account\/web-disk(?:\?bad=1)?|domains|service-users(?:\/${ID})?)$`), requests: 30,
    unit: [{ id: 'S11T04-UNIT-1', file: 'apps/api/src/dav-workspace.test.ts', name: 'Web Disk view lists the main login and Web Disk users, and serves only names with a certificate' }],
    checks: ['MAIN-LOGIN-AND-TLS-PORT', 'SELECTOR-REFUSED', 'OUTSIDE-HOME-USER-REFUSED', 'READONLY-USER-LISTED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const view = await owner.get('/api/account/web-disk')
      const main = (view.data?.logins ?? []).find(item => item?.kind === 'main' && item?.login === fixture.username)
      check('MAIN-LOGIN-AND-TLS-PORT', view.status === 200 && view.data?.port === 2078 && view.data?.authentication === 'basic-over-tls' && main?.access === 'read-write', {
        status: view.status, port: view.data?.port ?? null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/web-disk?bad=1'), 'VALIDATION')
      refused('OUTSIDE-HOME-USER-REFUSED', await owner.post('/api/service-users', {
        login: `xqwbad${tag}@${fixture.domain}`,
        password: credential(),
        services: { email: false, ftp: false, webdisk: true },
        ftpDir: '../escape',
        webdiskReadOnly: true,
      }), 'VALIDATION')
      const login = `xqwd${tag}@${fixture.domain}`
      undo('web disk user', dropServiceUsers(owner, name => name === login))
      const site = await siteOf(owner), dir = site.rel ?? 'public_html'
      const created = await owner.post('/api/service-users', {
        login,
        password: credential(),
        services: { email: false, ftp: false, webdisk: true },
        ftpDir: dir,
        webdiskReadOnly: true,
      })
      const after = await owner.get('/api/account/web-disk')
      const row = (after.data?.logins ?? []).find(item => item?.login === login)
      check('READONLY-USER-LISTED', created.status === 201 && after.status === 200 && row?.access === 'read-only' && row?.directory === dir, {
        createStatus: created.status, access: row?.access ?? null,
      })
    },
  }),

  tool('ftp-connections', {
    prefix: 'S11T05', as: 'owner', needs: ['account'], probe: '/api/account/ftp/sessions',
    paths: /^\/api\/account\/ftp\/sessions(?:\?bad=1|\/disconnect)?$/, requests: 20,
    unit: [{ id: 'S11T05-UNIT-1', file: 'apps/api/src/ftp-workspace.test.ts', name: 'agent reply validation rejects a session or report of another account' }],
    checks: ['SESSIONS-SCOPED-READ', 'SELECTOR-REFUSED', 'BAD-DISCONNECT-TARGET-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const read = await owner.get('/api/account/ftp/sessions')
      check('SESSIONS-SCOPED-READ', read.status === 200 && read.data?.context?.accountId === fixture.accountId && Array.isArray(read.data?.sessions), {
        status: read.status, state: read.data?.state ?? null, count: Array.isArray(read.data?.sessions) ? read.data.sessions.length : null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/ftp/sessions?bad=1'), 'VALIDATION')
      refused('BAD-DISCONNECT-TARGET-REFUSED', await owner.post('/api/account/ftp/sessions/disconnect', { target: 0 }), 'VALIDATION')
    },
  }),

  tool('anonymous-ftp', {
    prefix: 'S11T06', as: 'owner', needs: ['account'], probe: '/api/account/ftp/anonymous',
    paths: /^\/api\/account\/ftp\/anonymous(?:\?bad=1)?$/, requests: 20,
    unit: [{ id: 'S11T06-UNIT-1', file: 'apps/api/src/ftp-workspace.test.ts', name: 'Anonymous FTP route refuses while the server does not allow it, and uploads the server closed' }],
    checks: ['STATUS-READ', 'UPLOADS-WITHOUT-ENABLED-REFUSED', 'BAD-REVISION-REFUSED', 'ENABLE-GATE-OR-RESTORE'],
    async run({ owner, fixture, check, refused, undo }) {
      const before = await owner.get('/api/account/ftp/anonymous')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      check('STATUS-READ', before.status === 200 && before.data?.context?.accountId === fixture.accountId && before.data?.directory === 'public_ftp', {
        status: before.status, enabled: before.data?.enabled ?? null,
      })
      refused('UPLOADS-WITHOUT-ENABLED-REFUSED', await owner.put('/api/account/ftp/anonymous', {
        enabled: false, uploads: true, welcome: '', expectedRevision: rev,
      }), 'VALIDATION')
      refused('BAD-REVISION-REFUSED', await owner.put('/api/account/ftp/anonymous', {
        enabled: false, uploads: false, welcome: '', expectedRevision: 'bad',
      }), 'VALIDATION')
      if (before.status === 200 && before.data?.server?.enabled === true && before.data?.server?.anonymous === true) {
        undo('anonymous ftp setting', async () => {
          const now = await owner.get('/api/account/ftp/anonymous')
          if (now.status !== 200) return false
          if (now.data?.enabled === before.data.enabled && now.data?.uploads === before.data.uploads) return true
          return (await owner.put('/api/account/ftp/anonymous', {
            enabled: Boolean(before.data.enabled),
            uploads: Boolean(before.data.uploads),
            welcome: typeof before.data.welcome === 'string' ? before.data.welcome : '',
            expectedRevision: now.data.revision,
          })).status === 200
        })
        const toggled = await owner.put('/api/account/ftp/anonymous', {
          enabled: true, uploads: false, welcome: 'Welcome', expectedRevision: rev,
        })
        check('ENABLE-GATE-OR-RESTORE', toggled.status === 200 && toggled.data?.enabled === true && toggled.data?.uploads === false, safeResponse(toggled))
      } else {
        const denied = await owner.put('/api/account/ftp/anonymous', {
          enabled: true, uploads: false, welcome: '', expectedRevision: rev,
        })
        check('ENABLE-GATE-OR-RESTORE', before.status === 200 && denied.status === 412 && denied.data?.code === 'PRECONDITION_FAILED', safeResponse(denied))
      }
    },
  }),

  tool('backup', {
    prefix: 'S11T07', as: 'owner', needs: ['account'], probe: '/api/account/backups',
    paths: /^\/api\/account\/backups(?:\?bad=1|\/[^/]+\/download)?$/, requests: 20,
    unit: [{ id: 'S11T07-UNIT-1', file: 'apps/api/src/account-backup-workspace.test.ts', name: 'account backup actual API authorization with declared archive transport pins every RPC to the authenticated owner and verifies creation/list readback' }],
    checks: ['LIST-SCOPED-HOME', 'SELECTOR-REFUSED', 'BAD-ARCHIVE-NAME-REFUSED', 'MISSING-ARCHIVE-NOT-FOUND'],
    async run({ owner, fixture, check, refused }) {
      const listed = await owner.get('/api/account/backups')
      check('LIST-SCOPED-HOME', listed.status === 200 && listed.data?.context?.accountId === fixture.accountId && listed.data?.context?.scope === 'home' && Array.isArray(listed.data?.backups), {
        status: listed.status, count: Array.isArray(listed.data?.backups) ? listed.data.backups.length : null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/backups?bad=1'), 'VALIDATION')
      refused('BAD-ARCHIVE-NAME-REFUSED', await owner.get('/api/account/backups/foreign-archive.tar.gz/download'), 'VALIDATION')
      const absent = `xpanel-backup-${fixture.username}-20990101T000000Z.tar.gz`
      refused('MISSING-ARCHIVE-NOT-FOUND', await owner.get(`/api/account/backups/${absent}/download`), 'NOT_FOUND')
    },
  }),

  tool('website-backups', {
    prefix: 'S11T08', as: 'owner', needs: ['account'], probe: '/api/account/website-backups',
    paths: new RegExp(String.raw`^\/api\/account\/website-backups(?:\?(?:bad=1|domainId=${ID}))?$`), requests: 25,
    unit: [{ id: 'S11T08-UNIT-1', file: 'apps/agent/src/website-backups.test.ts', name: 'website backups refuses a second job for the account and a foreign database' }],
    checks: ['OVERVIEW-SCOPED-READ', 'SELECTOR-REFUSED', 'FOREIGN-DOMAIN-NOT-FOUND', 'FOREIGN-DATABASE-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const read = await owner.get('/api/account/website-backups')
      const domainId = (read.data?.domains ?? [])[0]?.id
      check('OVERVIEW-SCOPED-READ', read.status === 200 && read.data?.context?.accountId === fixture.accountId && Array.isArray(read.data?.domains), {
        status: read.status, domains: Array.isArray(read.data?.domains) ? read.data.domains.length : null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/website-backups?bad=1'), 'VALIDATION')
      refused('FOREIGN-DOMAIN-NOT-FOUND', await owner.post('/api/account/website-backups', {
        domainId: ZERO_UUID, op: 'create', databases: [],
      }), 'NOT_FOUND')
      if (typeof domainId === 'string') {
        refused('FOREIGN-DATABASE-REFUSED', await owner.post('/api/account/website-backups', {
          domainId, op: 'create', databases: ['otheracct_secretdb'],
        }), 'VALIDATION')
      } else {
        check('FOREIGN-DATABASE-REFUSED', false, { status: read.status })
      }
    },
  }),

  tool('gitweb', {
    prefix: 'S11T09', as: 'owner', needs: ['account'], probe: '/api/account/git',
    paths: new RegExp(String.raw`^\/api\/(?:account\/git(?:\/view(?:\?[A-Za-z0-9=&._%/-]+)?)?|${FILES})$`), requests: 30,
    unit: [
      { id: 'S11T09-UNIT-1', file: 'apps/agent/src/account-git-view.test.ts', name: 'Git viewer grammar refuses options, rev syntax and paths that climb out' },
      { id: 'S11T09-UNIT-2', file: 'apps/api/src/email-disk-usage-workspace.test.ts', name: 'Git viewer workspace forwards validated views only and accepts no mutating method' },
    ],
    checks: ['OUTSIDE-PATH-REFUSED', 'UNMANAGED-REPO-404', 'MUTATING-METHOD-DENIED', 'MANAGED-REFS-VIEW'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const send = filesOf(owner, fixture), repo = `xq-${tag}-gitweb`
      refused('OUTSIDE-PATH-REFUSED', await owner.get('/api/account/git/view?view=refs&path=../escape'), 'VALIDATION')
      refused('UNMANAGED-REPO-404', await owner.get(`/api/account/git/view?view=refs&path=xq-${tag}-missing`), 'NOT_FOUND')
      const postAttempt = await owner.post('/api/account/git/view', {})
      check('MUTATING-METHOD-DENIED', postAttempt.status === 404 || postAttempt.status === 405, safeResponse(postAttempt))
      const initial = await owner.get('/api/account/git')
      const rev = typeof initial.data?.revision === 'string' ? initial.data.revision : ZERO_REV
      undo('gitweb repository folder', discard(send, repo))
      undo('gitweb repository registration', async () => {
        const now = await owner.get('/api/account/git')
        if (now.status !== 200) return false
        if (!(now.data?.repositories ?? []).includes(repo)) return true
        const removed = await owner.post('/api/account/git', { op: 'remove', path: repo, expectedRevision: now.data.revision })
        return removed.status === 200 && !(removed.data?.repositories ?? []).includes(repo)
      })
      const created = await owner.post('/api/account/git', { op: 'init', path: repo, branch: 'main', expectedRevision: rev })
      const refs = await owner.get(`/api/account/git/view?view=refs&path=${repo}`)
      check('MANAGED-REFS-VIEW', created.status === 200 && refs.status === 200 && refs.data?.view === 'refs' && Array.isArray(refs.data?.refs), {
        initStatus: created.status, viewStatus: refs.status,
      })
    },
  }),

  tool('file-restoration', {
    prefix: 'S11T10', as: 'owner', needs: ['account'], probe: '/api/account/file-restoration',
    paths: /^\/api\/account\/file-restoration(?:\?bad=1|\/(?:browse|preview|restore))?$/, requests: 20,
    unit: [{ id: 'S11T10-UNIT-1', file: 'apps/api/src/backup-file-restore-workspace.test.ts', name: 'WHM file restore API rejects query selectors, wrong methods, non-JSON bodies and unknown accounts' }],
    checks: ['ARCHIVES-SCOPED-READ', 'SELECTOR-REFUSED', 'MAIL-PATH-NOT-RESTORABLE', 'FOREIGN-ARCHIVE-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const read = await owner.get('/api/account/file-restoration')
      check('ARCHIVES-SCOPED-READ', read.status === 200 && read.data?.context?.accountId === fixture.accountId && Array.isArray(read.data?.archives), {
        status: read.status, total: read.data?.total ?? null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/file-restoration?bad=1'), 'VALIDATION')
      const archive = `xpanel-backup-${fixture.username}-20990101T000000Z.tar.gz`
      const mailRefusal = await owner.post('/api/account/file-restoration/restore', {
        file: archive,
        paths: ['mail/inbox'],
        destination: 'replace',
        expectedRevision: ZERO_REV,
      })
      check('MAIL-PATH-NOT-RESTORABLE', mailRefusal.status === 400 && mailRefusal.data?.code === 'VALIDATION', safeResponse(mailRefusal))
      refused('FOREIGN-ARCHIVE-REFUSED', await owner.post('/api/account/file-restoration/browse', {
        file: 'xpanel-backup-otheruser-20990101T000000Z.tar.gz',
      }), 'VALIDATION')
    },
  }),

  tool('phpmyadmin', {
    prefix: 'S11T11', as: 'owner', needs: ['account'], probe: '/api/account/database-engines/phpmyadmin',
    paths: /^\/api\/account\/database-engines\/phpmyadmin(?:\?bad=1|\/sign-on)?$/, requests: 20,
    unit: [{ id: 'S11T11-UNIT-1', file: 'apps/api/src/db-workspace.test.ts', name: 'database workspace routes scopes account reads and sign-on to the session owner and its plan feature' }],
    checks: ['STATUS-SCOPED-READ', 'SELECTOR-REFUSED', 'SIGNON-BODY-GUARD'],
    async run({ owner, fixture, check, refused }) {
      const read = await owner.get('/api/account/database-engines/phpmyadmin')
      check('STATUS-SCOPED-READ', read.status === 200 && read.data?.client === 'phpmyadmin' && read.data?.context?.accountId === fixture.accountId && typeof read.data?.signon?.state === 'string', {
        status: read.status, state: read.data?.signon?.state ?? null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/database-engines/phpmyadmin?bad=1'), 'VALIDATION')
      refused('SIGNON-BODY-GUARD', await owner.post('/api/account/database-engines/phpmyadmin/sign-on', { extra: true }), 'VALIDATION')
    },
  }),

  tool('database-wizard', {
    prefix: 'S11T12', as: 'owner', needs: ['account'], probe: '/api/databases',
    paths: new RegExp(String.raw`^\/api\/databases(?:\/users(?:\/${ID})?|\/${ID})?$`), requests: 30,
    unit: [{ id: 'S11T12-UNIT-1', file: 'apps/api/src/completion-database-grants-security.test.ts', name: 'conditional database grant API with isolated SQLite and desired state adds a grant only when the last read had no grant and returns safe owned readback' }],
    checks: ['BACKTICK-NAME-REFUSED', 'DATABASE-AND-USER-CREATED', 'GRANT-VISIBLE-IN-READBACK'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const prefix = `${fixture.username}_xqw${tag}`
      undo('wizard databases and users', dropDatabases(owner, prefix))
      refused('BACKTICK-NAME-REFUSED', await owner.post('/api/databases', { name: `${fixture.username}_bad\`name` }), 'VALIDATION')
      const dbName = `${prefix}db`, userName = `${prefix}u`
      const db = await owner.post('/api/databases', { name: dbName })
      const dbId = db.data?.database?.id
      const user = typeof dbId === 'string'
        ? await owner.post('/api/databases/users', { name: userName, password: credential(), databaseId: dbId, privileges: ['ALL PRIVILEGES'] })
        : { status: 0, data: null }
      const dbs = await owner.get('/api/databases'), users = await owner.get('/api/databases/users')
      const foundDb = (dbs.data?.databases ?? []).some(item => item?.name === dbName)
      const foundUser = (users.data?.users ?? []).find(item => item?.name === userName)
      check('DATABASE-AND-USER-CREATED', db.status === 201 && user.status === 201 && foundDb && Boolean(foundUser), {
        dbStatus: db.status, userStatus: user.status,
      })
      const hasGrant = (foundUser?.grants ?? []).some(grant => grant?.databaseId === dbId && Array.isArray(grant?.privileges) && grant.privileges.length > 0)
      check('GRANT-VISIBLE-IN-READBACK', users.status === 200 && hasGrant, {
        listStatus: users.status, granted: hasGrant,
      })
    },
  }),

  tool('postgresql-databases', {
    prefix: 'S11T13', as: 'owner', needs: ['account'], probe: '/api/account/database-engines/postgresql',
    paths: new RegExp(String.raw`^\/api\/account\/database-engines\/postgresql(?:\?bad=1|\/(?:users|databases)(?:\/${ID}(?:\/(?:password|trash|restore))?)?)?$`), requests: 30,
    unit: [{ id: 'S11T13-UNIT-1', file: 'apps/api/src/db-workspace.test.ts', name: 'database workspace routes serves the saved PostgreSQL objects with the server reading and the shared database limit' }],
    checks: ['SCOPED-VIEW-READ', 'SELECTOR-REFUSED', 'FOREIGN-PREFIX-REFUSED', 'CREATE-OR-ENGINE-PRECONDITION'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const view = await owner.get('/api/account/database-engines/postgresql')
      check('SCOPED-VIEW-READ', view.status === 200 && view.data?.context?.accountId === fixture.accountId && Array.isArray(view.data?.saved?.databases), {
        status: view.status, state: view.data?.state ?? null, provisioning: view.data?.provisioning ?? null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/database-engines/postgresql?bad=1'), 'VALIDATION')
      refused('FOREIGN-PREFIX-REFUSED', await owner.post('/api/account/database-engines/postgresql/databases', {
        name: 'otheracct_db', owner: fixture.username,
      }), 'VALIDATION')
      const prefix = `${fixture.username}_xqp${tag}`
      if (view.status === 200 && view.data?.provisioning === 'available') {
        undo('postgresql objects', dropPostgresql(owner, prefix))
        const roleName = `${prefix}r`, dbName = `${prefix}d`
        const role = await owner.post('/api/account/database-engines/postgresql/users', { name: roleName, password: credential() })
        const db = await owner.post('/api/account/database-engines/postgresql/databases', { name: dbName, owner: roleName })
        const after = await owner.get('/api/account/database-engines/postgresql')
        const savedDb = (after.data?.saved?.databases ?? []).find(item => item?.name === dbName)
        check('CREATE-OR-ENGINE-PRECONDITION', role.status === 201 && db.status === 201 && savedDb?.owner === roleName, {
          roleStatus: role.status, dbStatus: db.status,
        })
      } else {
        const pre = await owner.post('/api/account/database-engines/postgresql/users', {
          name: `${prefix}r`, password: credential(),
        })
        check('CREATE-OR-ENGINE-PRECONDITION', view.status === 200 && pre.status === 412 && pre.data?.code === 'PRECONDITION_FAILED', safeResponse(pre))
      }
    },
  }),

  tool('postgresql-database-wizard', {
    prefix: 'S11T14', as: 'owner', needs: ['account'], probe: '/api/account/database-engines/postgresql',
    paths: new RegExp(String.raw`^\/api\/account\/database-engines\/postgresql(?:\/(?:users|databases)(?:\/${ID}(?:\/(?:password|trash|restore))?)?)?$`), requests: 30,
    unit: [{ id: 'S11T14-UNIT-1', file: 'apps/api/src/db-workspace.test.ts', name: 'database workspace routes saves only a SCRAM verifier and applies changes through the database pipeline with the PostgreSQL feature' }],
    checks: ['INVALID-ROLE-REFUSED', 'INVALID-DB-NAME-REFUSED', 'WIZARD-FLOW-OR-STOPPED-GUARD'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      refused('INVALID-ROLE-REFUSED', await owner.post('/api/account/database-engines/postgresql/users', {
        name: 'other_role', password: credential(),
      }), 'VALIDATION')
      refused('INVALID-DB-NAME-REFUSED', await owner.post('/api/account/database-engines/postgresql/databases', {
        name: `${fixture.username}_bad-name!`, owner: fixture.username,
      }), 'VALIDATION')
      const view = await owner.get('/api/account/database-engines/postgresql')
      const prefix = `${fixture.username}_xqwz${tag}`
      if (view.status === 200 && view.data?.provisioning === 'available') {
        undo('postgresql wizard objects', dropPostgresql(owner, prefix))
        const roleName = `${prefix}u`, dbName = `${prefix}d`
        const role = await owner.post('/api/account/database-engines/postgresql/users', { name: roleName, password: credential() })
        const db = await owner.post('/api/account/database-engines/postgresql/databases', { name: dbName, owner: roleName })
        const after = await owner.get('/api/account/database-engines/postgresql')
        const listedRole = (after.data?.saved?.users ?? []).some(item => item?.name === roleName)
        const listedDb = (after.data?.saved?.databases ?? []).some(item => item?.name === dbName && item?.owner === roleName)
        check('WIZARD-FLOW-OR-STOPPED-GUARD', role.status === 201 && db.status === 201 && listedRole && listedDb, {
          roleStatus: role.status, dbStatus: db.status,
        })
      } else {
        const stopped = await owner.post('/api/account/database-engines/postgresql/databases', {
          name: `${prefix}d`, owner: `${prefix}u`,
        })
        check('WIZARD-FLOW-OR-STOPPED-GUARD', view.status === 200 && stopped.status === 412 && stopped.data?.code === 'PRECONDITION_FAILED', safeResponse(stopped))
      }
    },
  }),

  tool('phppgadmin', {
    prefix: 'S11T15', as: 'owner', needs: ['account'], probe: '/api/account/database-engines/phppgadmin',
    paths: /^\/api\/account\/database-engines\/phppgadmin(?:\?bad=1|\/sign-on)?$/, requests: 20,
    unit: [{ id: 'S11T15-UNIT-1', file: 'apps/api/src/db-workspace.test.ts', name: 'database workspace routes passes the phpPgAdmin status and sign-on through the same owner checks' }],
    checks: ['STATUS-SCOPED-READ', 'SELECTOR-REFUSED', 'SIGNON-BODY-GUARD'],
    async run({ owner, fixture, check, refused }) {
      const read = await owner.get('/api/account/database-engines/phppgadmin')
      check('STATUS-SCOPED-READ', read.status === 200 && read.data?.client === 'phppgadmin' && read.data?.context?.accountId === fixture.accountId && typeof read.data?.signon?.state === 'string', {
        status: read.status, state: read.data?.signon?.state ?? null, reason: read.data?.signon?.reason ?? null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/database-engines/phppgadmin?bad=1'), 'VALIDATION')
      refused('SIGNON-BODY-GUARD', await owner.post('/api/account/database-engines/phppgadmin/sign-on', { extra: 1 }), 'VALIDATION')
    },
  }),

  tool('force-https-redirect', {
    prefix: 'S11T16', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/force-https)?$/, requests: 25,
    unit: [{ id: 'S11T16-UNIT-1', file: 'apps/api/src/domain-force-https.test.ts', name: 'force HTTPS redirect refuses CERT_REQUIRED before any state change, and turning off needs no certificate' }],
    checks: ['EMPTY-IDS-REFUSED', 'UNKNOWN-DOMAIN-NOT-FOUND', 'CERT-GATE-OR-TOGGLE-RESTORED'],
    async run({ owner, check, refused, undo }) {
      refused('EMPTY-IDS-REFUSED', await owner.post('/api/domains/force-https', {
        domainIds: [], enabled: true, expectedRevision: 0,
      }), 'VALIDATION')
      refused('UNKNOWN-DOMAIN-NOT-FOUND', await owner.post('/api/domains/force-https', {
        domainIds: [ZERO_UUID], enabled: false, expectedRevision: 0,
      }), 'NOT_FOUND')
      const listed = await owner.get('/api/domains')
      const domain = (listed.data?.domains ?? [])[0]
      const revision = listed.data?.revision
      if (listed.status === 200 && typeof domain?.id === 'string') {
        const initialForce = Boolean(domain.forceHttps)
        undo('force https setting', async () => {
          const now = await owner.get('/api/domains')
          const current = (now.data?.domains ?? []).find(item => item?.id === domain.id)
          if (now.status !== 200 || !current) return false
          if (Boolean(current.forceHttps) === initialForce) return true
          return (await owner.post('/api/domains/force-https', {
            domainIds: [domain.id], enabled: initialForce, expectedRevision: now.data.revision,
          })).status === 200
        })
        const attempt = await owner.post('/api/domains/force-https', {
          domainIds: [domain.id], enabled: true, expectedRevision: revision,
        })
        const passed = (attempt.status === 200 && attempt.data?.stateChanged === true)
          || (attempt.status === 412 && attempt.data?.code === 'PRECONDITION_FAILED')
        check('CERT-GATE-OR-TOGGLE-RESTORED', passed, safeResponse(attempt))
      } else {
        check('CERT-GATE-OR-TOGGLE-RESTORED', false, { status: listed.status })
      }
    },
  }),

  tool('dnssec', {
    prefix: 'S11T17', as: 'owner', needs: ['account'], probe: '/api/dns/zones',
    paths: /^\/api\/dns\/zones(?:\/[a-z0-9.-]{1,253}\/dnssec(?:\?bad=1)?)?$/, requests: 25,
    unit: [{ id: 'S11T17-UNIT-1', file: 'apps/api/src/dnssec-workspace.test.ts', name: 'DNSSEC workspace refuses another account before reaching the agent, and turning DNSSEC off without the typed zone' }],
    checks: ['STATUS-OR-STORE-READ', 'SELECTOR-REFUSED', 'DISABLE-WITHOUT-CONFIRM-REFUSED', 'FOREIGN-ZONE-NOT-FOUND'],
    async run({ owner, fixture, check, refused }) {
      const path = `/api/dns/zones/${fixture.domain}/dnssec`
      const read = await owner.get(path)
      check('STATUS-OR-STORE-READ', read.status === 200 && read.data?.view?.zone === fixture.domain && Array.isArray(read.data?.rollovers), {
        status: read.status, store: read.data?.view?.store ?? null, signing: read.data?.view?.signing ?? null,
      })
      refused('SELECTOR-REFUSED', await owner.get(`${path}?bad=1`), 'VALIDATION')
      refused('DISABLE-WITHOUT-CONFIRM-REFUSED', await owner.post(path, { op: 'disable' }), 'VALIDATION')
      refused('FOREIGN-ZONE-NOT-FOUND', await owner.get('/api/dns/zones/unowned-zone.invalid/dnssec'), 'NOT_FOUND')
    },
  }),

  tool('site-publisher', {
    prefix: 'S11T18', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/domains(?:\/${ID}\/site-publisher(?:\/(?:preview|publish|rollback))?)?$`), requests: 30,
    unit: [{ id: 'S11T18-UNIT-1', file: 'apps/api/src/site-publisher-workspace.test.ts', name: 'site publisher protected API boundary accepts a verified publication reply only with a published recovery and index' }],
    checks: ['WORKSPACE-READ', 'PREVIEW-SAFE-HTML', 'BAD-TEMPLATE-REFUSED', 'PUBLISH-AND-ROLLBACK'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const site = await siteOf(owner)
      const domainId = site.id ?? ZERO_UUID
      const base = `/api/domains/${domainId}/site-publisher`
      const read = await owner.get(base)
      check('WORKSPACE-READ', site.id !== null && read.status === 200 && read.data?.context?.domainId === domainId && Array.isArray(read.data?.files), {
        status: read.status, recovery: read.data?.recovery?.status ?? null,
      })
      const draft = { template: 'coming-soon', lang: 'en', title: `Launching ${tag}`, message: `Site for ${fixture.domain}`, email: '', phone: '' }
      const preview = await owner.post(`${base}/preview`, draft)
      check('PREVIEW-SAFE-HTML', preview.status === 200 && typeof preview.data?.html === 'string' && preview.data.html.includes(`Launching ${tag}`) && typeof preview.data?.hash === 'string', {
        status: preview.status,
      })
      refused('BAD-TEMPLATE-REFUSED', await owner.post(`${base}/preview`, { ...draft, template: 'unknown-template' }), 'VALIDATION')
      if (site.id !== null && read.status === 200 && typeof read.data?.revision === 'string') {
        undo('site publisher rollback', async () => {
          const now = await owner.get(base)
          if (now.status !== 200) return false
          if (!now.data?.capabilities?.canRollback) return true
          return (await owner.post(`${base}/rollback`, { expectedRevision: now.data.revision })).status === 200
        })
        const published = await owner.post(`${base}/publish`, { expectedRevision: read.data.revision, draft })
        const rolledBack = typeof published.data?.revision === 'string'
          ? await owner.post(`${base}/rollback`, { expectedRevision: published.data.revision })
          : { status: 0, data: null }
        check('PUBLISH-AND-ROLLBACK', published.status === 200 && published.data?.recovery?.status === 'published' && rolledBack.status === 200 && rolledBack.data?.recovery?.status === 'restored', {
          publishStatus: published.status, rollbackStatus: rolledBack.status,
        })
      } else {
        check('PUBLISH-AND-ROLLBACK', false, { status: read.status })
      }
    },
  }),

  tool('email-routing', {
    prefix: 'S11T19', as: 'owner', needs: ['account'], probe: '/api/account/mailx/routing',
    paths: /^\/api\/account\/mailx\/routing(?:\?bad=1)?$/, requests: 25,
    unit: [{ id: 'S11T19-UNIT-1', file: 'apps/api/src/mailx-owner-routes.test.ts', name: 'owner email routing stores remote and removes the row when set back to local' }],
    checks: ['ROUTING-SCOPED-READ', 'FOREIGN-DOMAIN-NOT-FOUND', 'INVALID-MODE-REFUSED', 'REMOTE-STORED-AND-RESTORED'],
    async run({ owner, fixture, check, refused, undo }) {
      const before = await owner.get('/api/account/mailx/routing')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const row = (before.data?.domains ?? []).find(item => item?.domain === fixture.domain)
      check('ROUTING-SCOPED-READ', before.status === 200 && before.data?.context?.account === fixture.username && Boolean(row), {
        status: before.status, mode: row?.mode ?? null,
      })
      refused('FOREIGN-DOMAIN-NOT-FOUND', await owner.put('/api/account/mailx/routing', {
        domain: 'foreign.invalid', mode: 'remote', expectedRevision: rev,
      }), 'NOT_FOUND')
      refused('INVALID-MODE-REFUSED', await owner.put('/api/account/mailx/routing', {
        domain: fixture.domain, mode: 'bogus', expectedRevision: rev,
      }), 'VALIDATION')
      if (before.status === 200 && row) {
        const initialMode = row.auto ? 'auto' : (row.mode ?? 'local')
        undo('email routing mode', async () => {
          const now = await owner.get('/api/account/mailx/routing')
          const current = (now.data?.domains ?? []).find(item => item?.domain === fixture.domain)
          if (now.status !== 200 || !current) return false
          if ((current.auto ? 'auto' : current.mode) === initialMode) return true
          return (await owner.put('/api/account/mailx/routing', {
            domain: fixture.domain, mode: initialMode, expectedRevision: now.data.revision,
          })).status === 200
        })
        const saved = await owner.put('/api/account/mailx/routing', {
          domain: fixture.domain, mode: 'remote', expectedRevision: rev,
        })
        const remoteRow = (saved.data?.domains ?? []).find(item => item?.domain === fixture.domain)
        const restored = typeof saved.data?.revision === 'string'
          ? await owner.put('/api/account/mailx/routing', { domain: fixture.domain, mode: initialMode, expectedRevision: saved.data.revision })
          : { status: 0, data: null }
        check('REMOTE-STORED-AND-RESTORED', saved.status === 200 && remoteRow?.mode === 'remote' && restored.status === 200, {
          saveStatus: saved.status, restoreStatus: restored.status,
        })
      } else {
        check('REMOTE-STORED-AND-RESTORED', false, { status: before.status })
      }
    },
  }),

  tool('track-delivery', {
    prefix: 'S11T20', as: 'owner', needs: ['account'], probe: '/api/account/mailx/track-delivery',
    paths: /^\/api\/account\/mailx\/track-delivery(?:\?[A-Za-z0-9,=&._%:-]+)?$/, requests: 20,
    unit: [{ id: 'S11T20-UNIT-1', file: 'apps/api/src/mailx-owner-routes.test.ts', name: 'owner deliverability and track delivery asks the agent for the session account only and verifies the reply scope' }],
    checks: ['DELIVERY-SCOPED-BOUNDED', 'FAILURE-FILTER-ACCEPTED', 'UNKNOWN-SELECTOR-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const all = await owner.get('/api/account/mailx/track-delivery')
      const rows = all.data?.messages
      check('DELIVERY-SCOPED-BOUNDED', all.status === 200 && all.data?.scope === 'account' && all.data?.account === fixture.username && Array.isArray(rows) && rows.length <= 250, {
        status: all.status, state: all.data?.state ?? null, count: Array.isArray(rows) ? rows.length : null,
      })
      const failures = await owner.get('/api/account/mailx/track-delivery?statuses=failed,deferred')
      const noSuccess = Array.isArray(failures.data?.messages) && failures.data.messages.every(item => item?.status !== 'sent')
      check('FAILURE-FILTER-ACCEPTED', failures.status === 200 && noSuccess, {
        status: failures.status, count: Array.isArray(failures.data?.messages) ? failures.data.messages.length : null,
      })
      refused('UNKNOWN-SELECTOR-REFUSED', await owner.get('/api/account/mailx/track-delivery?bad=1'), 'VALIDATION')
    },
  }),

  tool('email-deliverability', {
    prefix: 'S11T21', as: 'owner', needs: ['account'], probe: '/api/account/mailx/deliverability',
    paths: /^\/api\/account\/mailx\/deliverability(?:\?bad=1)?$/, requests: 20,
    unit: [{ id: 'S11T21-UNIT-1', file: 'apps/api/src/mailx-owner-routes.test.ts', name: "owner deliverability and track delivery checks only the owner's domains" }],
    checks: ['OWNED-DOMAINS-LISTED', 'LIVE-CHECK-RESULTS', 'FOREIGN-DOMAIN-CHECK-REFUSED', 'SELECTOR-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const listed = await owner.get('/api/account/mailx/deliverability')
      const owned = (listed.data?.domains ?? []).some(item => item?.domain === fixture.domain)
      check('OWNED-DOMAINS-LISTED', listed.status === 200 && listed.data?.context?.account === fixture.username && owned, {
        status: listed.status, count: Array.isArray(listed.data?.domains) ? listed.data.domains.length : null,
      })
      const checked = await owner.post('/api/account/mailx/deliverability', { domains: [fixture.domain] })
      const result = (checked.data?.results ?? []).find(item => item?.domain === fixture.domain)
      check('LIVE-CHECK-RESULTS', checked.status === 200 && Boolean(result?.spf) && Boolean(result?.dkim) && Boolean(result?.dmarc), {
        status: checked.status, results: Array.isArray(checked.data?.results) ? checked.data.results.length : null,
      })
      refused('FOREIGN-DOMAIN-CHECK-REFUSED', await owner.post('/api/account/mailx/deliverability', { domains: ['foreign.invalid'] }), 'VALIDATION')
      refused('SELECTOR-REFUSED', await owner.get('/api/account/mailx/deliverability?bad=1'), 'VALIDATION')
    },
  }),

  tool('address-importer', {
    prefix: 'S11T22', as: 'owner', needs: ['account'], probe: '/api/service-users',
    paths: new RegExp(String.raw`^\/api\/(?:service-users(?:\/${ID})?|mail\/import-csv)$`), requests: 30,
    unit: [{ id: 'S11T22-UNIT-1', file: 'apps/api/src/completion-security-forwarders.test.ts', name: 'forwarder configuration security acceptance with synthetic state preserves both independently saved records when CSV and POST run concurrently' }],
    checks: ['EMPTY-CSV-REFUSED', 'CSV-PARTIAL-IMPORT-AND-WEAK-ROW', 'FOREIGN-DOMAIN-ROW-REFUSED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      refused('EMPTY-CSV-REFUSED', await owner.post('/api/mail/import-csv', { csv: '   ', kind: 'mailboxes' }), 'VALIDATION')
      const m1 = `xqi1${tag}@${fixture.domain}`, m2 = `xqi2${tag}@${fixture.domain}`, m3 = `xqi3${tag}@${fixture.domain}`
      undo('imported mailboxes', dropServiceUsers(owner, login => [m1, m2, m3].includes(login)))
      const csv = [`${m1},${credential()},256`, `${m2},123,256`, `${m3},${credential()},256`].join('\n')
      const imported = await owner.post('/api/mail/import-csv', { csv, kind: 'mailboxes' })
      const createdEmails = (imported.data?.importedMailboxes ?? []).map(item => item?.email)
      const weakFlagged = (imported.data?.errors ?? []).some(item => item?.row === 2 && typeof item?.code === 'string' && item.code.startsWith('WEAK_'))
      check('CSV-PARTIAL-IMPORT-AND-WEAK-ROW', imported.status === 200 && createdEmails.length === 2 && createdEmails.includes(m1) && createdEmails.includes(m3) && weakFlagged, {
        status: imported.status, importedCount: createdEmails.length, weakRowRejected: weakFlagged,
      })
      const foreign = await owner.post('/api/mail/import-csv', { csv: `user@foreign.invalid,${credential()},256`, kind: 'mailboxes' })
      const foreignFlagged = (foreign.data?.errors ?? []).some(item => item?.row === 1 && item?.code === 'INVALID_ADDRESS')
      check('FOREIGN-DOMAIN-ROW-REFUSED', foreign.status === 200 && (foreign.data?.importedMailboxes ?? []).length === 0 && foreignFlagged, {
        status: foreign.status, invalidAddressRejected: foreignFlagged,
      })
    },
  }),

  tool('email-encryption', {
    prefix: 'S11T23', as: 'owner', needs: ['account'], probe: '/api/account/pgp',
    paths: /^\/api\/account\/pgp(?:\?bad=1)?$/, requests: 20,
    unit: [{ id: 'S11T23-UNIT-1', file: 'apps/api/src/pgp-workspace.test.ts', name: 'OpenPGP owner API pins a read to the session account and rejects unexpected secret fields' }],
    checks: ['KEYRING-SCOPED-READ', 'SELECTOR-REFUSED', 'WEAK-KEYSIZE-REFUSED', 'UNCONFIRMED-DELETE-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const read = await owner.get('/api/account/pgp')
      const rev = typeof read.data?.revision === 'string' ? read.data.revision : ZERO_REV
      check('KEYRING-SCOPED-READ', read.status === 200 && read.data?.context?.accountId === fixture.accountId && read.data?.scope === 'account-keyring' && Array.isArray(read.data?.keys), {
        status: read.status, keys: Array.isArray(read.data?.keys) ? read.data.keys.length : null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/pgp?bad=1'), 'VALIDATION')
      refused('WEAK-KEYSIZE-REFUSED', await owner.post('/api/account/pgp', {
        op: 'generate', expectedRevision: rev, name: 'Test User', address: `xq@${fixture.domain}`, algorithm: 'rsa512', days: 30, passphrase: credential(),
      }), 'VALIDATION')
      refused('UNCONFIRMED-DELETE-REFUSED', await owner.delete('/api/account/pgp', {
        op: 'delete', expectedRevision: rev, fingerprint: 'A'.repeat(40), confirmation: 'wrong',
      }), 'VALIDATION')
    },
  }),

  tool('sender-verification', {
    prefix: 'S11T24', as: 'owner', needs: ['account', 'mailbox'], probe: '/api/mail/boxtrapper',
    paths: /^\/api\/mail\/boxtrapper(?:\?bad=1|\/[^/]+(?:\/queue)?)?$/, requests: 25,
    unit: [{ id: 'S11T24-UNIT-1', file: 'apps/api/src/mail/boxtrapper.test.ts', name: 'BoxTrapper API serves only the hosting account owner and only its own mailboxes' }],
    checks: ['MAILBOXES-LISTED', 'MAILBOX-VIEW-READ', 'FORWARD-LOOP-REFUSED', 'FOREIGN-MAILBOX-NOT-FOUND'],
    async run({ owner, fixture, check, refused }) {
      const addr = fixture.mailbox?.address ?? `xq@${fixture.domain}`
      const listed = await owner.get('/api/mail/boxtrapper')
      const hasMailbox = (listed.data?.mailboxes ?? []).some(item => item?.mailbox === addr)
      check('MAILBOXES-LISTED', listed.status === 200 && hasMailbox, {
        status: listed.status, count: Array.isArray(listed.data?.mailboxes) ? listed.data.mailboxes.length : null,
      })
      const path = `/api/mail/boxtrapper/${encodeURIComponent(addr)}`
      const view = await owner.get(path)
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      check('MAILBOX-VIEW-READ', view.status === 200 && view.data?.context?.mailbox === addr && typeof view.data?.config?.enabled === 'boolean', {
        status: view.status, enabled: view.data?.config?.enabled ?? null,
      })
      const baseConfig = view.data?.config ?? { enabled: false, fromName: '', extraAddresses: [], forward: [], autoAllow: true, templates: { verify: 'verify', returnVerify: 'return', black: 'black' } }
      refused('FORWARD-LOOP-REFUSED', await owner.put(path, {
        config: { ...baseConfig, forward: [addr] },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('FOREIGN-MAILBOX-NOT-FOUND', await owner.get(`/api/mail/boxtrapper/${encodeURIComponent('missing@foreign.invalid')}`), 'NOT_FOUND')
    },
  }),

  tool('greylisting', {
    prefix: 'S11T25', as: 'owner', needs: ['account'], probe: '/api/account/mailx/greylisting',
    paths: /^\/api\/account\/mailx\/greylisting(?:\?bad=1)?$/, requests: 25,
    unit: [{ id: 'S11T25-UNIT-1', file: 'apps/api/src/mailx-owner-routes.test.ts', name: "owner greylisting lists only the owner's domains and saves them" }],
    checks: ['OWNED-DOMAINS-READ', 'FOREIGN-DOMAIN-REFUSED', 'STALE-REVISION-CONFLICT', 'TOGGLE-AND-RESTORE'],
    async run({ owner, fixture, check, refused, undo }) {
      const before = await owner.get('/api/account/mailx/greylisting')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const initialEnabled = (before.data?.domains ?? []).filter(item => item?.enabled === true).map(item => item.domain)
      check('OWNED-DOMAINS-READ', before.status === 200 && before.data?.context?.account === fixture.username && (before.data?.domains ?? []).some(item => item?.domain === fixture.domain), {
        status: before.status, engine: before.data?.engine ?? null,
      })
      refused('FOREIGN-DOMAIN-REFUSED', await owner.put('/api/account/mailx/greylisting', {
        domains: ['foreign.invalid'], expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await owner.put('/api/account/mailx/greylisting', {
        domains: [], expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status === 200) {
        undo('greylisting domains', async () => {
          const now = await owner.get('/api/account/mailx/greylisting')
          if (now.status !== 200) return false
          const current = (now.data?.domains ?? []).filter(item => item?.enabled === true).map(item => item.domain)
          if (JSON.stringify(current) === JSON.stringify(initialEnabled)) return true
          return (await owner.put('/api/account/mailx/greylisting', { domains: initialEnabled, expectedRevision: now.data.revision })).status === 200
        })
        const enabled = await owner.put('/api/account/mailx/greylisting', { domains: [fixture.domain], expectedRevision: rev })
        const row = (enabled.data?.domains ?? []).find(item => item?.domain === fixture.domain)
        const restored = typeof enabled.data?.revision === 'string'
          ? await owner.put('/api/account/mailx/greylisting', { domains: initialEnabled, expectedRevision: enabled.data.revision })
          : { status: 0, data: null }
        check('TOGGLE-AND-RESTORE', enabled.status === 200 && row?.enabled === true && restored.status === 200, {
          enableStatus: enabled.status, restoreStatus: restored.status,
        })
      } else {
        check('TOGGLE-AND-RESTORE', false, { status: before.status })
      }
    },
  }),

  tool('email-archive', {
    prefix: 'S11T26', as: 'owner', needs: ['account', 'mailbox'], probe: '/api/account/mailx/archive',
    paths: /^\/api\/account\/mailx\/archive(?:\/retention|\?bad=1)?$/, requests: 25,
    unit: [{ id: 'S11T26-UNIT-1', file: 'apps/web/src/mailx-archive-client.test.ts', name: 'email archive client paints owned domains, saves only selected rows and confirms retention before submitting a job' }],
    checks: ['ARCHIVE-CHOICES-READ', 'FOREIGN-TARGET-REFUSED', 'UNARCHIVED-RETENTION-NOT-FOUND', 'SAVE-POLICY-AND-CLEAR'],
    async run({ owner, fixture, check, refused, undo }) {
      const addr = fixture.mailbox?.address ?? `xq@${fixture.domain}`
      const before = await owner.get('/api/account/mailx/archive')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const hasChoice = (before.data?.choices ?? []).some(item => item?.domain === fixture.domain && (item?.mailboxes ?? []).includes(addr))
      check('ARCHIVE-CHOICES-READ', before.status === 200 && before.data?.context?.account === fixture.username && hasChoice, {
        status: before.status,
      })
      refused('FOREIGN-TARGET-REFUSED', await owner.put('/api/account/mailx/archive', {
        policy: { domains: [{ domain: fixture.domain, mailbox: 'missing@foreign.invalid', incoming: true, outgoing: false, retentionDays: 30 }] },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNARCHIVED-RETENTION-NOT-FOUND', await owner.post('/api/account/mailx/archive/retention', {
        domain: fixture.domain, expectedRevision: rev,
      }), 'NOT_FOUND')
      if (before.status === 200) {
        const initialDomains = before.data?.policy?.domains ?? []
        undo('email archive policy', async () => {
          const now = await owner.get('/api/account/mailx/archive')
          if (now.status !== 200) return false
          if (JSON.stringify(now.data?.policy?.domains ?? []) === JSON.stringify(initialDomains)) return true
          return (await owner.put('/api/account/mailx/archive', { policy: { domains: initialDomains }, expectedRevision: now.data.revision })).status === 200
        })
        const saved = await owner.put('/api/account/mailx/archive', {
          policy: { domains: [{ domain: fixture.domain, mailbox: addr, incoming: true, outgoing: false, retentionDays: 30 }] },
          expectedRevision: rev,
        })
        const cleared = typeof saved.data?.revision === 'string'
          ? await owner.put('/api/account/mailx/archive', { policy: { domains: initialDomains }, expectedRevision: saved.data.revision })
          : { status: 0, data: null }
        check('SAVE-POLICY-AND-CLEAR', saved.status === 200 && (saved.data?.policy?.domains ?? []).length === 1 && cleared.status === 200, {
          saveStatus: saved.status, clearStatus: cleared.status,
        })
      } else {
        check('SAVE-POLICY-AND-CLEAR', false, { status: before.status })
      }
    },
  }),

  tool('calendars-contacts-config', {
    prefix: 'S11T27', as: 'owner', needs: ['account', 'mailbox'], probe: '/api/account/calendars-contacts/connection',
    paths: /^\/api\/account\/calendars-contacts\/connection(?:\?bad=1|\/apple\.mobileconfig(?:\?principal=[A-Za-z0-9_-]+)?)?$/, requests: 20,
    unit: [{ id: 'S11T27-UNIT-1', file: 'apps/api/src/dav-workspace.test.ts', name: 'calendars and contacts connection gives each mailbox its own domain when served, and the account login the first served one' }],
    checks: ['DAV-CONNECTION-VIEW', 'SELECTOR-REFUSED', 'UNKNOWN-PRINCIPAL-PROFILE-404'],
    async run({ owner, fixture, check, refused }) {
      const addr = fixture.mailbox?.address ?? `xq@${fixture.domain}`
      const read = await owner.get('/api/account/calendars-contacts/connection')
      const mailboxRow = (read.data?.principals ?? []).find(item => item?.kind === 'mailbox' && item?.login === addr)
      check('DAV-CONNECTION-VIEW', read.status === 200 && read.data?.port === 2080 && read.data?.authentication === 'basic-over-tls' && Boolean(mailboxRow), {
        status: read.status, port: read.data?.port ?? null, discovery: read.data?.discovery ?? null,
      })
      refused('SELECTOR-REFUSED', await owner.get('/api/account/calendars-contacts/connection?bad=1'), 'VALIDATION')
      refused('UNKNOWN-PRINCIPAL-PROFILE-404', await owner.get('/api/account/calendars-contacts/connection/apple.mobileconfig?principal=missing'), 'NOT_FOUND')
    },
  }),

  tool('calendars-contacts-management', {
    prefix: 'S11T28', as: 'owner', needs: ['account', 'mailbox'], probe: '/api/account/collaboration',
    paths: /^\/api\/account\/collaboration(?:\?bad=1|\/calendars(?:\/[0-9a-f]{32})?)?$/, requests: 25,
    unit: [{ id: 'S11T28-UNIT-1', file: 'apps/api/src/account-collaboration-workspace.test.ts', name: 'account collaboration using actual authority and existing calendar writer creates through the real guarded handler as the original account actor and verifies canonical readback' }],
    checks: ['OVERVIEW-LISTS-MAILBOX', 'FOREIGN-MAILBOX-NOT-FOUND', 'CALENDAR-CREATED-AND-DELETED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const addr = fixture.mailbox?.address ?? `xq@${fixture.domain}`
      const before = await owner.get('/api/account/collaboration')
      const row = (before.data?.mailboxes ?? []).find(item => item?.mailbox === addr)
      const rev = typeof row?.revision === 'string' ? row.revision : ZERO_REV
      check('OVERVIEW-LISTS-MAILBOX', before.status === 200 && before.data?.context?.account === fixture.username && Boolean(row), {
        status: before.status,
      })
      refused('FOREIGN-MAILBOX-NOT-FOUND', await owner.post('/api/account/collaboration/calendars', {
        mailbox: 'missing@foreign.invalid', name: 'Team', color: '#2563eb', timezone: 'UTC', expectedRevision: rev,
      }), 'NOT_FOUND')
      const calName = `Team ${tag}`
      if (before.status === 200 && typeof row?.revision === 'string') {
        undo('created collaboration calendar', async () => {
          const now = await owner.get('/api/account/collaboration')
          if (now.status !== 200) return false
          const current = (now.data?.mailboxes ?? []).find(item => item?.mailbox === addr)
          const found = (current?.calendars ?? []).find(item => item?.name === calName)
          if (!found) return true
          return (await owner.delete(`/api/account/collaboration/calendars/${found.id}`, {
            mailbox: addr, expectedRevision: current.revision,
          })).status === 200
        })
        const created = await owner.post('/api/account/collaboration/calendars', {
          mailbox: addr, name: calName, color: '#2563eb', timezone: 'UTC', expectedRevision: row.revision,
        })
        const updatedMailbox = (created.data?.mailboxes ?? []).find(item => item?.mailbox === addr)
        const target = (updatedMailbox?.calendars ?? []).find(item => item?.name === calName)
        const deleted = typeof target?.id === 'string' && typeof updatedMailbox?.revision === 'string'
          ? await owner.delete(`/api/account/collaboration/calendars/${target.id}`, { mailbox: addr, expectedRevision: updatedMailbox.revision })
          : { status: 0, data: null }
        check('CALENDAR-CREATED-AND-DELETED', created.status === 201 && Boolean(target) && deleted.status === 200, {
          createStatus: created.status, deleteStatus: deleted.status,
        })
      } else {
        check('CALENDAR-CREATED-AND-DELETED', false, { status: before.status })
      }
    },
  }),

  tool('email-disk-usage', {
    prefix: 'S11T29', as: 'owner', needs: ['account', 'mailbox'], probe: '/api/account/email/disk-usage',
    page: { route: '/email/filters', read: '/api/domains' },
    paths: /^\/api\/(?:domains|account\/email\/disk-usage(?:\?mailbox=[A-Za-z0-9.%@_-]+|\/cleanup)?)$/, requests: 20,
    unit: [{ id: 'S11T29-UNIT-1', file: 'apps/api/src/email-disk-usage-workspace.test.ts', name: 'Email Disk Usage workspace refuses an empty search, a bad mailbox, a disabled feature and the wrong method before the agent' }],
    checks: ['FOLDERS-SCOPED-READ', 'EMPTY-CUSTOM-QUERY-REFUSED', 'UNCONFIRMED-FOLDER-REFUSED', 'FOREIGN-MAILBOX-NOT-FOUND'],
    async run({ owner, fixture, check, refused }) {
      const addr = fixture.mailbox?.address ?? `xq@${fixture.domain}`
      const read = await owner.get(`/api/account/email/disk-usage?mailbox=${encodeURIComponent(addr)}`)
      check('FOLDERS-SCOPED-READ', read.status === 200 && read.data?.mailbox === addr && typeof read.data?.folders?.state === 'string', {
        status: read.status, state: read.data?.folders?.state ?? null,
      })
      refused('EMPTY-CUSTOM-QUERY-REFUSED', await owner.post('/api/account/email/disk-usage/cleanup', {
        mailbox: addr, folder: 'INBOX', preset: 'custom', query: '   ', confirmFolder: 'INBOX',
      }), 'VALIDATION')
      refused('UNCONFIRMED-FOLDER-REFUSED', await owner.post('/api/account/email/disk-usage/cleanup', {
        mailbox: addr, folder: 'INBOX', preset: 'larger-than-30mb', query: null, confirmFolder: 'Sent',
      }), 'VALIDATION')
      refused('FOREIGN-MAILBOX-NOT-FOUND', await owner.get(`/api/account/email/disk-usage?mailbox=${encodeURIComponent('other@foreign.invalid')}`), 'NOT_FOUND')
    },
  }),

  tool('web-stats-awstats', {
    prefix: 'S11T30', as: 'owner', needs: ['account'], probe: '/api/account/web-stats',
    paths: /^\/api\/account\/web-stats(?:\?[A-Za-z0-9=&._-]+)?$/, requests: 20,
    unit: [{ id: 'S11T30-UNIT-1', file: 'apps/api/src/web-stats-workspace.test.ts', name: 'web statistics workspace passes only the known selectors to the agent and returns the owner view' }],
    checks: ['AWSTATS-VIEW-SCOPED', 'SCHEME-SELECTION-READ', 'UNKNOWN-SELECTOR-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const overview = await owner.get('/api/account/web-stats')
      const hasSite = (overview.data?.sites ?? []).some(item => item?.site === fixture.domain)
      check('AWSTATS-VIEW-SCOPED', overview.status === 200 && overview.data?.context?.accountId === fixture.accountId && typeof overview.data?.engines?.awstats?.installed === 'boolean' && hasSite, {
        status: overview.status, installed: overview.data?.engines?.awstats?.installed ?? null,
      })
      const selected = await owner.get(`/api/account/web-stats?site=${encodeURIComponent(fixture.domain)}&scheme=https`)
      check('SCHEME-SELECTION-READ', selected.status === 200 && selected.data?.context?.accountId === fixture.accountId, {
        status: selected.status,
      })
      refused('UNKNOWN-SELECTOR-REFUSED', await owner.get('/api/account/web-stats?bad=1'), 'VALIDATION')
    },
  }),

  tool('web-stats-webalizer', {
    prefix: 'S11T31', as: 'owner', needs: ['account'], probe: '/api/account/web-stats',
    paths: /^\/api\/account\/web-stats(?:\?[A-Za-z0-9=&._-]+|\/webalizer\/https?\/[a-z0-9.-]{1,253}\/[a-z_0-9.]{1,40}(?:\?bad=1)?)?$/, requests: 20,
    unit: [{ id: 'S11T31-UNIT-1', file: 'apps/api/src/web-stats-workspace.test.ts', name: 'web statistics workspace serves Webalizer pages as sandboxed documents and their graphs as images' }],
    checks: ['HTTP-AND-HTTPS-SCHEMES-SEPARATE', 'REPORT-SELECTOR-REFUSED', 'HTTP-SELECTION-READ'],
    async run({ owner, fixture, check, refused }) {
      const overview = await owner.get('/api/account/web-stats')
      const site = (overview.data?.sites ?? []).find(item => item?.site === fixture.domain)
      check('HTTP-AND-HTTPS-SCHEMES-SEPARATE', overview.status === 200 && Boolean(site?.schemes?.http) && Boolean(site?.schemes?.https) && typeof overview.data?.engines?.webalizer?.installed === 'boolean', {
        status: overview.status, installed: overview.data?.engines?.webalizer?.installed ?? null,
      })
      refused('REPORT-SELECTOR-REFUSED', await owner.get(`/api/account/web-stats/webalizer/https/${fixture.domain}/index.html?bad=1`), 'VALIDATION')
      const httpView = await owner.get(`/api/account/web-stats?site=${encodeURIComponent(fixture.domain)}&scheme=http`)
      check('HTTP-SELECTION-READ', httpView.status === 200 && httpView.data?.context?.accountId === fixture.accountId, {
        status: httpView.status,
      })
    },
  }),

  tool('web-stats-ftp', {
    prefix: 'S11T32', as: 'owner', needs: ['account'], probe: '/api/account/ftp/monthly-report?month=2026-01',
    paths: /^\/api\/account\/ftp\/monthly-report(?:\?month=[A-Za-z0-9-]+)?$/, requests: 20,
    unit: [{ id: 'S11T32-UNIT-1', file: 'apps/agent/src/ftp-log.test.ts', name: 'pure-ftpd journal parser aggregates logins, transfers, top users and clients, and failed-login bursts per client' }],
    checks: ['MONTHLY-REPORT-SCOPED', 'BAD-MONTH-REFUSED', 'MISSING-MONTH-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const month = new Date().toISOString().slice(0, 7)
      const report = await owner.get(`/api/account/ftp/monthly-report?month=${month}`)
      check('MONTHLY-REPORT-SCOPED', report.status === 200 && report.data?.context?.accountId === fixture.accountId && report.data?.month === month && typeof report.data?.totals?.transfers === 'number', {
        status: report.status, state: report.data?.state ?? null, transfers: report.data?.totals?.transfers ?? null,
      })
      refused('BAD-MONTH-REFUSED', await owner.get('/api/account/ftp/monthly-report?month=2026-13'), 'VALIDATION')
      refused('MISSING-MONTH-REFUSED', await owner.get('/api/account/ftp/monthly-report'), 'VALIDATION')
    },
  }),

  tool('metrics-editor', {
    prefix: 'S11T33', as: 'owner', needs: ['account'], probe: '/api/account/web-stats', requires_qualification_admission: true,
    paths: /^\/api\/account\/web-stats$/, requests: 25,
    unit: [{ id: 'S11T33-UNIT-1', file: 'apps/api/src/web-stats-workspace.test.ts', name: 'saved statistics configuration refuses a locked engine with FORBIDDEN and changes nothing' }],
    checks: ['CHOICES-READ', 'FOREIGN-SITE-NOT-FOUND', 'STALE-REVISION-CONFLICT', 'SAVE-OR-ADMIN-LOCK-ENFORCED'],
    async run({ owner, fixture, check, refused, undo }) {
      const before = await owner.get('/api/account/web-stats')
      const rev = typeof before.data?.choice?.revision === 'string' ? before.data.choice.revision : ZERO_REV
      const siteRow = (before.data?.sites ?? []).find(item => item?.site === fixture.domain)
      const choosable = before.data?.choice?.choosable ?? []
      check('CHOICES-READ', before.status === 200 && Array.isArray(choosable) && Boolean(siteRow), {
        status: before.status, choosableCount: Array.isArray(choosable) ? choosable.length : null,
      })
      refused('FOREIGN-SITE-NOT-FOUND', await owner.put('/api/account/web-stats', {
        revision: rev, sites: { 'foreign.invalid': [] },
      }), 'NOT_FOUND')
      refused('STALE-REVISION-CONFLICT', await owner.put('/api/account/web-stats', {
        revision: ZERO_REV, sites: { [fixture.domain]: siteRow?.selected ?? [] },
      }), 'CONFLICT')
      if (before.status === 200 && siteRow && typeof before.data?.choice?.revision === 'string') {
        const initialSelected = siteRow.selected ?? []
        if (choosable.includes('webalizer')) {
          undo('metrics editor selection', async () => {
            const now = await owner.get('/api/account/web-stats')
            const cur = (now.data?.sites ?? []).find(item => item?.site === fixture.domain)
            if (now.status !== 200 || !cur || typeof now.data?.choice?.revision !== 'string') return false
            if (JSON.stringify(cur.selected) === JSON.stringify(initialSelected)) return true
            return (await owner.put('/api/account/web-stats', {
              revision: now.data.choice.revision, sites: { [fixture.domain]: initialSelected },
            })).status === 200
          })
          const next = initialSelected.includes('webalizer')
            ? initialSelected.filter(item => item !== 'webalizer')
            : [...initialSelected, 'webalizer']
          const saved = await owner.put('/api/account/web-stats', {
            revision: before.data.choice.revision, sites: { [fixture.domain]: next },
          })
          const restored = typeof saved.data?.revision === 'string'
            ? await owner.put('/api/account/web-stats', { revision: saved.data.revision, sites: { [fixture.domain]: initialSelected } })
            : { status: 0, data: null }
          check('SAVE-OR-ADMIN-LOCK-ENFORCED', saved.status === 200 && restored.status === 200, {
            saveStatus: saved.status, restoreStatus: restored.status,
          })
        } else {
          const toggled = initialSelected.includes('webalizer')
            ? initialSelected.filter(item => item !== 'webalizer')
            : [...initialSelected, 'webalizer']
          const locked = await owner.put('/api/account/web-stats', {
            revision: before.data.choice.revision, sites: { [fixture.domain]: toggled },
          })
          check('SAVE-OR-ADMIN-LOCK-ENFORCED', locked.status === 403 && locked.data?.code === 'FORBIDDEN', safeResponse(locked))
        }
      } else {
        check('SAVE-OR-ADMIN-LOCK-ENFORCED', false, { status: before.status })
      }
    },
  }),
]
