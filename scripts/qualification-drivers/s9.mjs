import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createAccount, tool } from './kit.mjs'

const CAPS = { addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8 }
const RESOURCES = { diskMb: 2048, bandwidthMbMonth: 10240, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 }
const gone = response => [200, 204, 404].includes(response.status)
let scratchSeq = 0

const loginBody = fixture => ({ username: fixture.username, password: fixture.password })
const sessionOf = login => login.setCookie?.find(value => value.startsWith('__Host-xpanel_session='))?.split(';')[0]
/** An owner session made outside signIn, so an undo step can use a credential the run changed. */
async function ownerLogin(owner, username, password) {
  const login = await owner.anonymous('/api/auth/login', { method: 'POST', body: { username, password } }), cookie = sessionOf(login)
  return login.status === 200 && cookie !== undefined ? { cookie, csrf: login.data?.csrfToken, status: login.status } : { status: login.status }
}
const ownerLogout = (owner, session) => owner.anonymous('/api/auth/logout', { method: 'POST', body: {}, cookie: session.cookie, csrf: session.csrf })
const firstDomain = async owner => {
  const listed = await owner.get('/api/domains'), domain = listed.data?.domains?.[0]
  return { listed, id: domain?.id, name: domain?.name }
}

/** The owner's domain workspace: the revision every domain write must carry, the home and the domains. */
const workspaceOf = async owner => {
  const response = await owner.get('/api/domains')
  return { response, revision: response.data?.revision, home: response.data?.context?.home, domains: response.data?.domains ?? [] }
}
const desiredPhp = php => ({ version: php.version, handler: php.handler, fpm: php.fpm, ini: php.ini })
const docRootRel = (space, domain) => domain.docRoot.startsWith(`${space.home}/`) ? domain.docRoot.slice(space.home.length + 1) : domain.docRoot
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)
/** Puts a PHP setting back and confirms the readback, for an undo step. */
const restorePhp = (owner, domainId, php) => async () => {
  const now = await workspaceOf(owner), current = now.domains.find(item => item.id === domainId)
  if (!current) return false
  if (sameJson(desiredPhp(current.php), php)) return true
  const back = await owner.patch(`/api/domains/${domainId}`, { php, expectedRevision: now.revision })
  return back.status === 200 && sameJson(desiredPhp(back.data?.domain?.php ?? {}), php)
}

/** RFC 6238 code for a base32 secret, shifted by whole 30 second steps. */
const totp = (secret, steps = 0) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits = [...secret.replace(/=+$/, '').toUpperCase()].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('')
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2))), counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps))
  const digest = createHmac('sha1', key).update(counter).digest(), offset = digest[19] & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
/** Disables one tool in the run's own feature list (the fixture made it) and registers the restore. */
const disableFeature = async (root, fixture, feature, undo) => {
  const find = async () => (await root.get('/api/feature-lists')).data?.featureLists?.find(item => item.name === `xq-${fixture.username.slice(2)}`)
  const list = await find()
  if (!list) return null
  undo('run feature list', async () => {
    const now = await find()
    if (!now) return false
    if (sameJson(now.disabled, list.disabled)) return true
    const back = await root.patch(`/api/feature-lists/${list.id}`, { disabled: list.disabled })
    return back.status === 200 && sameJson(back.data?.featureList?.disabled, list.disabled)
  })
  const changed = await root.patch(`/api/feature-lists/${list.id}`, { disabled: [...new Set([...list.disabled, feature])] })
  return changed.status === 200 ? list : null
}

/** The criterion names a password code: the observation keeps status and returned code only, never the expectation text. */
const refusedPassword = (check, id, response, code) => check(id, response.status >= 400 && response.data?.code === code, { status: response.status ?? null, code: typeof response.data?.code === 'string' && /^[A-Z_]{1,64}$/.test(response.data.code) ? response.data.code : null })

