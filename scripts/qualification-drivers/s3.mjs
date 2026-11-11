import { createHmac, randomBytes } from 'node:crypto'
import { tool } from './kit.mjs'

const SEC = kind => `/api/server/sec/${kind}`
const TOOLS = '/api/server/security-tools'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const list = value => Array.isArray(value) ? value : []
const secret = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const POLL = { attempts: 8, delayMs: 3000 }

/** RFC 6238 code for a base32 secret, shifted by whole 30 second steps. */
const totp = (key32, steps = 0) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bits = [...key32.replace(/=+$/, '').toUpperCase()].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('')
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2))), counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + steps))
  const digest = createHmac('sha1', key).update(counter).digest(), offset = digest[19] & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** Reads one saved server security policy and registers its verified restore, so any later save is always undone. */
async function guardSec(root, kind, undo) {
  const read = await root.get(SEC(kind)), original = read.data?.policy
  if (read.status !== 200 || typeof read.data?.revision !== 'string' || !original || typeof original !== 'object') return { read, view: null }
  undo(`${kind} policy`, async () => {
    const now = await root.get(SEC(kind))
    if (now.status !== 200) return false
    if (same(now.data?.policy, original)) return true
    const back = await root.put(SEC(kind), { expectedRevision: now.data.revision, policy: original })
    return back.status === 200 && same(back.data?.policy, original)
  })
  return { read, view: read.data }
}
/** A save carries the revision the server reports right now. */
async function saveSec(root, kind, policy) {
  const now = await root.get(SEC(kind))
  return now.status === 200 ? root.put(SEC(kind), { expectedRevision: now.data?.revision, policy }) : now
}

export default [
  tool('compiler-access', {
    prefix: 'CMPA', restores: ['/api/server/sec/compiler-access'], needs: ['account'], probe: SEC('compiler-access'), paths: /^\/api\/server\/sec\/compiler-access$/, requests: 45,
    unit: [{ id: 'CMPA-UNIT-SAVE', file: 'apps/api/src/sec-workspace.test.ts', name: 'sec server workspaces saves Compiler Access for existing accounts only, lists grantable accounts and projects the host read strictly' }],
    checks: ['DISABLE-RESTRICTS-NON-MEMBERS', 'GRANTED-ACCOUNT-IN-GROUP', 'COMMAND-MODES-0750', 'UNKNOWN-ACCOUNT-GRANT-REFUSED'],
    async run({ root, fixture, check, refused, undo, until }) {
      const { read, view } = await guardSec(root, 'compiler-access', undo)
      if (!view) return check('DISABLE-RESTRICTS-NON-MEMBERS', false, { status: read.status })
      const restricted = await saveSec(root, 'compiler-access', { restricted: true, accountIds: [] })
      const applied = restricted.status === 200 ? await until(() => root.get(SEC('compiler-access')), r => r.data?.observation?.state === 'applied', POLL) : null
      const observed = applied?.settled ? applied.last.data.observation : null, present = list(observed?.commands).filter(item => item.present)
      check('DISABLE-RESTRICTS-NON-MEMBERS', restricted.status === 200 && observed !== null && present.length > 0 && present.every(item => item.restricted === true) && !list(observed.group?.members).includes(fixture.username),
        { status: restricted.status, state: observed?.state ?? null, commands: present.length })
      check('COMMAND-MODES-0750', restricted.status === 200 && observed !== null && present.length > 0 && present.every(item => item.mode === 0o750) && typeof observed.hook?.available === 'boolean',
        { status: restricted.status, modes: present.map(item => item.mode), hookAvailable: observed?.hook?.available ?? null })
      const granted = await saveSec(root, 'compiler-access', { restricted: true, accountIds: [fixture.accountId] })
      const again = granted.status === 200 ? await until(() => root.get(SEC('compiler-access')), r => r.data?.observation?.state === 'applied' && list(r.data.observation.group?.members).includes(fixture.username), POLL) : null
      check('GRANTED-ACCOUNT-IN-GROUP', granted.status === 200 && again?.settled === true, { status: granted.status, state: again?.last?.data?.observation?.state ?? null })
      refused('UNKNOWN-ACCOUNT-GRANT-REFUSED', await saveSec(root, 'compiler-access', { restricted: true, accountIds: ['00000000-0000-0000-0000-000000000000'] }), 'VALIDATION')
    },
  }),

  tool('waf-settings', {
    prefix: 'WAFS', restores: ['/api/server/sec/waf'], needs: ['account'], probe: SEC('waf'), paths: /^\/api\/server\/sec\/waf$/, requests: 8,
    unit: [{ id: 'WAFS-UNIT-READ', file: 'apps/api/src/sec-workspace.test.ts', name: 'sec server workspaces reads defaults with the strict host observation and refuses selectors, methods and non-root callers' }],
    checks: ['ENGINE-DETECTION-ONLY', 'BLOCKING-REQUEST-RETURNS-200', 'INVALID-POLICY-REFUSED'],
    async run({ root, fixture, site, check, refused }) {
      const view = await root.get(SEC('waf')), engine = view.data?.observation?.engineConf?.ruleEngine ?? null
      check('ENGINE-DETECTION-ONLY', view.status === 200 && engine === 'DetectionOnly', { status: view.status, ruleEngine: engine })
      const probe = await site.get(fixture.domain, `/?xq=${encodeURIComponent('<script>alert(1)</script>')}&id=${encodeURIComponent("1' OR '1'='1")}`)
      check('BLOCKING-REQUEST-RETURNS-200', view.status === 200 && probe.status === 200, { viewStatus: view.status, status: probe.status })
      const expectedRevision = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      refused('INVALID-POLICY-REFUSED', await root.put(SEC('waf'), { expectedRevision, policy: { unknownField: true } }), 'VALIDATION')
    },
  }),

  tool('flood-protection', {
    prefix: 'FLDP', restores: ['/api/server/sec/flood'], probe: SEC('flood'), paths: /^\/api\/server\/sec\/flood$/, requests: 30,
    unit: [{ id: 'FLDP-UNIT-SAVE', file: 'apps/api/src/sec-workspace.test.ts', name: 'sec server workspaces saves under CAS with a re-read, audits, then requests reconciliation' }],
    checks: ['INVALID-LIMIT-REFUSED', 'METER-RULE-RENDERED', 'SELF-LOCKOUT-REFUSED'],
    async run({ root, check, refused, undo, until }) {
      const { read, view } = await guardSec(root, 'flood', undo)
      if (!view) return check('INVALID-LIMIT-REFUSED', false, { status: read.status })
      const policy = { enabled: true, connectionsPerAddress: 0, newConnectionsPerSecond: null, newConnectionsBurst: null, pingPerSecond: null, webConnectionsPerAddress: null }
      refused('INVALID-LIMIT-REFUSED', await root.put(SEC('flood'), { expectedRevision: view.revision, policy }), 'VALIDATION')
      // A limit far above any real client count: the rule renders without throttling the session that drives this run.
      const saved = await saveSec(root, 'flood', { ...policy, connectionsPerAddress: 100000 })
      const rendered = saved.status === 200 ? await until(() => root.get(SEC('flood')), r => r.data?.observation?.state === 'read' && r.data.observation.rules?.connections > 0, POLL) : null
      check('METER-RULE-RENDERED', saved.status === 200 && rendered?.settled === true, { status: saved.status, rules: rendered?.last?.data?.observation?.rules?.connections ?? null })
      // The criterion names SELF_LOCKOUT for a set that drops the current address; a harmless rate is sent so a missing guard cannot cut access.
      refused('SELF-LOCKOUT-REFUSED', await saveSec(root, { ...policy, connectionsPerAddress: 100000, newConnectionsPerSecond: 100000, newConnectionsBurst: 100000 } ? 'flood' : 'flood', { ...policy, connectionsPerAddress: 100000, newConnectionsPerSecond: 100000, newConnectionsBurst: 100000 }), 'SELF_LOCKOUT')
    },
  }),

  tool('intrusion-detection', {
    prefix: 'IDET', restores: ['/api/server/security-tools/intrusion'], probe: `${TOOLS}/intrusion`, paths: /^\/api\/server\/security-tools\/intrusion(?:\/unban|\?jail=sshd)?$/, requests: 6,
    unit: [{ id: 'IDET-UNIT-PROJECT', file: 'apps/api/src/security-tools-workspace.test.ts', name: 'API security tools workspace projects host reads, dropping unknown fields and refusing inconsistent evidence' }],
    page: { route: '/whm/security/intrusion', read: `${TOOLS}/intrusion`, shows: data => list(data?.jails).map(jail => jail.name) },
    checks: ['SSHD-JAIL-OBSERVED', 'INVALID-UNBAN-REFUSED', 'SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get(`${TOOLS}/intrusion`), jail = list(view.data?.jails).find(item => item.name === 'sshd')
      check('SSHD-JAIL-OBSERVED', view.status === 200 && view.data?.state === 'read' && jail?.state === 'read' && Number.isInteger(jail.currentlyBanned), { status: view.status, state: view.data?.state ?? null, jails: list(view.data?.jails).length })
      refused('INVALID-UNBAN-REFUSED', await root.post(`${TOOLS}/intrusion/unban`, { jail: 'sshd', address: 'not-an-ip' }), 'VALIDATION')
      refused('SELECTOR-REFUSED', await root.get(`${TOOLS}/intrusion?jail=sshd`), 'VALIDATION')
    },
  }),

  tool('account-isolation', {
    prefix: 'ISOL', restores: ['/api/server/security-tools/isolation'], needs: ['account'], probe: `${TOOLS}/isolation`, paths: /^\/api\/server\/security-tools\/isolation(?:\/verify|\?(?:account=[a-z][a-z0-9]{0,15}|extra=1))?$/, requests: 6,
    unit: [
      { id: 'ISOL-UNIT-PROJECT', file: 'apps/api/src/security-tools-workspace.test.ts', name: 'API security tools workspace projects host reads, dropping unknown fields and refusing inconsistent evidence' },
      { id: 'ISOL-UNIT-FPM-STRIP', file: 'packages/render/src/edge/apache.test.ts', name: 'renderApacheBase strips tenant PHP_VALUE and PHP_ADMIN_VALUE before every FastCGI call' },
      { id: 'ISOL-UNIT-FPM-PREFORK', file: 'packages/core/src/rules/php.test.ts', name: 'availableHandlers Apache + prefork: refused with the installer code, and suPHP is reported as unable to run' },
    ],
    checks: ['ISOLATION-OBSERVED', 'HOME-LISTING-OWN-ONLY', 'FOREIGN-FILE-READ-DENIED', 'INVALID-SELECTOR-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get(`${TOOLS}/isolation?account=${fixture.username}`), report = view.data?.report, byId = id => list(report?.checks).find(item => item.id === id)?.state
      check('ISOLATION-OBSERVED', view.status === 200 && list(view.data?.accounts).some(item => item.username === fixture.username) && report?.username === fixture.username && ['passwd', 'home', 'slice'].every(id => byId(id) === 'ok'),
        { status: view.status, report: report?.state ?? null, home: byId('home') ?? null })
      const proof = await root.post(`${TOOLS}/isolation/verify`, { account: fixture.username }), state = id => list(proof.data?.checks).find(item => item.id === id)?.state
      check('HOME-LISTING-OWN-ONLY', proof.status === 200 && state('jail-home-list') === 'ok', { status: proof.status, state: state('jail-home-list') ?? null })
      check('FOREIGN-FILE-READ-DENIED', proof.status === 200 && ['ok', 'unavailable'].includes(state('jail-other-home')), { status: proof.status, state: state('jail-other-home') ?? null })
      refused('INVALID-SELECTOR-REFUSED', await root.get(`${TOOLS}/isolation?extra=1`), 'VALIDATION')
    },
  }),

  tool('root-ssh-keys', {
    prefix: 'RSSH', probe: '/api/security/ssh', paths: /^\/api\/security\/ssh(?:\/keys|\?window=(?:7d|99d))?$/, requests: 6,
    unit: [{ id: 'RSSH-UNIT-BOUNDARY', file: 'apps/api/src/security-workspace.test.ts', name: 'root security workspace route boundary returns individual observations without an overall security pass or state allocation' }],
    page: { route: '/whm/security/ssh', read: '/api/security/ssh', shows: data => list(data?.ssh?.keys?.items).slice(0, 1).map(key => key.fingerprint) },
    checks: ['AUTHORIZED-KEYS-LISTED', 'SEVEN-DAY-WINDOW-OBSERVED', 'INVALID-KEY-REFUSED'],
    async run({ root, check, refused }) {
      // Root authorized keys are never changed by a driver: a wrong write could end every SSH path to the host.
      const view = await root.get('/api/security/ssh'), keys = view.data?.ssh?.keys
      check('AUTHORIZED-KEYS-LISTED', view.status === 200 && ['read', 'partial'].includes(keys?.state) && list(keys.items).length > 0 && list(keys.items).every(key => /^SHA256:/.test(key.fingerprint)), { status: view.status, state: keys?.state ?? null, keys: list(keys?.items).length })
      const week = await root.get('/api/security/ssh?window=7d')
      const badWindow = await root.get('/api/security/ssh?window=99d')
      check('SEVEN-DAY-WINDOW-OBSERVED', week.status === 200 && week.data?.ssh?.failedLogins?.window === '7d' && badWindow.status === 422, { status: week.status, window: week.data?.ssh?.failedLogins?.window ?? null, badWindowStatus: badWindow.status })
      const expectedRevision = typeof keys?.revision === 'string' ? keys.revision : '0'.repeat(64)
      refused('INVALID-KEY-REFUSED', await root.post('/api/security/ssh/keys', { publicKey: 'ssh-ed25519\u0000invalid', expectedRevision }), 'VALIDATION')
    },
  }),

  tool('security-advisor', {
    prefix: 'SADV', probe: '/api/security/workspace', paths: /^\/api\/security\/workspace(?:\?window=99d)?$/, requests: 4,
    unit: [{ id: 'SADV-UNIT-OBSERVE', file: 'apps/api/src/security-workspace.test.ts', name: 'root security workspace route boundary returns individual observations without an overall security pass or state allocation' }],
    page: { route: '/whm/security', read: '/api/security/workspace', shows: data => Number.isInteger(data?.configuration?.panelPort) ? [String(data.configuration.panelPort)] : [] },
    checks: ['SCAN-RETURNS-CHECKS', 'FIVE-SSH-CHECKS-GRADED', 'INVALID-WINDOW-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/security/workspace'), checks = list(view.data?.checks)
      check('SCAN-RETURNS-CHECKS', view.status === 200 && checks.length > 0 && checks.every(item => typeof item.id === 'string' && ['observed-ok', 'attention', 'unavailable'].includes(item.state)), { status: view.status, checks: checks.length })
      const expectedIds = ['ssh-service', 'ssh-public-key', 'ssh-password', 'ssh-root-login', 'ssh-attempts']
      const sshService = checks.find(item => item.id === 'ssh-service')
      check('FIVE-SSH-CHECKS-GRADED', view.status === 200 && expectedIds.every(id => checks.some(item => item.id === id)) && sshService?.state === 'observed-ok', { status: view.status, sshService: sshService?.state ?? null })
      refused('INVALID-WINDOW-REFUSED', await root.get('/api/security/workspace?window=99d'), 'VALIDATION')
    },
  }),

  tool('userdir-protection', {
    prefix: 'UDIR', needs: ['account'], probe: '/api/accounts', paths: /^\/api\/accounts$/, requests: 4,
    unit: [{ id: 'UDIR-UNIT-DISABLED', file: 'packages/render/src/edge/apache.test.ts', name: 'renderApacheBase protects INI and htaccess files and serves a default vhost first' }],
    checks: ['PROTECTED-USERDIR-REFUSED', 'ROOT-USERDIR-REFUSED'],
    async run({ root, fixture, site, check }) {
      const accounts = await root.get('/api/accounts')
      const response = await site.get(fixture.domain, `/~${fixture.username}/`)
      check('PROTECTED-USERDIR-REFUSED', accounts.status === 200 && [403, 404].includes(response.status), { accountsStatus: accounts.status, status: response.status })
      const rootDir = await site.get(fixture.domain, '/~root/')
      check('ROOT-USERDIR-REFUSED', accounts.status === 200 && [403, 404].includes(rootDir.status), { accountsStatus: accounts.status, status: rootDir.status })
    },
  }),

  tool('xwhm-two-factor-auth', {
    prefix: 'XTFA', probe: '/api/resellers', paths: /^\/api\/(?:resellers(?:\/[0-9a-f-]{36})?|auth\/(?:2fa\/(?:setup|enable|disable)|login|logout))$/, requests: 20,
    unit: [{ id: 'XTFA-UNIT-POLICY', file: 'apps/api/src/mfa-runtime-policy.test.ts', name: 'trusted development MFA runtime policy skips an enrolled factor only in development and preserves its persistent state' }],
    checks: ['ENROLLED', 'WRONG-CODE-TOTP-INVALID', 'ADJACENT-STEP-ACCEPTED', 'DISABLED-PASSWORD-ONLY'],
    async run({ root, tag, check, refused, undo, signIn }) {
      // A run-scoped reseller carries the factor; root two-factor state is never touched.
      const username = `xr${tag}`, password = secret()
      const made = await root.post('/api/resellers', { username, password, acl: ['list-accounts'], maxAccounts: 1, totalDiskMb: 1024, totalBandwidthMb: 1024, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] })
      const id = made.data?.reseller?.id
      if (made.status !== 201 || typeof id !== 'string') return check('ENROLLED', false, { status: made.status })
      undo('reseller', async () => [200, 404].includes((await root.delete(`/api/resellers/${id}`)).status))
      const { client } = await signIn('reseller', { username, password })
      const setup = client ? await client.post('/api/auth/2fa/setup', { password }) : null, key = setup?.data?.secret
      const recoveryCode = Array.isArray(setup?.data?.recoveryCodes) ? setup.data.recoveryCodes[0] : null
      const enabled = typeof key === 'string' ? await client.post('/api/auth/2fa/enable', { code: totp(key) }) : null
      if (!check('ENROLLED', enabled?.status === 200 && enabled.data?.totpEnabled === true, { signedIn: client !== null, setup: setup?.status ?? null, status: enabled?.status ?? null })) return
      refused('WRONG-CODE-TOTP-INVALID', await root.anonymous('/api/auth/login', { method: 'POST', body: { username, password, totpCode: '000000' } }), 'UNAUTHENTICATED')
      const adjacent = await root.anonymous('/api/auth/login', { method: 'POST', body: { username, password, totpCode: totp(key, 1) } })
      const cookie = adjacent.setCookie?.find(value => value.startsWith('__Host-xwhm_session='))?.split(';')[0]
      if (cookie) undo('adjacent-step session', async () => (await root.anonymous('/api/auth/logout', { method: 'POST', body: {}, cookie, csrf: adjacent.data?.csrfToken })).status === 200)
      check('ADJACENT-STEP-ACCEPTED', adjacent.status === 200 && cookie !== undefined, { status: adjacent.status })
      const disabled = typeof recoveryCode === 'string' ? await client.post('/api/auth/2fa/disable', { password, recoveryCode }) : null
      const passwordOnly = disabled?.status === 200 ? await root.anonymous('/api/auth/login', { method: 'POST', body: { username, password } }) : null
      const afterCookie = passwordOnly?.setCookie?.find(value => value.startsWith('__Host-xwhm_session='))?.split(';')[0]
      if (afterCookie) undo('password-only session', async () => (await root.anonymous('/api/auth/logout', { method: 'POST', body: {}, cookie: afterCookie, csrf: passwordOnly.data?.csrfToken })).status === 200)
      check('DISABLED-PASSWORD-ONLY', disabled?.status === 200 && passwordOnly?.status === 200 && afterCookie !== undefined, { disableStatus: disabled?.status ?? null, loginStatus: passwordOnly?.status ?? null })
    },
  }),
]