export default [
  tool('api-tokens', {
    prefix: 'APT', as: 'owner', needs: ['account'], probe: '/api/auth/api-tokens',
    paths: /^\/api\/(?:auth\/api-tokens(?:\/[0-9a-f-]{36}\/revoke)?|databases)$/,
    page: { route: '/security/account', read: '/api/auth/me', shows: data => [data?.principal?.username] },
    unit: [
      { id: 'APT-UNIT-SECRET-ONCE', file: 'apps/api/src/panel-tokens-workspace.test.ts', name: 'API tokens workspace shows the raw token exactly once, stores only its sha256 and never lists the hash' },
      { id: 'APT-UNIT-MALFORMED', file: 'apps/api/src/panel-tokens-workspace.test.ts', name: 'API tokens workspace rejects malformed requests with 400 and wrong methods with 405' },
    ],
    checks: ['INVALID-NAME', 'SECRET-IN-CREATE', 'SECRET-NOT-LISTED', 'TOKEN-WORKS', 'READ-ONLY-WRITE-403', 'REVOKED-401', 'ZERO-EXPIRY-REFUSED'],
    async run({ owner, tag, check, ok, refused, undo }) {
      refused('INVALID-NAME', await owner.post('/api/auth/api-tokens', { name: 'my token', scopes: ['databases:read'], expiresInDays: 1 }), 'VALIDATION')
      const created = await owner.post('/api/auth/api-tokens', { name: `xq-${tag}`, scopes: ['databases:read'], expiresInDays: 1 })
      const id = created.data?.token?.id, secret = created.data?.secret
      if (!check('SECRET-IN-CREATE', created.status === 201 && typeof id === 'string' && typeof secret === 'string' && secret.length > 16, { status: created.status })) return
      undo('API token', async () => [200, 404, 409].includes((await owner.post(`/api/auth/api-tokens/${id}/revoke`, undefined, { noBody: true })).status))
      const listed = await owner.get('/api/auth/api-tokens')
      check('SECRET-NOT-LISTED', listed.status === 200 && listed.data?.tokens?.some(token => token.id === id) === true && !JSON.stringify(listed.data).includes(secret), { status: listed.status })
      ok('TOKEN-WORKS', await owner.anonymous('/api/databases', { bearer: secret }))
      refused('READ-ONLY-WRITE-403', await owner.anonymous('/api/databases', { method: 'POST', bearer: secret, body: {} }), 403)
      await owner.post(`/api/auth/api-tokens/${id}/revoke`, undefined, { noBody: true })
      refused('REVOKED-401', await owner.anonymous('/api/databases', { bearer: secret }), 401)
      refused('ZERO-EXPIRY-REFUSED', await owner.post('/api/auth/api-tokens', { name: `xq-${tag}-exp`, scopes: ['databases:read'], expiresInDays: 0 }), 'VALIDATION')
    },
  }),

  tool('ssh-access', {
    prefix: 'SSH', as: 'owner', needs: ['account'], probe: '/api/account/ssh/keys',
    page: { route: '/security/ssh', read: '/api/account/ssh/keys', shows: () => ['SSH access'] },
    paths: /^\/api\/account\/ssh\/keys$/,
    unit: [{ id: 'SSH-UNIT-1', file: 'apps/api/src/account-ssh-workspace.test.ts', name: 'account SSH key workspace lists, adds the canonical line and removes by fingerprint for the account owner' }],
    checks: ['KEYGEN-RESERVED-NAME', 'KEYS-READ', 'AUTHORIZE-ONE-LINE', 'DUPLICATE-KEY-CONFLICT', 'DEAUTHORIZE-REMOVES-LINE', 'MISSING-KEY-REMOVE-NOT-FOUND'],
    async run({ owner, tag, check, ok, refused, undo }) {
      const { publicKey } = generateKeyPairSync('ed25519'), x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
      const part = bytes => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes])
      const blob = Buffer.concat([part(Buffer.from('ssh-ed25519')), part(x)])
      const line = `ssh-ed25519 ${blob.toString('base64')} xq-${tag}`, fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
      const before = await owner.get('/api/account/ssh/keys')
      if (!ok('KEYS-READ', before)) return
      refused('KEYGEN-RESERVED-NAME', await owner.post('/api/account/ssh/keys', { expectedRevision: before.data.file.revision, key: 'authorized_keys' }), 'VALIDATION')
      const count = before.data.keys.length
      undo('authorized SSH key', async () => {
        const view = await owner.get('/api/account/ssh/keys')
        if (view.status !== 200) return false
        if (!view.data.keys.some(key => key.fingerprint === fingerprint)) return true
        const removed = await owner.delete('/api/account/ssh/keys', { expectedRevision: view.data.file.revision, fingerprint })
        return removed.status === 200 && !removed.data.keys.some(key => key.fingerprint === fingerprint)
      })
      const added = await owner.post('/api/account/ssh/keys', { expectedRevision: before.data.file.revision, key: line })
      check('AUTHORIZE-ONE-LINE', added.status === 200 && added.data?.keys?.filter(key => key.fingerprint === fingerprint).length === 1 && added.data.keys.length === count + 1, { status: added.status, keysBefore: count, keysAfter: added.data?.keys?.length ?? null })
      if (added.status === 200) {
        refused('DUPLICATE-KEY-CONFLICT', await owner.post('/api/account/ssh/keys', { expectedRevision: added.data.file.revision, key: line }), 'CONFLICT')
        const removed = await owner.delete('/api/account/ssh/keys', { expectedRevision: added.data.file.revision, fingerprint })
        check('DEAUTHORIZE-REMOVES-LINE', removed.status === 200 && removed.data?.keys?.length === count && !removed.data.keys.some(key => key.fingerprint === fingerprint), { status: removed.status, keysAfter: removed.data?.keys?.length ?? null })
        if (removed.status === 200) refused('MISSING-KEY-REMOVE-NOT-FOUND', await owner.delete('/api/account/ssh/keys', { expectedRevision: removed.data.file.revision, fingerprint }), 'NOT_FOUND')
        else check('MISSING-KEY-REMOVE-NOT-FOUND', false, { status: removed.status })
      } else {
        check('DUPLICATE-KEY-CONFLICT', false, { status: added.status })
        check('DEAUTHORIZE-REMOVES-LINE', false, { status: added.status })
        check('MISSING-KEY-REMOVE-NOT-FOUND', false, { status: added.status })
      }
    },
  }),

  tool('account-preferences', {
    prefix: 'APR', as: 'owner', needs: ['account'], probe: '/api/account/preferences',
    paths: /^\/api\/(?:account\/preferences|auth\/personal-preferences)$/,
    unit: [{ id: 'APR-UNIT-1', file: 'apps/api/src/completion-account-contact-security.test.ts', name: 'trusted-self contact metadata API with real synthetic SQLite takes the account only from the authenticated principal despite hostile identity headers' }],
    checks: ['PREFERENCES-READ', 'WRONG-PASSWORD-REFUSED', 'OLD-EMAIL-KEPT', 'POSITION-SAVED', 'POSITION-PERSISTS-RELOGIN', 'INVALID-POSITION-REFUSED'],
    async run({ owner, fixture, check, refused, signIn, undo }) {
      const before = await owner.get('/api/account/preferences'), email = before.data?.preferences?.contactEmail
      const beforePersonal = await owner.get('/api/auth/personal-preferences')
      if (!check('PREFERENCES-READ', before.status === 200 && beforePersonal.status === 200, { status: before.status, personalStatus: beforePersonal.status })) return
      undo('account preferences', async () => {
        const now = await owner.get('/api/account/preferences')
        if (now.status !== 200) return false
        if (now.data.preferences.contactEmail === email) return true
        const back = await owner.patch('/api/account/preferences', { contactEmail: email, expectedRevision: now.data.revision, currentPassword: fixture.password })
        return back.status === 200 && back.data.preferences.contactEmail === email
      })
      const origPersonal = {
        locale: beforePersonal.data.locale,
        noticePosition: beforePersonal.data.noticePosition,
        notifications: beforePersonal.data.notifications,
        onboardingDismissed: beforePersonal.data.onboardingDismissed,
      }
      undo('personal preferences', async () => {
        const now = await owner.get('/api/auth/personal-preferences')
        if (now.status !== 200) return false
        if (now.data.locale === origPersonal.locale && now.data.noticePosition === origPersonal.noticePosition && sameJson(now.data.notifications, origPersonal.notifications) && now.data.onboardingDismissed === origPersonal.onboardingDismissed) return true
        const back = await owner.put('/api/auth/personal-preferences', { ...origPersonal, expectedRevision: now.data.revision })
        return back.status === 200 && back.data.noticePosition === origPersonal.noticePosition
      })
      refusedPassword(check, 'WRONG-PASSWORD-REFUSED', await owner.patch('/api/account/preferences', { contactEmail: `xq-changed@${fixture.domain}`, expectedRevision: before.data.revision, currentPassword: 'Wrong-Password-0' }), 'UNAUTHENTICATED')
      const after = await owner.get('/api/account/preferences')
      check('OLD-EMAIL-KEPT', after.status === 200 && after.data?.preferences?.contactEmail === email, { status: after.status })
      const saved = await owner.put('/api/auth/personal-preferences', { ...origPersonal, noticePosition: 'bottom-left', expectedRevision: beforePersonal.data.revision })
      check('POSITION-SAVED', saved.status === 200 && saved.data?.noticePosition === 'bottom-left', { status: saved.status })
      const again = await signIn('owner', loginBody(fixture))
      const reread = await again.client?.get('/api/auth/personal-preferences')
      check('POSITION-PERSISTS-RELOGIN', reread?.status === 200 && reread.data?.noticePosition === 'bottom-left', { signIn: again.response.status, status: reread?.status ?? null })
      refused('INVALID-POSITION-REFUSED', await owner.put('/api/auth/personal-preferences', { ...origPersonal, noticePosition: 'middle-nowhere', expectedRevision: reread?.data?.revision ?? saved.data?.revision ?? beforePersonal.data.revision }), 'VALIDATION')
    },
  }),

  tool('password-security', {
    prefix: 'PWS', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/(?:auth\/(?:change-password|login|logout)|feature-lists(?:\/[0-9a-f-]{36})?|plans(?:\/[0-9a-f-]{36})?|accounts(?:\/xq[0-9a-f]{8}pw)?)$/,
    accounts: 1, requests: 50, deadlineMs: 300_000,
    unit: [{ id: 'PWS-UNIT-1', file: 'apps/api/src/password-policy.test.ts', name: 'password policy keeps the 8-character rule for every service' }],
    checks: ['WRONG-CURRENT', 'WEAK-NEW', 'CHANGE-SUCCEEDS', 'OLD-PASSWORD-REFUSED', 'NEW-PASSWORD-LOGS-IN'],
    async run(x) {
      const { owner, root, tag, check, ok, undo } = x
      const list = await root.post('/api/feature-lists', { name: `xq-${tag}-pw`, ownerId: null, disabled: [] }), listId = list.data?.featureList?.id
      if (list.status !== 201 || typeof listId !== 'string') return check('WRONG-CURRENT', false, { status: list.status })
      undo('password feature list', async () => gone(await root.delete(`/api/feature-lists/${listId}`)))
      const plan = await root.post('/api/plans', { name: `xq-${tag}-pw`, featureListId: listId, resources: RESOURCES, caps: CAPS }), planId = plan.data?.plan?.id
      if (plan.status !== 201 || typeof planId !== 'string') return check('WRONG-CURRENT', false, { status: plan.status })
      undo('password plan', async () => gone(await root.delete(`/api/plans/${planId}`)))
      const username = `xq${tag}pw`, initPassword = `Xq-${randomBytes(12).toString('base64url')}-1a`, next = `Xq-${randomBytes(12).toString('base64url')}-2b`
      undo('password account', async () => gone(await root.delete(`/api/accounts/${username}`, { confirmUsername: username })))
      const created = await createAccount(root, { username, password: initPassword, primaryDomain: `${username}.example.net`, planId }, { idempotencyKey: `xq-${tag}-pw-${++scratchSeq}` }, x)
      if (!created.created) return check('WRONG-CURRENT', false, { status: created.status })
      const session = await ownerLogin(owner, username, initPassword)
      if (!session.cookie) return check('WRONG-CURRENT', false, { status: session.status })
      const change = body => owner.anonymous('/api/auth/change-password', { method: 'POST', body, cookie: session.cookie, csrf: session.csrf })
      refusedPassword(check, 'WRONG-CURRENT', await change({ currentPassword: 'Wrong-Password-0', newPassword: next }), 'UNAUTHENTICATED')
      refusedPassword(check, 'WEAK-NEW', await change({ currentPassword: initPassword, newPassword: 'abc' }), 'VALIDATION')
      if (!ok('CHANGE-SUCCEEDS', await change({ currentPassword: initPassword, newPassword: next }))) {
        await ownerLogout(owner, session)
        return
      }
      const old = await ownerLogin(owner, username, initPassword)
      check('OLD-PASSWORD-REFUSED', old.status === 401, { status: old.status })
      if (old.cookie) await ownerLogout(owner, old)
      const fresh = await ownerLogin(owner, username, next)
      check('NEW-PASSWORD-LOGS-IN', fresh.status === 200, { status: fresh.status })
      if (fresh.cookie) await ownerLogout(owner, fresh)
    },
  }),

  tool('raw-access', {
    prefix: 'RAW', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains|account\/logs\/(?:settings|[0-9a-f-]{36}\/access(?:\/download)?))$/,
    unit: [{ id: 'RAW-UNIT-1', file: 'apps/api/src/account-logs-workspace.test.ts', name: 'account site logs workspace returns parsed access entries for an owned domain with the unparsed count' }],
    checks: ['DOMAIN-READ', 'GZIP-DOWNLOAD', 'LINES-MATCH-ACCESS-LOG', 'RETENTION-SAVED', 'RETENTION-INVALID'],
    async run({ owner, tag, site, check, refused, until, undo }) {
      const domain = await firstDomain(owner)
      if (!check('DOMAIN-READ', domain.listed.status === 200 && typeof domain.id === 'string', { status: domain.listed.status })) return
      const path = `/api/account/logs/${domain.id}/access`
      await site.get(domain.name, `/xq-${tag}-raw`)
      const seen = await until(() => owner.get(path), response => response.data?.entries?.some(entry => entry.uri === `/xq-${tag}-raw`) === true, { attempts: 6, delayMs: 1000 }), log = seen.last
      const download = await owner.get(`${path}/download`)
      check('GZIP-DOWNLOAD', download.status === 200 && /gzip/.test(download.contentType ?? ''), { status: download.status, contentType: download.contentType ?? null })
      check('LINES-MATCH-ACCESS-LOG', seen.settled && log.status === 200 && log.data.entries.every(entry => entry.host === domain.name), { status: log.status, entries: log.data?.entries?.length ?? null })
      const beforeSettings = await owner.get('/api/account/logs/settings')
      if (beforeSettings.status === 200) {
        const initial = beforeSettings.data?.source === 'account' ? beforeSettings.data.settings : null
        undo('log retention settings', async () => (await owner.put('/api/account/logs/settings', { settings: initial })).status === 200)
      }
      const valid = await owner.put('/api/account/logs/settings', { settings: { archive: true, removePreviousMonthArchive: false, retentionDays: 7 } })
      check('RETENTION-SAVED', valid.status === 200 && valid.data?.settings?.retentionDays === 7 && valid.data?.source === 'account', { status: valid.status })
      refused('RETENTION-INVALID', await owner.put('/api/account/logs/settings', { settings: { archive: true, removePreviousMonthArchive: false, retentionDays: -2 } }), 'VALIDATION')
    },
  }),

  tool('errors', {
    prefix: 'ERR', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains|account\/logs\/[0-9a-f-]{36}\/error(?:\?lines=300)?)$/,
    unit: [{ id: 'ERR-UNIT-1', file: 'apps/api/src/account-logs-workspace.test.ts', name: 'account site logs workspace hides foreign domains and refuses other roles or disabled log features before any agent read' }],
    checks: ['DOMAIN-READ', 'BOUNDED-TAIL-AND-SELECTOR-REFUSED', 'NEWEST-FIRST', 'OWN-VHOST-ONLY', 'FOREIGN-VHOST-REFUSED'],
    async run({ owner, check, refused }) {
      const domain = await firstDomain(owner)
      if (!check('DOMAIN-READ', domain.listed.status === 200 && typeof domain.id === 'string', { status: domain.listed.status })) return
      const log = await owner.get(`/api/account/logs/${domain.id}/error`)
      const selector = await owner.get(`/api/account/logs/${domain.id}/error?lines=300`)
      check('BOUNDED-TAIL-AND-SELECTOR-REFUSED', log.status === 200 && log.data?.limits?.maxLines === 2000 && selector.status >= 400 && selector.data?.code === 'VALIDATION', { status: log.status, maxLines: log.data?.limits?.maxLines ?? null, selectorStatus: selector.status })
      const times = (log.data?.entries ?? []).map(entry => Date.parse(entry.time)).filter(Number.isFinite)
      check('NEWEST-FIRST', log.status === 200 && Array.isArray(log.data?.entries) && times.every((time, index) => index === 0 || times[index - 1] >= time), { status: log.status, timed: times.length })
      check('OWN-VHOST-ONLY', log.status === 200 && log.data?.context?.domainName === domain.name, { status: log.status })
      refused('FOREIGN-VHOST-REFUSED', await owner.get('/api/account/logs/00000000-0000-4000-8000-000000000000/error'), 404)
    },
  }),

  tool('modsecurity', {
    prefix: 'WAF', as: 'owner', needs: ['account'], probe: '/api/account/sec/waf',
    paths: /^\/api\/account\/sec\/waf$/,
    requests: 40,
    unit: [{ id: 'WAF-UNIT-1', file: 'apps/api/src/sec-workspace.test.ts', name: 'sec server workspaces saves under CAS with a re-read, audits, then requests reconciliation' }],
    checks: ['WAF-READ', 'WAF-OFF-SAVED', 'WAF-ON-SAVED', 'OFF-DOMAIN-REACHES-APP', 'ON-DOMAIN-BLOCKED-403', 'FOREIGN-DOMAIN-FORBIDDEN'],
    async run({ owner, fixture, tag, site, check, ok, refused, until, undo }) {
      const before = await owner.get('/api/account/sec/waf'), entry = before.data?.domains?.find(item => item.domain === fixture.domain)
      if (!check('WAF-READ', before.status === 200 && typeof entry?.modsecurity === 'boolean', { status: before.status })) return
      const original = entry.modsecurity
      const setSwitch = async (domain, modsecurity) => {
        const now = await owner.get('/api/account/sec/waf')
        return owner.put('/api/account/sec/waf', { domain, modsecurity, expectedRevision: now.data?.revision })
      }
      undo('ModSecurity switch', async () => {
        const now = await owner.get('/api/account/sec/waf')
        if (now.data?.domains?.find(item => item.domain === fixture.domain)?.modsecurity === original) return true
        const back = await setSwitch(fixture.domain, original)
        return back.status === 200 && back.data?.domains?.find(item => item.domain === fixture.domain)?.modsecurity === original
      })
      const attack = `/?id=1%27%20OR%20%271%27%3D%271%27%20UNION%20SELECT%20NULL--&xq=${tag}`
      const probe = () => site.get(fixture.domain, attack)
      if (ok('WAF-OFF-SAVED', await setSwitch(fixture.domain, false))) {
        const open = await until(probe, response => response.status !== 403, { attempts: 6, delayMs: 1500 })
        check('OFF-DOMAIN-REACHES-APP', open.settled, { status: open.last?.status ?? null })
      }
      if (ok('WAF-ON-SAVED', await setSwitch(fixture.domain, true))) {
        const closed = await until(probe, response => response.status === 403, { attempts: 6, delayMs: 1500 })
        check('ON-DOMAIN-BLOCKED-403', closed.settled, { status: closed.last?.status ?? null })
      }
      refused('FOREIGN-DOMAIN-FORBIDDEN', await setSwitch(`xq-${tag}.foreign.example`, true), 'NOT_FOUND')
    },
  }),

  tool('manage-team', {
    prefix: 'TEAM', as: 'owner', needs: ['account'], probe: '/api/account/team',
    paths: /^\/api\/(?:account\/team(?:\/[0-9a-f-]{36}(?:\/(?:suspend|password-link))?)?|auth\/(?:team\/password|login|logout|me)|databases)$/,
    requests: 80,
    unit: [{ id: 'TEAM-UNIT-1', file: 'apps/api/src/acct-team-workspace.test.ts', name: 'team grammar accepts exact bodies and refuses unknown keys, bad names and bad expiry' }],
    checks: ['TEAM-READ', 'EIGHTH-ROLE-HOLDER-LIMIT', 'EMAIL-ROLE-DATABASE-FORBIDDEN', 'SUSPEND-BLOCKS-LOGIN', 'SUSPEND-REVOKES-SESSION'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const read = await owner.get('/api/account/team')
      if (!check('TEAM-READ', read.status === 200 && Array.isArray(read.data?.members), { status: read.status })) return
      const prefix = `xq${tag}`
      undo('team members', async () => {
        for (let round = 0; round < 12; round++) {
          const now = await owner.get('/api/account/team'), mine = now.data?.members?.filter(member => member.username.startsWith(prefix))
          if (now.status !== 200) return false
          if (mine.length === 0) return true
          const removed = await owner.delete(`/api/account/team/${mine[0].id}`, { expectedRevision: now.data.revision, confirmUsername: mine[0].username })
          if (removed.status !== 200) return false
        }
        return false
      })
      let last, firstMember = null
      for (let index = 0; index < 8; index++) {
        const now = index === 0 ? read : await owner.get('/api/account/team')
        last = await owner.post('/api/account/team', { username: `${prefix}${index}`, roles: ['email'], contactEmail: `xq@${fixture.domain}`, notes: '', expiresAt: null, expiryReason: null, expectedRevision: now.data?.revision })
        if (index === 0 && last.status === 201) firstMember = last.data?.members?.find(item => item.id === last.data?.changed) ?? last.data?.member
        if (index < 7 && last.status !== 201) break
      }
      refused('EIGHTH-ROLE-HOLDER-LIMIT', last, 'LIMIT_EXCEEDED')
      if (!firstMember?.id) {
        for (const id of ['EMAIL-ROLE-DATABASE-FORBIDDEN', 'SUSPEND-BLOCKS-LOGIN', 'SUSPEND-REVOKES-SESSION']) check(id, false, { created: false })
        return
      }
      const teamNow = await owner.get('/api/account/team')
      const link = await owner.post(`/api/account/team/${firstMember.id}/password-link`, { expectedRevision: teamNow.data?.revision })
      const token = link.data?.passwordLink?.path?.split('#team-password=')[1], secret = `Xq-${tag}-Tm8!vP4#nK2zLq7`
      const pwd = typeof token === 'string' ? await owner.anonymous('/api/auth/team/password', { method: 'POST', body: { token, password: secret } }) : { status: 0 }
      const memberLogin = `${firstMember.username}@${fixture.domain}`
      const memberSession = pwd.status === 200 ? await ownerLogin(owner, memberLogin, secret) : { status: pwd.status }
      if (!memberSession.cookie) {
        for (const id of ['EMAIL-ROLE-DATABASE-FORBIDDEN', 'SUSPEND-BLOCKS-LOGIN', 'SUSPEND-REVOKES-SESSION']) check(id, false, { linkStatus: link.status, passwordStatus: pwd.status, loginStatus: memberSession.status })
        return
      }
      undo('team member session', async () => [200, 204, 401].includes((await ownerLogout(owner, memberSession)).status))
      refused('EMAIL-ROLE-DATABASE-FORBIDDEN', await owner.anonymous('/api/databases', { cookie: memberSession.cookie }), 'FORBIDDEN')
      const beforeSuspend = await owner.get('/api/account/team')
      const suspended = await owner.post(`/api/account/team/${firstMember.id}/suspend`, { expectedRevision: beforeSuspend.data?.revision, reason: 'xq qualification' })
      if (suspended.status === 200) {
        refused('SUSPEND-BLOCKS-LOGIN', await owner.anonymous('/api/auth/login', { method: 'POST', body: { username: memberLogin, password: secret } }), 'FORBIDDEN')
        const afterRevoke = await owner.anonymous('/api/auth/me', { cookie: memberSession.cookie })
        check('SUSPEND-REVOKES-SESSION', afterRevoke.status === 401, { status: afterRevoke.status })
      } else {
        check('SUSPEND-BLOCKS-LOGIN', false, { suspendStatus: suspended.status })
        check('SUSPEND-REVOKES-SESSION', false, { suspendStatus: suspended.status })
      }
    },
  }),

  tool('account-health-overview', {
    prefix: 'AHO', as: 'owner', needs: ['account'], probe: '/api/account/site-health',
    page: { route: '/health', read: '/api/account/site-health', shows: () => ['Site health'] },
    paths: /^\/api\/account\/site-health$/,
    unit: [{ id: 'AHO-UNIT-1', file: 'apps/api/src/site-health-workspace.test.ts', name: 'account site health reports DNS, local HTTP, saved certificate and PHP findings per owned domain with fix links' }],
    checks: ['HEALTH-READ', 'DMARC-WARNING', 'ADD-DMARC-ACTION-OPENS-ZONE-EDITOR'],
    async run({ owner, check }) {
      const health = await owner.get('/api/account/site-health')
      if (!check('HEALTH-READ', health.status === 200 && Array.isArray(health.data?.domains), { status: health.status })) return
      const dmarc = health.data.domains.flatMap(domain => domain.checks).find(item => item.id === 'dns' || /dmarc/i.test(item.id))
      check('DMARC-WARNING', dmarc?.state === 'problem', { status: health.status, finding: dmarc?.id ?? null })
      check('ADD-DMARC-ACTION-OPENS-ZONE-EDITOR', dmarc?.fix === '/domains/zone-editor', { status: health.status, fix: dmarc?.fix ?? null })
    },
  }),

  tool('php-pear-packages', {
    prefix: 'PEAR', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/account/packages',
    paths: /^\/api\/(?:account\/packages|feature-lists(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'PEAR-UNIT-1', file: 'apps/api/src/account-packages-workspace.test.ts', name: 'account PEAR packages API only passes a reply bound to the signed-in account' }],
    checks: ['PACKAGES-READ', 'INSTALL-CONFIG-LITE', 'LISTED-AFTER-INSTALL', 'SYSTEM-MODULE-PROTECTED', 'FEATURE-DISABLED-ENDPOINTS'],
    async run({ owner, root, fixture, check, ok, refused, undo }) {
      const before = await owner.get('/api/account/packages')
      if (!ok('PACKAGES-READ', before)) return
      undo('PEAR package', async () => {
        const now = await owner.get('/api/account/packages')
        if (now.status !== 200) return false
        if (!now.data.inventory?.some?.(item => item.name === 'Config_Lite') && !now.data.packages?.some?.(item => item.name === 'Config_Lite')) return true
        const removed = await owner.post('/api/account/packages', { op: 'remove', name: 'Config_Lite', expectedRevision: now.data.revision })
        return removed.status === 200
      })
      const installed = await owner.post('/api/account/packages', { op: 'install', name: 'Config_Lite', expectedRevision: before.data.revision })
      ok('INSTALL-CONFIG-LITE', installed)
      const after = await owner.get('/api/account/packages')
      check('LISTED-AFTER-INSTALL', after.status === 200 && JSON.stringify(after.data?.packages ?? []).includes('Config_Lite'), { status: after.status })
      refused('SYSTEM-MODULE-PROTECTED', await owner.post('/api/account/packages', { op: 'remove', name: 'PEAR', expectedRevision: after.data?.revision ?? before.data.revision }), 'FORBIDDEN')
      const disabled = await disableFeature(root, fixture, 'php-pear-packages', undo)
      if (disabled) refused('FEATURE-DISABLED-ENDPOINTS', await owner.get('/api/account/packages'), 'FORBIDDEN')
      else check('FEATURE-DISABLED-ENDPOINTS', false, { found: false })
    },
  }),

  tool('domain-php-settings', {
    prefix: 'DPS', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains(?:\/[0-9a-f-]{36})?|feature-lists(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'DPS-UNIT-1', file: 'apps/api/src/completion-owner-web-config-security.test.ts', name: 'owner web configuration seams: PHP settings and per-domain custom configuration saves the owner PHP settings with the captured public revision and reads them back with an audit join' }],
    checks: ['WORKSPACE-READ', 'SAVE-OWN-DOMAIN', 'READBACK-PRESERVES-UNEDITED', 'NO-RUNTIME-CLAIM', 'DISABLED-FEATURE-REFUSED', 'FOREIGN-DOMAIN-REFUSED'],
    async run({ owner, root, fixture, check, refused, undo }) {
      const space = await workspaceOf(owner), domain = space.domains.find(item => item.name === fixture.domain)
      if (!check('WORKSPACE-READ', space.response.status === 200 && domain !== undefined, { status: space.response.status })) return
      const original = desiredPhp(domain.php)
      undo('domain PHP settings', restorePhp(owner, domain.id, original))
      const changed = { ...original, fpm: { ...original.fpm, maxRequests: (Number(original.fpm?.maxRequests) || 50) + 1 } }
      const saved = await owner.patch(`/api/domains/${domain.id}`, { php: changed, expectedRevision: space.revision })
      check('SAVE-OWN-DOMAIN', saved.status === 200 && saved.data?.domain?.php?.fpm?.maxRequests === changed.fpm.maxRequests, { status: saved.status })
      const nextSpace = await workspaceOf(owner), reread = nextSpace.domains.find(item => item.id === domain.id)
      const { maxRequests, ...restChanged } = reread?.php?.fpm ?? {}, { maxRequests: unused, ...restOriginal } = original.fpm ?? {}
      check('READBACK-PRESERVES-UNEDITED', reread?.php?.fpm?.maxRequests === changed.fpm.maxRequests && sameJson(restChanged, restOriginal) && sameJson(reread.php.ini, original.ini) && reread.php.version === original.version, { found: reread !== undefined })
      check('NO-RUNTIME-CLAIM', saved.status === 200 && saved.data?.application?.targetVerified !== true && saved.data?.application?.status !== 'applied', { status: saved.status, applicationStatus: saved.data?.application?.status ?? null })
      const foreign = await owner.patch('/api/domains/00000000-0000-4000-8000-000000000000', { php: original, expectedRevision: nextSpace.revision })
      check('FOREIGN-DOMAIN-REFUSED', [403, 404].includes(foreign.status), { status: foreign.status })
      const disabled = await disableFeature(root, fixture, 'domain-php-settings', undo)
      if (disabled) refused('DISABLED-FEATURE-REFUSED', await owner.patch(`/api/domains/${domain.id}`, { php: original, expectedRevision: nextSpace.revision }), 'FORBIDDEN')
      else check('DISABLED-FEATURE-REFUSED', false, { found: false })
    },
  }),

  tool('multiphp-ini-editor', {
    prefix: 'MPI', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains(?:\/[0-9a-f-]{36})?|accounts\/xq[0-9a-f]{1,13}\/files)$/,
    requests: 50,
    unit: [{ id: 'MPI-UNIT-1', file: 'apps/api/src/completion-owner-web-config-security.test.ts', name: 'owner web configuration seams: PHP settings and per-domain custom configuration saves the owner PHP settings with the captured public revision and reads them back with an audit join' }],
    checks: ['WORKSPACE-READ', 'SAVE-MEMORY-LIMIT', 'INI-PROBE-WRITTEN', 'INI-GET-ON-DOMAIN', 'OTHER-DOMAINS-KEEP-VALUE', 'DIRECTIVE-YES-REJECTED', 'DIRECTIVE-BRACE-REJECTED', 'VHOST-WITHOUT-NAME'],
    async run({ owner, fixture, tag, site, check, ok, refused, until, undo }) {
      const space = await workspaceOf(owner), domain = space.domains.find(item => item.name === fixture.domain)
      if (!check('WORKSPACE-READ', space.response.status === 200 && domain !== undefined, { status: space.response.status })) return
      const secondName = `z-ini-${fixture.domain}`
      const createdSecond = await owner.post('/api/domains', { name: secondName, kind: 'addon', siteType: 'php', expectedRevision: space.revision })
      const secondId = createdSecond.status === 201 ? createdSecond.data?.domain?.id : null
      if (typeof secondId === 'string') {
        undo('second INI domain', async () => {
          const now = await workspaceOf(owner)
          if (now.response.status !== 200) return false
          if (!now.domains.some(item => item.id === secondId)) return true
          return (await owner.delete(`/api/domains/${secondId}`, { confirmName: secondName, expectedRevision: now.revision })).status === 200
        })
      }
      const afterCreate = typeof secondId === 'string' ? await workspaceOf(owner) : space
      const secondBefore = typeof secondId === 'string' ? afterCreate.domains.find(item => item.id === secondId)?.php : undefined
      const original = desiredPhp(domain.php), file = `${domain.docRoot.startsWith(`${space.home}/`) ? domain.docRoot.slice(space.home.length + 1) : domain.docRoot}/xq-${tag}.php`
      undo('domain INI value', restorePhp(owner, domain.id, original))
      const withIni = ini => ({ ...original, ini: { ...original.ini, ...ini } })
      const saved = await owner.patch(`/api/domains/${domain.id}`, { php: withIni({ memory_limit: '256M' }), expectedRevision: afterCreate.revision })
      check('SAVE-MEMORY-LIMIT', saved.status === 200 && saved.data?.domain?.php?.ini?.memory_limit === '256M', { status: saved.status })
      const files = `/api/accounts/${fixture.username}/files`
      undo('INI probe script', async () => {
        const listed = await owner.post(files, { op: 'list', path: file.split('/').slice(0, -1).join('/'), showHidden: false })
        if (listed.status !== 200 || !JSON.stringify(listed.data).includes(`xq-${tag}.php`)) return listed.status === 200
        return (await owner.post(files, { op: 'trash', path: file })).status === 200
      })
      if (ok('INI-PROBE-WRITTEN', await owner.post(files, { op: 'write', path: file, content: "<?php echo ini_get('memory_limit');\n" }))) {
        const served = await until(() => site.get(fixture.domain, `/xq-${tag}.php`), response => response.status === 200 && response.text.trim() === '256M', { attempts: 10, delayMs: 1500 })
        check('INI-GET-ON-DOMAIN', served.settled, { status: served.last?.status ?? null, value: served.last?.text?.trim()?.slice(0, 32) ?? null })
      }
      const afterSave = await workspaceOf(owner)
      const secondAfter = typeof secondId === 'string' ? afterSave.domains.find(item => item.id === secondId)?.php : undefined
      check('OTHER-DOMAINS-KEEP-VALUE', typeof secondId === 'string' && secondBefore !== undefined && secondAfter !== undefined && secondAfter.ini?.memory_limit !== '256M' && sameJson(desiredPhp(secondAfter), desiredPhp(secondBefore)), { secondCreated: typeof secondId === 'string', memoryLimit: secondAfter?.ini?.memory_limit ?? null })
      const next = afterSave.revision
      refused('DIRECTIVE-YES-REJECTED', await owner.patch(`/api/domains/${domain.id}`, { php: withIni({ yes: '1' }), expectedRevision: next }), 'VALIDATION')
      refused('DIRECTIVE-BRACE-REJECTED', await owner.patch(`/api/domains/${domain.id}`, { php: withIni({ 'a{b': '1' }), expectedRevision: next }), 'VALIDATION')
      refused('VHOST-WITHOUT-NAME', await owner.patch(`/api/domains/${domain.id}`, { php: original, type: 'vhost', expectedRevision: next }), 'VALIDATION')
    },
  }),

  tool('user-manager', {
    prefix: 'UMG', as: 'owner', needs: ['account'], probe: '/api/service-users',
    paths: /^\/api\/(?:service-users(?:\/[0-9a-f-]{36})?|auth\/(?:login|logout))$/,
    requests: 50,
    unit: [{ id: 'UMG-UNIT-1', file: 'apps/api/src/account-mutation-security.test.ts', name: 'real HTTP account mutation security returns public service-user fields after PATCH without disclosing the persisted password hash' }],
    checks: ['CREATE-SUBACCOUNT', 'MAILBOX-ACCEPTS-LOGIN', 'PORT-21-GREETING', 'QUOTA-ABOVE-PLAN', 'LOGIN-WITH-SPACE', 'PANEL-LOGIN-REFUSED'],
    async run({ owner, fixture, tag, net, check, refused, signIn, sleep, undo }) {
      const short = tag.slice(0, 4), login = `u${short}@${fixture.domain}`, secret = `Xq-${tag}-Qm4!vT8#nB2zLp6`
      const gone = async id => {
        const removed = await owner.delete(`/api/service-users/${id}`)
        if (![200, 202, 204, 404, 412].includes(removed.status)) return false
        for (let attempt = 0; attempt < 5; attempt++) {
          const listed = await owner.get('/api/service-users')
          if (listed.status === 200 && !listed.data.serviceUsers.some(item => item.id === id)) return true
          await new Promise(done => setTimeout(done, 1000))
        }
        return false
      }
      const created = await owner.post('/api/service-users', { login, password: secret, services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 64, ftpDir: 'public_html' })
      const id = created.data?.serviceUser?.id
      if (!check('CREATE-SUBACCOUNT', created.status === 201 && typeof id === 'string' && created.data.serviceUser.services?.email === true && created.data.serviceUser.services?.ftp === true, { status: created.status })) return
      undo('subaccount', () => gone(id))
      let mailbox = { client: null, response: { status: 0 } }
      for (let attempt = 0; attempt < 3 && mailbox.client === null; attempt++) {
        if (attempt > 0) await sleep(1500)
        mailbox = await signIn('mailbox', { username: login, password: secret })
      }
      check('MAILBOX-ACCEPTS-LOGIN', mailbox.client !== null, { status: mailbox.response.status })
      const ftp = await net.tcpBanner(21)
      check('PORT-21-GREETING', created.status === 201 && ftp.ok && /^220[\s-]/.test(ftp.banner), { ok: ftp.ok })
      const big = await owner.post('/api/service-users', { login: `b${short}@${fixture.domain}`, password: secret, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100_000_000 })
      if (big.data?.serviceUser?.id) undo('oversized mailbox', () => gone(big.data.serviceUser.id))
      refused('QUOTA-ABOVE-PLAN', big, 'LIMIT_EXCEEDED')
      const spaced = await owner.post('/api/service-users', { login: `bad name${tag}@${fixture.domain}`, password: secret, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 64 })
      if (spaced.data?.serviceUser?.id) undo('spaced login', () => gone(spaced.data.serviceUser.id))
      refused('LOGIN-WITH-SPACE', spaced, 'VALIDATION')
      const panel = await signIn('owner', { username: login, password: secret })
      check('PANEL-LOGIN-REFUSED', panel.client === null, { status: panel.response.status })
    },
  }),

  tool('bandwidth', {
    prefix: 'BW', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains|account\/logs\/[0-9a-f-]{36}\/access|analytics\/websites\/[0-9a-f-]{36}\?window=1h|accounts\/xq[0-9a-f]{1,13}\/files)$/,
    requests: 60, deadlineMs: 240000,
    unit: [{ id: 'BW-UNIT-1', file: 'apps/agent/src/analytics.test.ts', name: 'website analytics from site access logs aggregates each line for the domain that serves its host name over complete hours' }],
    checks: ['DOMAIN-READ', 'DOWNLOAD-FILE-WRITTEN', 'HTTP-BYTES-INCREASE-10-TO-11-MB', 'FOREIGN-DOMAIN-ANALYTICS-REFUSED'],
    async run({ owner, fixture, tag, site, check, ok, until, undo }) {
      const space = await workspaceOf(owner), domain = space.domains.find(item => item.name === fixture.domain)
      if (!check('DOMAIN-READ', space.response.status === 200 && domain !== undefined, { status: space.response.status })) return
      const files = `/api/accounts/${fixture.username}/files`, dir = docRootRel(space, domain), file = `${dir}/xq-${tag}.bin`
      undo('download file', async () => {
        const listed = await owner.post(files, { op: 'list', path: dir, showHidden: false })
        if (listed.status !== 200 || !JSON.stringify(listed.data).includes(`xq-${tag}.bin`)) return listed.status === 200
        return (await owner.post(files, { op: 'trash', path: file })).status === 200
      })
      const size = 2 * 1024 * 1024, logPath = `/api/account/logs/${domain.id}/access`, window = `/api/analytics/websites/${domain.id}?window=1h`
      if (!ok('DOWNLOAD-FILE-WRITTEN', await owner.post(files, { op: 'put-bytes', path: file, contentBase64: Buffer.alloc(size, 0x61).toString('base64'), overwrite: true, mode: 0o640 }))) return
      const uri = `/xq-${tag}.bin`
      for (let round = 0; round < 5; round++) await site.get(fixture.domain, uri)
      const seen = await until(() => owner.get(logPath), response => (response.data?.entries ?? []).filter(entry => entry.uri === uri).length >= 5, { attempts: 10, delayMs: 2000 })
      const matched = (seen.last?.data?.entries ?? []).filter(entry => entry.uri === uri)
      const grown = matched.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0)
      const windowRes = await owner.get(window)
      const windowTruthful = windowRes.status === 200 || (windowRes.status === 503 && ['not-read', 'window-not-covered'].includes(windowRes.data?.details?.reason))
      check('HTTP-BYTES-INCREASE-10-TO-11-MB', seen.settled && matched.length === 5 && grown >= 10 * 1024 * 1024 && grown <= 11_000_000 && windowTruthful, { status: seen.last?.status ?? null, windowStatus: windowRes.status, increaseBytes: grown })
      const foreign = await owner.get('/api/analytics/websites/00000000-0000-4000-8000-000000000000?window=1h')
      check('FOREIGN-DOMAIN-ANALYTICS-REFUSED', [403, 404].includes(foreign.status), { status: foreign.status })
    },
  }),

  tool('visitors', {
    prefix: 'VIS', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains|account\/logs\/[0-9a-f-]{36}\/access)$/,
    unit: [{ id: 'VIS-UNIT-1', file: 'apps/api/src/account-logs-workspace.test.ts', name: 'account site logs workspace returns parsed access entries for an owned domain with the unparsed count' }],
    checks: ['DOMAIN-READ', 'THREE-ENTRIES-WITH-AGENT', 'STATUS-COLUMN', 'FOREIGN-DOMAIN-ENTRIES-ABSENT'],
    async run({ owner, fixture, tag, site, check, refused, until }) {
      const domain = await firstDomain(owner)
      if (!check('DOMAIN-READ', domain.listed.status === 200 && typeof domain.id === 'string', { status: domain.listed.status })) return
      const agent = `xq-visitor-${tag}`, path = `/api/account/logs/${domain.id}/access`
      for (let round = 0; round < 3; round++) await site.get(fixture.domain, `/xq-${tag}-${round}`, { headers: { 'user-agent': agent } })
      const seen = await until(() => owner.get(path), response => response.data?.entries?.filter(entry => entry.agent === agent).length >= 3, { attempts: 8, delayMs: 2000 })
      const mine = (seen.last?.data?.entries ?? []).filter(entry => entry.agent === agent)
      check('THREE-ENTRIES-WITH-AGENT', seen.settled && mine.length === 3, { status: seen.last?.status ?? null, entries: mine.length })
      check('STATUS-COLUMN', mine.length === 3 && mine.every(entry => Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599), { entries: mine.length })
      refused('FOREIGN-DOMAIN-ENTRIES-ABSENT', await owner.get('/api/account/logs/00000000-0000-4000-8000-000000000000/access'), 404)
    },
  }),

  tool('web-stats-analog', {
    prefix: 'WSA', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains|account\/logs\/[0-9a-f-]{36}\/access|analytics\/websites\/[0-9a-f-]{36}\?window=(?:1h|30d))$/,
    requests: 40, deadlineMs: 240000,
    unit: [{ id: 'WSA-UNIT-1', file: 'apps/agent/src/analytics.test.ts', name: 'website analytics from site access logs aggregates each line for the domain that serves its host name over complete hours' }],
    checks: ['DOMAIN-READ', 'THIRTY-DAY-SERIES-AND-PATHS', 'TOTAL-EQUALS-PROCESSED-LINES'],
    async run({ owner, fixture, tag, site, check, until }) {
      const domain = await firstDomain(owner)
      if (!check('DOMAIN-READ', domain.listed.status === 200 && typeof domain.id === 'string', { status: domain.listed.status })) return
      const logPath = `/api/account/logs/${domain.id}/access`, prefix = `/xq-${tag}-`, lines = 4
      for (let round = 0; round < lines; round++) await site.get(fixture.domain, `${prefix}${round}`)
      const seen = await until(() => owner.get(logPath), response => (response.data?.entries ?? []).filter(entry => String(entry.uri).startsWith(prefix)).length >= lines, { attempts: 10, delayMs: 2000 })
      const matched = (seen.last?.data?.entries ?? []).filter(entry => String(entry.uri).startsWith(prefix))
      check('TOTAL-EQUALS-PROCESSED-LINES', seen.settled && matched.length === lines, { status: seen.last?.status ?? null, processed: lines, counted: matched.length })
      const monthly = await owner.get(`/api/analytics/websites/${domain.id}?window=30d`)
      const monthlyTruthful = monthly.status === 200
        ? Array.isArray(monthly.data?.series) && Array.isArray(monthly.data?.topPaths)
        : monthly.status === 503 && ['not-read', 'window-not-covered'].includes(monthly.data?.details?.reason)
      const distinctPaths = new Set(matched.map(entry => entry.uri))
      check('THIRTY-DAY-SERIES-AND-PATHS', distinctPaths.size === lines && monthlyTruthful, { status: monthly.status, paths: distinctPaths.size })
    },
  }),

  tool('hotlink-protection', {
    prefix: 'HLP', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains(?:\/[0-9a-f-]{36}\/web-directives\/hotlink)?|accounts\/xq[0-9a-f]{1,13}\/files)$/,
    requests: 40,
    unit: [{ id: 'HLP-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace reads a feature model and saves only its managed block with the captured revision' }],
    checks: ['DOMAIN-READ', 'IMAGE-WRITTEN', 'SAVE-PROTECTION', 'SAVE-DIRECT-DENIED', 'EVIL-REFERER-REDIRECTED', 'OWN-REFERER-200', 'NO-REFERER-200-WHEN-DIRECT-ALLOWED', 'NO-REFERER-NOT-200-WHEN-DIRECT-DENIED'],
    async run({ owner, fixture, tag, site, check, ok, until, undo }) {
      const space = await workspaceOf(owner), domain = space.domains.find(item => item.name === fixture.domain)
      if (!check('DOMAIN-READ', space.response.status === 200 && domain !== undefined, { status: space.response.status })) return
      const route = `/api/domains/${domain.id}/web-directives/hotlink`, files = `/api/accounts/${fixture.username}/files`, dir = docRootRel(space, domain), image = `xq-${tag}.jpg`
      const original = await owner.get(route)
      if (original.status !== 200) return check('SAVE-PROTECTION', false, { status: original.status })
      undo('hotlink protection', async () => {
        const now = await owner.get(route)
        if (now.status !== 200) return false
        if (sameJson(now.data.model, original.data.model)) return true
        const back = await owner.put(route, { expectedRevision: now.data.document.revision, model: original.data.model })
        return back.status === 200 && sameJson(back.data.model, original.data.model)
      })
      undo('protected image', async () => {
        const listed = await owner.post(files, { op: 'list', path: dir, showHidden: false })
        if (listed.status !== 200 || !JSON.stringify(listed.data).includes(image)) return listed.status === 200
        return (await owner.post(files, { op: 'trash', path: `${dir}/${image}` })).status === 200
      })
      ok('IMAGE-WRITTEN', await owner.post(files, { op: 'write', path: `${dir}/${image}`, content: 'xq image\n' }))
      const redirectUrl = `https://${fixture.domain}/xq-${tag}-denied`
      const save = async allowEmptyReferrer => {
        const now = await owner.get(route)
        return owner.put(route, { expectedRevision: now.data?.document?.revision, model: { enabled: true, allowedHosts: [fixture.domain], extensions: ['jpg'], allowEmptyReferrer, redirectUrl } })
      }
      const get = (referer, wanted) => until(() => site.get(fixture.domain, `/${image}`, { headers: referer === null ? {} : { referer } }), response => wanted(response), { attempts: 6, delayMs: 1500 })
      if (!ok('SAVE-PROTECTION', await save(true))) return
      const evil = await get('https://evil.test/', response => response.status >= 300 && response.status < 400)
      check('EVIL-REFERER-REDIRECTED', evil.settled && evil.last.headers.location === redirectUrl, { status: evil.last?.status ?? null })
      const own = await get(`https://${fixture.domain}/`, response => response.status === 200)
      check('OWN-REFERER-200', own.settled, { status: own.last?.status ?? null })
      const direct = await get(null, response => response.status === 200)
      check('NO-REFERER-200-WHEN-DIRECT-ALLOWED', direct.settled, { status: direct.last?.status ?? null })
      if (ok('SAVE-DIRECT-DENIED', await save(false))) {
        const denied = await get(null, response => response.status !== 200)
        check('NO-REFERER-NOT-200-WHEN-DIRECT-DENIED', denied.settled, { status: denied.last?.status ?? null })
      }
    },
  }),

  tool('ip-blocker', {
    prefix: 'IPB', as: 'owner', needs: ['account'], probe: '/api/account/ip-blocker',
    page: { route: '/security/ip-blocker', read: '/api/domains', shows: () => ['IP blocker'] },
    paths: /^\/api\/(?:domains|account\/ip-blocker)$/,
    requests: 50, deadlineMs: 300000,
    unit: [{ id: 'IPB-UNIT-1', file: 'apps/api/src/account-edge-workspace.test.ts', name: 'account IP Blocker and cache control adds a cPanel range as exact CIDR blocks, removes one, audits and asks for a reconcile' }],
    checks: ['DOMAIN-READ', 'RANGE-SAVED', 'CIDR-BLOCKS-COVER-RANGE-EXACTLY', 'UNBLOCKED-VISITOR-NOT-403', 'STALE-REVISION-CONFLICT', 'INVALID-INPUT'],
    async run({ owner, fixture, tag, site, check, ok, refused, undo }) {
      const domain = await firstDomain(owner)
      if (!check('DOMAIN-READ', domain.listed.status === 200 && typeof domain.id === 'string', { status: domain.listed.status })) return
      const route = '/api/account/ip-blocker', original = await owner.get(route)
      if (original.status !== 200) return check('RANGE-SAVED', false, { status: original.status })
      const initialEntries = new Set((original.data?.entries ?? []).map(item => item.entry))
      undo('IP blocker entries', async () => {
        for (let step = 0; step < 32; step++) {
          const now = await owner.get(route)
          if (now.status !== 200) return false
          const extra = (now.data?.entries ?? []).find(item => !initialEntries.has(item.entry))
          if (!extra) return true
          const removed = await owner.post(route, { expectedRevision: now.data.revision, remove: extra.entry })
          if (removed.status !== 200) return false
        }
        return false
      })
      const saved = await owner.post(route, { expectedRevision: original.data.revision, add: '10.5.3.3-10.5.3.40' })
      const covered = new Set()
      for (const item of saved.data?.entries ?? []) {
        const entry = typeof item === 'string' ? item : item.entry
        const [base, bits = '32'] = entry.split('/'), size = 2 ** (32 - Number(bits)), start = Math.floor(base.split('.').reduce((total, part) => total * 256 + Number(part), 0) / size) * size
        for (let offset = 0; offset < size && covered.size < 70_000; offset++) covered.add(start + offset)
      }
      const first = [10, 5, 3, 3].reduce((total, part) => total * 256 + part, 0)
      ok('RANGE-SAVED', saved)
      check('CIDR-BLOCKS-COVER-RANGE-EXACTLY', saved.status === 200 && covered.size >= 38 && Array.from({ length: 38 }, (_, index) => first + index).every(address => covered.has(address)), { status: saved.status, addresses: covered.size })
      const unblocked = saved.status === 200 ? await site.get(fixture.domain, `/xq-${tag}-unblocked`).catch(() => ({ status: 0 })) : { status: 0 }
      check('UNBLOCKED-VISITOR-NOT-403', saved.status === 200 && [200, 404].includes(unblocked.status), { status: unblocked.status })
      refused('STALE-REVISION-CONFLICT', await owner.post(route, { expectedRevision: '0'.repeat(64), add: '198.51.100.7' }), 'CONFLICT')
      const latest = await owner.get(route)
      refused('INVALID-INPUT', await owner.post(route, { expectedRevision: latest.data?.revision ?? '0'.repeat(64), add: 'abc' }), 'VALIDATION')
    },
  }),

  tool('two-factor-auth', {
    prefix: 'TFA', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/auth\/(?:2fa\/(?:setup|enable|disable)|login|logout|me)$/,
    requests: 40, deadlineMs: 300000,
    unit: [{ id: 'TFA-UNIT-1', file: 'apps/api/src/mfa-runtime-policy.test.ts', name: 'trusted development MFA runtime policy skips an enrolled factor only in development and preserves its persistent state' }],
    checks: ['SETUP-STARTED', 'WRONG-CODE-REFUSED', 'WRONG-CODE-LEAVES-2FA-OFF', 'ENABLE-WITH-CODE', 'PASSWORD-ONLY-LOGIN-REFUSED', 'RECONFIGURE-OLD-CODE-FAILS', 'RECONFIGURE-TERMINATES-OTHER-SESSIONS'],
    async run({ owner, fixture, check, ok, refused, sleep, undo }) {
      let secret = null
      const credentials = { username: fixture.username, password: fixture.password }
      undo('two-factor enrolment', async () => {
        if (secret === null) return true
        for (let attempt = 0; attempt < 3; attempt++) {
          const me = await owner.get('/api/auth/me')
          if (me.status === 200 && me.data?.totpEnabled === false) return true
          const off = await owner.post('/api/auth/2fa/disable', { password: fixture.password, code: totp(secret, 1) })
          if (off.status === 200) return true
          await sleep(31_000)
        }
        return false
      })
      const setup = await owner.post('/api/auth/2fa/setup', { password: fixture.password })
      if (!check('SETUP-STARTED', setup.status === 200 && typeof setup.data?.secret === 'string', { status: setup.status })) return
      secret = setup.data.secret
      refused('WRONG-CODE-REFUSED', await owner.post('/api/auth/2fa/enable', { code: '000000' }), 'VALIDATION')
      const off = await owner.get('/api/auth/me')
      check('WRONG-CODE-LEAVES-2FA-OFF', off.status === 200 && off.data?.totpEnabled === false, { status: off.status })
      if (!ok('ENABLE-WITH-CODE', await owner.post('/api/auth/2fa/enable', { code: totp(secret) }))) return
      const passwordOnly = await owner.anonymous('/api/auth/login', { method: 'POST', body: credentials })
      check('PASSWORD-ONLY-LOGIN-REFUSED', passwordOnly.status >= 400 && !passwordOnly.setCookie?.length, { status: passwordOnly.status })
      const other = await owner.anonymous('/api/auth/login', { method: 'POST', body: { ...credentials, totpCode: totp(secret, 1) } })
      const otherCookie = other.setCookie?.find(value => value.startsWith('__Host-xpanel_session='))?.split(';')[0]
      if (otherCookie) undo('second session', async () => (await owner.anonymous('/api/auth/logout', { method: 'POST', body: {}, cookie: otherCookie, csrf: other.data?.csrfToken })).status !== 500)
      const oldSecret = secret
      await sleep(31_000)
      const disabled = await owner.post('/api/auth/2fa/disable', { password: fixture.password, code: totp(oldSecret, 1) })
      if (disabled.status !== 200) return check('RECONFIGURE-OLD-CODE-FAILS', false, { status: disabled.status })
      secret = null
      const again = await owner.post('/api/auth/2fa/setup', { password: fixture.password })
      if (typeof again.data?.secret !== 'string') return check('RECONFIGURE-OLD-CODE-FAILS', false, { status: again.status })
      secret = again.data.secret
      await sleep(31_000)
      await owner.post('/api/auth/2fa/enable', { code: totp(secret, 1) })
      const stale = await owner.anonymous('/api/auth/login', { method: 'POST', body: { ...credentials, totpCode: totp(oldSecret, 1) } })
      check('RECONFIGURE-OLD-CODE-FAILS', stale.status >= 400 && !stale.setCookie?.length, { status: stale.status })
      const ended = otherCookie ? await owner.anonymous('/api/auth/me', { cookie: otherCookie }) : null
      check('RECONFIGURE-TERMINATES-OTHER-SESSIONS', ended !== null && ended.status === 401, { status: ended?.status ?? null })
    },
  }),

  tool('domain-htaccess', {
    prefix: 'HTA', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains(?:\/[0-9a-f-]{36}\/htaccess(?:\/restore)?)?|auth\/(?:api-tokens(?:\/[0-9a-f-]{36}\/revoke)?|team\/password|login|logout)|account\/team(?:\/[0-9a-f-]{36}(?:\/password-link)?)?|accounts\/xq[0-9a-f]{1,13}[a-z]?\/files|feature-lists(?:\/[0-9a-f-]{36})?)$/,
    requests: 75,
    unit: [{ id: 'HTA-UNIT-1', file: 'apps/api/src/htaccess-workspace.test.ts', name: '.htaccess public transport refuses foreign-account replies independently of the browser' }],
    checks: ['DOMAIN-READ', 'READ-ACTUAL-FILE', 'VALIDATE-LEAVES-FILE', 'INVALID-VALIDATION-KEEPS-FILE', 'SAVE-WITH-CURRENT-REVISION', 'STALE-REVISION-REFUSED', 'RESTORE-KEPT-CONTENT', 'FOREIGN-TARGET-REFUSED', 'DISABLED-FEATURE-REFUSED', 'READ-ONLY-TOKEN-REFUSED', 'DISALLOWED-TEAM-ROLE-REFUSED', 'SERVING-REWRITE-AND-CONFINEMENT'],
    async run({ owner, root, fixture, tag, site, check, refused, until, undo }) {
      const domain = await firstDomain(owner)
      if (!check('DOMAIN-READ', domain.listed.status === 200 && typeof domain.id === 'string', { status: domain.listed.status })) return
      const route = `/api/domains/${domain.id}/htaccess`, first = await owner.get(route)
      if (!check('READ-ACTUAL-FILE', first.status === 200 && typeof first.data?.document?.revision === 'string' && typeof first.data.document.content === 'string', { status: first.status })) return
      const original = first.data.document.content
      undo('.htaccess content', async () => {
        const now = await owner.get(route)
        if (now.status !== 200) return false
        if (now.data.document.content === original) return true
        const back = await owner.put(route, { content: original, expectedRevision: now.data.document.revision })
        return back.status === 200 && back.data?.document?.content === original
      })
      const candidate = `${original}${original === '' || original.endsWith('\n') ? '' : '\n'}# xq-${tag}\n`
      const validated = await owner.post(route, { content: candidate, expectedRevision: first.data.document.revision })
      const afterValidate = await owner.get(route)
      check('VALIDATE-LEAVES-FILE', validated.status === 200 && afterValidate.data?.document?.content === original, { status: validated.status })
      const invalid = await owner.post(route, { content: `${original}\nRewriteRule (\n`, expectedRevision: first.data.document.revision })
      const afterInvalid = await owner.get(route)
      check('INVALID-VALIDATION-KEEPS-FILE', afterInvalid.data?.document?.content === original && (invalid.status >= 400 || invalid.data?.validation?.valid === false), { status: invalid.status })
      const saved = await owner.put(route, { content: candidate, expectedRevision: first.data.document.revision })
      check('SAVE-WITH-CURRENT-REVISION', saved.status === 200 && saved.data?.document?.content === candidate, { status: saved.status })
      refused('STALE-REVISION-REFUSED', await owner.put(route, { content: `${candidate}# again\n`, expectedRevision: first.data.document.revision }), 409)
      const kept = (saved.data?.versions ?? []).find(version => version.revision === first.data.document.revision && version.canRestore)
      if (kept) {
        const restored = await owner.post(`${route}/restore`, { versionId: kept.id, expectedRevision: saved.data.document.revision })
        check('RESTORE-KEPT-CONTENT', restored.status === 200 && restored.data?.document?.content === original, { status: restored.status })
      } else check('RESTORE-KEPT-CONTENT', false, { status: saved.status, kept: false })
      refused('FOREIGN-TARGET-REFUSED', await owner.get('/api/domains/00000000-0000-4000-8000-000000000000/htaccess'), 404)
      const token = await owner.post('/api/auth/api-tokens', { name: `xq-${tag}-hta`, scopes: ['files:read'], expiresInDays: 1 })
      if (token.status === 201) {
        const tokenId = token.data.token.id
        undo('read-only token', async () => [200, 404, 409].includes((await owner.post(`/api/auth/api-tokens/${tokenId}/revoke`, undefined, { noBody: true })).status))
        const now = await owner.get(route)
        refused('READ-ONLY-TOKEN-REFUSED', await owner.anonymous(route, { method: 'PUT', bearer: token.data.secret, body: { content: candidate, expectedRevision: now.data?.document?.revision } }), 403)
      } else check('READ-ONLY-TOKEN-REFUSED', false, { status: token.status })
      const teamName = `hta${tag}`, teamRead = await owner.get('/api/account/team')
      const teamCreated = teamRead.status === 200 ? await owner.post('/api/account/team', { username: teamName, roles: ['email'], contactEmail: `xq@${fixture.domain}`, notes: '', expiresAt: null, expiryReason: null, expectedRevision: teamRead.data?.revision }) : { status: 0 }
      const memberId = teamCreated.data?.changed ?? teamCreated.data?.member?.id
      if (teamCreated.status === 201 && typeof memberId === 'string') {
        undo('htaccess team member', async () => {
          const now = await owner.get('/api/account/team')
          if (now.status !== 200) return false
          if (!now.data.members.some(item => item.id === memberId)) return true
          return (await owner.delete(`/api/account/team/${memberId}`, { expectedRevision: now.data.revision, confirmUsername: teamName })).status === 200
        })
        const link = await owner.post(`/api/account/team/${memberId}/password-link`, { expectedRevision: teamCreated.data.revision })
        const linkToken = link.data?.passwordLink?.path?.split('#team-password=')[1], teamSecret = `Xq-${tag}-Ht9!mR4#vB2zLp8`
        const pwd = typeof linkToken === 'string' ? await owner.anonymous('/api/auth/team/password', { method: 'POST', body: { token: linkToken, password: teamSecret } }) : { status: 0 }
        const memberSession = pwd.status === 200 ? await ownerLogin(owner, `${teamName}@${fixture.domain}`, teamSecret) : { status: 0 }
        if (memberSession.cookie) {
          undo('htaccess team session', async () => [200, 204, 401].includes((await ownerLogout(owner, memberSession)).status))
          refused('DISALLOWED-TEAM-ROLE-REFUSED', await owner.anonymous(route, { cookie: memberSession.cookie }), 'FORBIDDEN')
        } else check('DISALLOWED-TEAM-ROLE-REFUSED', false, { loginStatus: memberSession.status })
      } else check('DISALLOWED-TEAM-ROLE-REFUSED', false, { createStatus: teamCreated.status })
      const current = await owner.get(route), redirectTo = `https://${fixture.domain}/xq-${tag}-to`
      const rewriteContent = `${original}${original === '' || original.endsWith('\n') ? '' : '\n'}RewriteEngine On\nRewriteRule ^xq-${tag}-from$ ${redirectTo} [R=302,L]\n`
      const rewriteSaved = current.status === 200 ? await owner.put(route, { content: rewriteContent, expectedRevision: current.data.document.revision }) : { status: 0 }
      const redirected = rewriteSaved.status === 200 ? await until(() => site.get(fixture.domain, `/xq-${tag}-from`), response => response.status === 302 && response.headers?.location === redirectTo, { attempts: 6, delayMs: 1500 }) : { settled: false, last: null }
      const foreignFiles = await owner.post('/api/accounts/xq00000000z/files', { op: 'list', path: '', showHidden: true })
      check('SERVING-REWRITE-AND-CONFINEMENT', rewriteSaved.status === 200 && redirected.settled && [403, 404].includes(foreignFiles.status), { saveStatus: rewriteSaved.status, redirectStatus: redirected.last?.status ?? null, foreignStatus: foreignFiles.status })
      const list = await disableFeature(root, fixture, 'domain-htaccess', undo)
      if (list) refused('DISABLED-FEATURE-REFUSED', await owner.get(route), ['FORBIDDEN', 403])
      else check('DISABLED-FEATURE-REFUSED', false, { found: false })
    },
  }),

  tool('xpanel-tools-home', {
    prefix: 'XTH', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/catalog',
    paths: /^\/api\/(?:catalog|account\/packages|feature-lists(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'XTH-UNIT-1', file: 'apps/api/src/catalog-host.test.ts', name: 'GET /api/catalog returns the same host-qualified catalog the sidebar uses' }],
    checks: ['CATALOG-READ', 'TOOLS-GROUPED-BY-CATEGORY', 'DISABLED-TOOL-MISSING-FROM-HOME', 'DISABLED-ROUTE-REFUSED', 'REENABLED-TOOL-RESTORED'],
    async run({ owner, root, fixture, check, refused, undo }) {
      const before = await owner.get('/api/catalog')
      if (!check('CATALOG-READ', before.status === 200 && before.data?.tools?.some(tool => tool.id === 'php-pear-packages') === true, { status: before.status })) return
      const groups = Array.isArray(before.data?.groups) ? before.data.groups : []
      const xpanelTools = (before.data.tools ?? []).filter(tool => tool.surface === 'xpanel')
      check('TOOLS-GROUPED-BY-CATEGORY', xpanelTools.length > 0 && groups.some(group => group.surface === 'xpanel') && xpanelTools.every(tool => groups.some(group => group.id === tool.groupId)), { tools: xpanelTools.length, groups: groups.length })
      const changed = await disableFeature(root, fixture, 'php-pear-packages', undo)
      const after = changed ? await owner.get('/api/catalog') : null
      check('DISABLED-TOOL-MISSING-FROM-HOME', after?.status === 200 && !after.data.tools.some(tool => tool.id === 'php-pear-packages'), { status: after?.status ?? null })
      refused('DISABLED-ROUTE-REFUSED', await owner.get('/api/account/packages'), 'FORBIDDEN')
      const reenabled = changed ? await root.patch(`/api/feature-lists/${changed.id}`, { disabled: changed.disabled }) : null
      const restored = reenabled?.status === 200 ? await owner.get('/api/catalog') : null
      check('REENABLED-TOOL-RESTORED', reenabled?.status === 200 && restored?.status === 200 && restored.data?.tools?.some(tool => tool.id === 'php-pear-packages') === true, { restoreStatus: reenabled?.status ?? null, readStatus: restored?.status ?? null })
    },
  }),

  tool('xpanel-global-search', {
    prefix: 'XGS', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/catalog',
    paths: /^\/api\/(?:catalog|feature-lists(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'XGS-UNIT-1', file: 'apps/api/src/catalog-host.test.ts', name: 'GET /api/catalog returns the same host-qualified catalog the sidebar uses' }],
    checks: ['CATALOG-TOOLS-HAVE-ROUTES', 'FORWARD-FINDS-FORWARDERS', 'DISABLED-TOOL-ABSENT'],
    async run({ owner, root, fixture, check, undo }) {
      const matches = tools => (tools ?? []).filter(tool => /forward/i.test(`${tool.id} ${tool.name ?? ''} ${(tool.keywords ?? []).join(' ')}`)).map(tool => tool.id)
      const before = await owner.get('/api/catalog')
      const pages = (before.data?.navigation ?? []).flatMap(surface => (surface.sections ?? []).flatMap(section => section.pages ?? []))
      check('CATALOG-TOOLS-HAVE-ROUTES', before.status === 200 && Array.isArray(before.data?.tools) && before.data.tools.length > 0 && pages.length > 0 && pages.every(page => typeof page.route === 'string' && page.route.startsWith('/') && Array.isArray(page.tools) && page.tools.length > 0), { status: before.status, count: before.data?.tools?.length ?? null, pages: pages.length })
      check('FORWARD-FINDS-FORWARDERS', before.status === 200 && matches(before.data?.tools).includes('forwarders'), { status: before.status })
      const changed = await disableFeature(root, fixture, 'forwarders', undo)
      const after = changed ? await owner.get('/api/catalog') : null
      check('DISABLED-TOOL-ABSENT', after?.status === 200 && !after.data.tools.some(tool => tool.id === 'forwarders') && !matches(after.data.tools).includes('forwarders'), { status: after?.status ?? null })
    },
  }),

  tool('account-cache-services', {
    prefix: 'ACS', as: 'owner', needs: ['account'], probe: '/api/account/runtime',
    paths: /^\/api\/(?:account\/runtime(?:\/log\?target=cache:redis)?|cache\/xq[0-9a-f]{1,13}[a-z]?)$/,
    unit: [{ id: 'ACS-UNIT-1', file: 'apps/api/src/account-runtime-workspace.test.ts', name: 'account runtime workspace reads the verified view and saves a memcached instance through the agent' }],
    checks: ['RUNTIME-READ', 'REDIS-ENABLED', 'SOCKET-INSIDE-HOME', 'IN-ACCOUNT-SLICE', 'CACHE-FLUSH-SUCCEEDS', 'CACHE-LOG-UNIT-VERIFIED', 'FOREIGN-ACCOUNT-CACHE-FORBIDDEN'],
    async run({ owner, fixture, check, ok, undo }) {
      const view = await owner.get('/api/account/runtime'), cachePath = `/api/cache/${fixture.username}`
      if (!ok('RUNTIME-READ', view)) return
      const was = (await owner.get(cachePath)).data?.cache?.redis, memoryMb = was?.maxMemoryMb ?? 16
      undo('Redis cache', async () => {
        const now = await owner.get('/api/account/runtime'), state = await owner.get(cachePath)
        if (now.status !== 200 || state.status !== 200) return false
        if (state.data.cache.redis.enabled === (was?.enabled ?? false)) return true
        const back = await owner.post('/api/account/runtime', { op: 'cache.save', expectedRevision: now.data.revision, service: 'redis', enabled: was?.enabled ?? false, memoryMb })
        return back.status === 200 && (await owner.get(cachePath)).data?.cache?.redis?.enabled === (was?.enabled ?? false)
      })
      const enabled = await owner.post('/api/account/runtime', { op: 'cache.save', expectedRevision: view.data.revision, service: 'redis', enabled: true, memoryMb: 16 })
      if (!ok('REDIS-ENABLED', enabled)) return
      const state = await owner.get(cachePath), redis = state.data?.cache?.redis
      check('SOCKET-INSIDE-HOME', state.status === 200 && redis?.enabled === true && typeof redis.socketPath === 'string' && redis.socketPath.startsWith(`${view.data.context?.home}/`), { status: state.status })
      check('IN-ACCOUNT-SLICE', state.status === 200 && /^xpanel-\d+\.slice$/.test(state.data?.cache?.slice ?? ''), { status: state.status })
      const flushed = await owner.post('/api/account/runtime', { op: 'cache.flush', expectedRevision: enabled.data.revision, service: 'redis' })
      check('CACHE-FLUSH-SUCCEEDS', flushed.status === 200 && flushed.data?.op === 'cache.flush', { status: flushed.status })
      const log = await owner.get('/api/account/runtime/log?target=cache:redis')
      check('CACHE-LOG-UNIT-VERIFIED', log.status === 200 && log.data?.target === 'cache:redis' && /^xpanel-[a-z0-9-]{1,80}\.service$/.test(log.data?.unit ?? ''), { status: log.status })
      const foreign = await owner.get('/api/cache/xq00000000z')
      check('FOREIGN-ACCOUNT-CACHE-FORBIDDEN', [403, 404].includes(foreign.status), { status: foreign.status })
    },
  }),
]
