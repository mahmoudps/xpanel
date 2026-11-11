import { randomBytes } from 'node:crypto'
import { safeResponse, tool } from './kit.mjs'

const credential = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const ID = '[0-9a-f-]{36}'
const SSL_ID = '[a-z0-9][a-z0-9_-]{0,63}'
const ZERO_REV = '0'.repeat(64)
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const ACCOUNT_SECURITY_PAGE = { route: '/security/account', read: '/api/auth/me', shows: data => [data?.principal?.username] }

const deleteSslItem = (owner, username, kind, id) => async () => {
  const store = await owner.get(`/api/accounts/${username}/ssl`)
  if (store.status !== 200) return false
  const listKey = kind === 'key' ? 'keys' : kind === 'csr' ? 'csrs' : 'certificates'
  const item = (store.data?.[listKey] ?? []).find(entry => entry.id === id)
  if (!item) return true
  const res = await owner.delete(`/api/accounts/${username}/ssl/${listKey}/${id}`, { modifiedAt: item.modifiedAt })
  return res.status === 200
}

export default [
  tool('account-usage-stats', {
    prefix: 'S12T01', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:accounts|plans|domains|databases|service-users(?:\/${ID})?|analytics\/io)$`), requests: 25,
    unit: [{ id: 'S12T01-UNIT-1', file: 'apps/web/src/resources-traffic-ssr.test.ts', name: 'SSR wiring for account resources and traffic analytics passes the existing account-usage observation to /resources and keeps it distinct from stored plan limits' }],
    checks: ['PLAN-LIMITS-SCOPED', 'MAILBOX-COUNT-INCREMENTS', 'ADMIN-IO-UNEXPOSED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const [accts, plans, domains, dbs, beforeUsers] = await Promise.all([
        owner.get('/api/accounts'),
        owner.get('/api/plans'),
        owner.get('/api/domains'),
        owner.get('/api/databases'),
        owner.get('/api/service-users'),
      ])
      const acct = (accts.data?.accounts ?? [])[0]
      const plan = (plans.data?.plans ?? []).find(item => item?.id === acct?.planId)
      const countMail = res => (res.data?.serviceUsers ?? []).filter(item => item?.services?.email === true).length
      const beforeCount = countMail(beforeUsers)
      check('PLAN-LIMITS-SCOPED', accts.status === 200 && acct?.id === fixture.accountId && Boolean(plan?.resources) && domains.status === 200 && dbs.status === 200 && beforeUsers.status === 200, {
        status: accts.status, diskMb: plan?.resources?.diskMb ?? null, mailboxesBefore: beforeCount,
      })
      const login = `xqu${tag}@${fixture.domain}`
      const created = await owner.post('/api/service-users', {
        login, password: credential(), services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 128,
      })
      const id = created.data?.serviceUser?.id
      if (typeof id === 'string') {
        undo('usage mailbox', async () => [200, 202, 204, 404].includes((await owner.delete(`/api/service-users/${id}`)).status))
      }
      const afterUsers = await owner.get('/api/service-users')
      const afterCount = countMail(afterUsers)
      check('MAILBOX-COUNT-INCREMENTS', created.status === 201 && afterUsers.status === 200 && afterCount === beforeCount + 1, {
        created: created.status, beforeCount, afterCount,
      })
      refused('ADMIN-IO-UNEXPOSED', await owner.get('/api/analytics/io'), 404)
    },
  }),

  tool('resource-usage', {
    prefix: 'S12T02', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:accounts|plans|domains|analytics\/io|server\/monitoring\/io)$/, requests: 16,
    unit: [{ id: 'S12T02-UNIT-1', file: 'apps/web/src/themes/v2/pages/xpanel/resources.test.ts', name: 'v2 account resources retains history, limits, events, processes and folder sections without manufacturing readings' }],
    checks: ['SLICE-CAPS-REPORTED', 'ANALYTICS-IO-UNEXPOSED', 'SERVER-IO-UNEXPOSED'],
    async run({ owner, fixture, check, refused }) {
      const [accts, plans] = await Promise.all([owner.get('/api/accounts'), owner.get('/api/plans')])
      const acct = (accts.data?.accounts ?? [])[0]
      const plan = (plans.data?.plans ?? []).find(item => item?.id === acct?.planId)
      const res = plan?.resources
      check('SLICE-CAPS-REPORTED', accts.status === 200 && acct?.id === fixture.accountId && Number.isInteger(res?.memoryMb) && Number.isInteger(res?.maxProcesses), {
        status: accts.status, memoryMb: res?.memoryMb ?? null, maxProcesses: res?.maxProcesses ?? null,
      })
      refused('ANALYTICS-IO-UNEXPOSED', await owner.get('/api/analytics/io'), 404)
      refused('SERVER-IO-UNEXPOSED', await owner.get('/api/server/monitoring/io'), 404)
    },
  }),

  tool('ssl-private-keys', {
    prefix: 'S12T03', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:domains|accounts\/[a-z][a-z0-9]{0,15}\/ssl(?:\/keys(?:\/${SSL_ID})?)?)$`), requests: 25,
    unit: [{ id: 'S12T03-UNIT-1', file: 'apps/api/src/ssl-store-workspace.test.ts', name: '/api/accounts/{account}/ssl refuses invalid material at the API before anything is sent' }],
    checks: ['INVALID-PEM-REFUSED', 'WEAK-KEYTYPE-REFUSED', 'ECDSA-P384-GENERATED-AND-REMOVED'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const base = `/api/accounts/${fixture.username}/ssl`
      refused('INVALID-PEM-REFUSED', await owner.post(`${base}/keys`, { pem: 'not-a-private-key' }), 'VALIDATION')
      refused('WEAK-KEYTYPE-REFUSED', await owner.post(`${base}/keys`, { keyType: 'rsa-1024' }), 'VALIDATION')
      const label = `xq-${tag}`
      const created = await owner.post(`${base}/keys`, { keyType: 'ecdsa-secp384r1', label })
      const changedId = (created.data?.application?.changed ?? []).find(item => item?.kind === 'key')?.id
      const keyItem = (created.data?.keys ?? []).find(item => item?.id === changedId || item?.label === label)
      if (typeof keyItem?.id === 'string') undo('ssl key', deleteSslItem(owner, fixture.username, 'key', keyItem.id))
      const detail = typeof keyItem?.id === 'string' ? await owner.get(`${base}/keys/${keyItem.id}`) : { status: 0, data: null }
      const removed = typeof keyItem?.id === 'string' && typeof keyItem?.modifiedAt === 'string'
        ? await owner.delete(`${base}/keys/${keyItem.id}`, { modifiedAt: keyItem.modifiedAt })
        : { status: 0, data: null }
      check('ECDSA-P384-GENERATED-AND-REMOVED', created.status === 200 && keyItem?.keyType === 'ec' && keyItem?.curve === 'secp384r1' && keyItem?.bits === 384 && detail.status === 200 && typeof detail.data?.pem === 'string' && detail.data.pem.startsWith('-----BEGIN') && removed.status === 200, {
        status: created.status, curve: keyItem?.curve ?? null, removedStatus: removed.status,
      })
    },
  }),

  tool('ssl-csrs', {
    prefix: 'S12T04', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:domains|accounts\/[a-z][a-z0-9]{0,15}\/ssl(?:\/(?:keys|csrs)(?:\/${SSL_ID})?)?)$`), requests: 25,
    unit: [{ id: 'S12T04-UNIT-1', file: 'apps/api/src/ssl-store-workspace.test.ts', name: '/api/server/ssl (root store) passes the challenge passphrase to the agent only in the request body' }],
    checks: ['EMPTY-NAMES-REFUSED', 'SHORT-PASSPHRASE-REFUSED', 'CSR-MATCHES-KEY-AND-SANS'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const base = `/api/accounts/${fixture.username}/ssl`
      refused('EMPTY-NAMES-REFUSED', await owner.post(`${base}/csrs`, { keyType: 'rsa-2048', names: [] }), 'VALIDATION')
      refused('SHORT-PASSPHRASE-REFUSED', await owner.post(`${base}/csrs`, { keyType: 'rsa-2048', names: [fixture.domain], passphrase: 'ab' }), 'VALIDATION')
      const keyRes = await owner.post(`${base}/keys`, { keyType: 'rsa-2048', label: `xqk-${tag}` })
      const keyId = (keyRes.data?.application?.changed ?? []).find(item => item?.kind === 'key')?.id
      const keyItem = (keyRes.data?.keys ?? []).find(item => item?.id === keyId)
      if (typeof keyItem?.id === 'string') undo('csr key', deleteSslItem(owner, fixture.username, 'key', keyItem.id))
      const names = [fixture.domain, `www.${fixture.domain}`]
      const csrRes = typeof keyItem?.id === 'string'
        ? await owner.post(`${base}/csrs`, { keyId: keyItem.id, names, subject: { country: 'US', organization: 'xPanel' }, label: `xqc-${tag}` })
        : { status: 0, data: null }
      const csrId = (csrRes.data?.application?.changed ?? []).find(item => item?.kind === 'csr')?.id
      const csrItem = (csrRes.data?.csrs ?? []).find(item => item?.id === csrId)
      if (typeof csrItem?.id === 'string') undo('csr item', deleteSslItem(owner, fixture.username, 'csr', csrItem.id))
      const detail = typeof csrItem?.id === 'string' ? await owner.get(`${base}/csrs/${csrItem.id}`) : { status: 0, data: null }
      const hasSans = names.every(name => (csrItem?.names ?? []).includes(name))
      const sameKey = typeof keyItem?.publicKeySha256 === 'string' && csrItem?.publicKeySha256 === keyItem.publicKeySha256
      check('CSR-MATCHES-KEY-AND-SANS', csrRes.status === 200 && hasSans && sameKey && detail.status === 200 && typeof detail.data?.pem === 'string' && detail.data.pem.includes('BEGIN CERTIFICATE REQUEST'), {
        status: csrRes.status, hasSans, sameKey,
      })
    },
  }),

  tool('ssl-certificates', {
    prefix: 'S12T05', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:domains|accounts\/[a-z][a-z0-9]{0,15}\/ssl(?:\/(?:keys|certificates)(?:\/${SSL_ID})?)?)$`), requests: 25,
    unit: [{ id: 'S12T05-UNIT-1', file: 'apps/api/src/ssl-store-workspace.test.ts', name: '/api/accounts/{account}/ssl reads install material only in its pinned shape' }],
    checks: ['INVALID-SUBJECT-REFUSED', 'BAD-PEM-REFUSED', 'SELF-SIGNED-STORED-WITH-NAMES'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const base = `/api/accounts/${fixture.username}/ssl`
      refused('INVALID-SUBJECT-REFUSED', await owner.post(`${base}/certificates`, { keyType: 'rsa-2048', names: [fixture.domain], subject: { country: 'bad' } }), 'VALIDATION')
      refused('BAD-PEM-REFUSED', await owner.post(`${base}/certificates`, { pem: 'not-a-certificate' }), 'VALIDATION')
      const names = [fixture.domain, `www.${fixture.domain}`]
      const created = await owner.post(`${base}/certificates`, {
        keyType: 'ecdsa-prime256v1', names, days: 30, subject: { country: 'US', organization: 'xPanel' }, label: `xqcert-${tag}`,
      })
      for (const changed of created.data?.application?.changed ?? []) {
        if (typeof changed?.id === 'string' && (changed.kind === 'certificate' || changed.kind === 'key')) {
          undo(`ssl ${changed.kind}`, deleteSslItem(owner, fixture.username, changed.kind === 'key' ? 'key' : 'cert', changed.id))
        }
      }
      const certId = (created.data?.application?.changed ?? []).find(item => item?.kind === 'certificate')?.id
      const certItem = (created.data?.certificates ?? []).find(item => item?.id === certId)
      const detail = typeof certItem?.id === 'string' ? await owner.get(`${base}/certificates/${certItem.id}`) : { status: 0, data: null }
      const hasNames = names.every(name => (certItem?.names ?? []).includes(name))
      check('SELF-SIGNED-STORED-WITH-NAMES', created.status === 200 && certItem?.selfSigned === true && hasNames && detail.status === 200 && typeof detail.data?.pem === 'string' && detail.data.pem.includes('BEGIN CERTIFICATE'), {
        status: created.status, selfSigned: certItem?.selfSigned ?? null, hasNames,
      })
    },
  }),

  tool('ssl-install', {
    prefix: 'S12T06', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:domains|accounts\/[a-z][a-z0-9]{0,15}\/(?:ssl(?:\/(?:keys|certificates)(?:\/${SSL_ID})?)?|certificates(?:\/install|\/${ID})?))$`), requests: 35,
    unit: [{ id: 'S12T06-UNIT-1', file: 'apps/api/src/certificate-install.test.ts', name: 'manual certificate installation refuses a mismatched, encrypted, weak or malformed private key without echoing it' }],
    checks: ['MISMATCHED-KEY-REFUSED', 'INSTALL-AND-UNINSTALL-BOUND'],
    async run({ owner, fixture, tag, check, refused, undo }) {
      const sslBase = `/api/accounts/${fixture.username}/ssl`
      const certBase = `/api/accounts/${fixture.username}/certificates`
      const genCert = await owner.post(`${sslBase}/certificates`, { keyType: 'ecdsa-prime256v1', names: [fixture.domain], days: 30, subject: { country: 'US' }, label: `xqi-${tag}` })
      for (const changed of genCert.data?.application?.changed ?? []) {
        if (typeof changed?.id === 'string' && (changed.kind === 'certificate' || changed.kind === 'key')) {
          undo(`install ${changed.kind}`, deleteSslItem(owner, fixture.username, changed.kind === 'key' ? 'key' : 'cert', changed.id))
        }
      }
      const otherKey = await owner.post(`${sslBase}/keys`, { keyType: 'ecdsa-prime256v1', label: `xqwrong-${tag}` })
      const wrongKeyId = (otherKey.data?.application?.changed ?? []).find(item => item?.kind === 'key')?.id
      if (typeof wrongKeyId === 'string') undo('wrong key', deleteSslItem(owner, fixture.username, 'key', wrongKeyId))
      const certId = (genCert.data?.application?.changed ?? []).find(item => item?.kind === 'certificate')?.id
      const certPem = typeof certId === 'string' ? (await owner.get(`${sslBase}/certificates/${certId}`)).data?.pem : null
      const wrongPem = typeof wrongKeyId === 'string' ? (await owner.get(`${sslBase}/keys/${wrongKeyId}`)).data?.pem : null
      const before = await owner.get(certBase)
      const rev = Number.isInteger(before.data?.revision) ? before.data.revision : 0
      const mismatch = typeof certPem === 'string' && typeof wrongPem === 'string'
        ? await owner.post(`${certBase}/install`, { domain: fixture.domain, expectedRevision: rev, fullchainPem: certPem, privateKeyPem: wrongPem })
        : await owner.post(`${certBase}/install`, { domain: fixture.domain, expectedRevision: rev, fullchainPem: 'bad', privateKeyPem: 'bad' })
      refused('MISMATCHED-KEY-REFUSED', mismatch, 'VALIDATION')
      undo('installed certificate', async () => {
        const now = await owner.get(certBase)
        if (now.status !== 200) return false
        const bound = (now.data?.domains ?? []).find(item => item?.name === fixture.domain)?.certificateId
        if (typeof bound !== 'string') return true
        const del = await owner.delete(`${certBase}/${bound}`, { expectedRevision: now.data.revision })
        return del.status === 200
      })
      const installed = typeof certId === 'string'
        ? await owner.post(`${certBase}/install`, { domain: fixture.domain, expectedRevision: rev, storeCertificateId: certId })
        : { status: 0, data: null }
      const installedCertId = installed.data?.certificate?.id
      const afterInstall = await owner.get(certBase)
      const boundAfter = (afterInstall.data?.domains ?? []).find(item => item?.name === fixture.domain)?.certificateId
      const removed = typeof installedCertId === 'string' && Number.isInteger(afterInstall.data?.revision)
        ? await owner.delete(`${certBase}/${installedCertId}`, { expectedRevision: afterInstall.data.revision })
        : { status: 0, data: null }
      check('INSTALL-AND-UNINSTALL-BOUND', installed.status === 200 && typeof installedCertId === 'string' && boundAfter === installedCertId && removed.status === 200, {
        installStatus: installed.status, boundMatched: boundAfter === installedCertId, removeStatus: removed.status,
      })
    },
  }),

  tool('ssl-tls-status', {
    prefix: 'S12T07', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains|accounts\/[a-z0-9_-]{1,32}\/certificates|server\/sec\/autossl)$/, requests: 20,
    unit: [{ id: 'S12T07-UNIT-1', file: 'apps/api/src/autossl.test.ts', name: 'AutoSSL candidates leaves out a current certificate, DNS-01, an excluded account or domain and another account on request' }],
    checks: ['UNSECURED-DOMAIN-VISIBLE', 'UNOWNED-DOMAIN-REFUSED', 'AUTOSSL-POLICY-AND-EXCLUSION-CHECK'],
    async run({ owner, root, fixture, check, refused }) {
      const certs = await owner.get(`/api/accounts/${fixture.username}/certificates`)
      const dom = (certs.data?.domains ?? []).find(item => item?.name === fixture.domain)
      check('UNSECURED-DOMAIN-VISIBLE', certs.status === 200 && dom !== undefined && dom.certificateId === null, {
        status: certs.status, hasDomain: dom !== undefined, unsecured: dom?.certificateId === null,
      })
      refused('UNOWNED-DOMAIN-REFUSED', await owner.post(`/api/accounts/${fixture.username}/certificates`, { domain: 'unowned.example.invalid' }), 'NOT_FOUND')
      const autossl = await root.get('/api/server/sec/autossl')
      const rev = typeof autossl.data?.revision === 'string' ? autossl.data.revision : ZERO_REV
      const badExclude = await root.put('/api/server/sec/autossl', {
        ...(autossl.data?.policy ?? { enabled: false, renewDays: 30, replaceInvalid: false, adminNotify: 'failures', userNotify: 'none', excludedAccounts: [] }),
        excludedDomains: ['bad domain'],
        expectedRevision: rev,
      })
      check('AUTOSSL-POLICY-AND-EXCLUSION-CHECK', autossl.status === 200 && Array.isArray(autossl.data?.queue) && badExclude.status === 422 && badExclude.data?.code === 'VALIDATION', {
        readStatus: autossl.status, badExclude: safeResponse(badExclude),
      })
    },
  }),

  tool('security-policy', {
    prefix: 'S12T08', as: 'owner', needs: ['account'], probe: '/api/auth/security-questions', page: ACCOUNT_SECURITY_PAGE,
    paths: /^\/api\/auth\/security-questions(?:\/addresses)?$/, requests: 25,
    unit: [{ id: 'S12T08-UNIT-1', file: 'apps/api/src/security-questions.test.ts', name: 'verified-address sign-in asks an unverified address, verifies it on correct answers and counts wrong answers as failures' }],
    checks: ['SINGLE-QUESTION-REFUSED', 'MALFORMED-IP-REFUSED', 'QUESTIONS-AND-TRUSTED-IP-LIFECYCLE'],
    async run({ owner, fixture, check, refused, undo }) {
      refused('SINGLE-QUESTION-REFUSED', await owner.put('/api/auth/security-questions', {
        currentPassword: 'ignored',
        questions: [{ question: 'What was your very first car?', answer: 'civic' }],
      }), 'VALIDATION')
      refused('MALFORMED-IP-REFUSED', await owner.post('/api/auth/security-questions/addresses', { action: 'add', address: 'not-an-ip' }), 'VALIDATION')
      undo('owner security questions', async () => {
        await owner.post('/api/auth/security-questions/addresses', { action: 'remove', address: '198.51.100.42' })
        const cleared = await owner.put('/api/auth/security-questions', { currentPassword: fixture.password, questions: [] })
        return cleared.status === 200 && Array.isArray(cleared.data?.questions) && cleared.data.questions.length === 0
      })
      const saved = await owner.put('/api/auth/security-questions', {
        currentPassword: fixture.password,
        questions: [
          { question: 'What city did you grow up in?', answer: 'alexandria' },
          { question: 'What was your childhood nickname?', answer: 'falcon' },
        ],
      })
      const addedIp = await owner.post('/api/auth/security-questions/addresses', { action: 'add', address: '198.51.100.42' })
      const hasIp = (addedIp.data?.addresses ?? []).some(item => item?.address === '198.51.100.42')
      const removedIp = await owner.post('/api/auth/security-questions/addresses', { action: 'remove', address: '198.51.100.42' })
      const cleared = await owner.put('/api/auth/security-questions', { currentPassword: fixture.password, questions: [] })
      check('QUESTIONS-AND-TRUSTED-IP-LIFECYCLE', saved.status === 200 && (saved.data?.questions ?? []).length === 2 && addedIp.status === 200 && hasIp && removedIp.status === 200 && cleared.status === 200 && (cleared.data?.questions ?? []).length === 0, {
        savedStatus: saved.status, hasIp, clearedStatus: cleared.status,
      })
    },
  }),

  tool('perl-modules', {
    prefix: 'S12T09', as: 'owner', needs: ['account'], probe: '/api/account/perl-modules',
    paths: /^\/api\/account\/perl-modules(?:\/log|\/search\?q=[A-Za-z0-9:_-]+)?$/, requests: 20,
    unit: [{ id: 'S12T09-UNIT-1', file: 'apps/api/src/perl-cpan-search.test.ts', name: 'CPAN search keeps one documented module per distribution and checks every field' }],
    checks: ['LIBRARY-PATH-SCOPED', 'EMPTY-MODULE-REFUSED', 'MALFORMED-MODULE-REFUSED', 'SHORT-SEARCH-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const [view, log] = await Promise.all([owner.get('/api/account/perl-modules'), owner.get('/api/account/perl-modules/log')])
      const expectedLib = `/home/${fixture.username}/perl5/lib/perl5`
      check('LIBRARY-PATH-SCOPED', view.status === 200 && view.data?.context?.accountId === fixture.accountId && view.data?.library === expectedLib && typeof view.data?.useLine === 'string' && view.data.useLine.includes(expectedLib) && log.status === 200 && Array.isArray(log.data?.lines), {
        status: view.status, logStatus: log.status, engine: view.data?.engine ?? null,
      })
      refused('EMPTY-MODULE-REFUSED', await owner.post('/api/account/perl-modules', { action: 'install', module: '' }), 'VALIDATION')
      refused('MALFORMED-MODULE-REFUSED', await owner.post('/api/account/perl-modules', { action: 'install', module: 'Bad;Module' }), 'VALIDATION')
      refused('SHORT-SEARCH-REFUSED', await owner.get('/api/account/perl-modules/search?q=a'), 'VALIDATION')
    },
  }),

  tool('optimize-website', {
    prefix: 'S12T10', as: 'owner', needs: ['account'], probe: '/api/account/optimize',
    paths: /^\/api\/account\/(?:optimize(?:\?x=1)?|runtime)$/, requests: 20,
    unit: [{ id: 'S12T10-UNIT-1', file: 'apps/agent/src/sw-optimize.test.ts', name: 'edge optimization policy parses the managed nginx directives and always lists text/html' }],
    checks: ['OPTIMIZE-READ-SCOPED', 'MALFORMED-MIME-REFUSED', 'SPECIFIED-TYPES-SAVED-AND-RESTORED'],
    async run({ owner, fixture, check, refused, undo }) {
      const [opt, rt] = await Promise.all([owner.get('/api/account/optimize'), owner.get('/api/account/runtime')])
      check('OPTIMIZE-READ-SCOPED', opt.status === 200 && opt.data?.context?.accountId === fixture.accountId && rt.status === 200 && typeof rt.data?.revision === 'string', {
        optStatus: opt.status, state: opt.data?.state ?? null, rtStatus: rt.status,
      })
      refused('MALFORMED-MIME-REFUSED', await owner.post('/api/account/runtime', {
        op: 'compression.save', expectedRevision: ZERO_REV, mode: 'types', types: ['texthtml'],
      }), 'VALIDATION')
      if (typeof rt.data?.revision !== 'string') {
        check('SPECIFIED-TYPES-SAVED-AND-RESTORED', false, { rtStatus: rt.status })
        return
      }
      undo('account compression', async () => {
        const now = await owner.get('/api/account/runtime')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.compression == null) return true
        const back = await owner.post('/api/account/runtime', { op: 'compression.save', expectedRevision: now.data.revision, mode: 'default', types: [] })
        return back.status === 200
      })
      const saved = await owner.post('/api/account/runtime', {
        op: 'compression.save', expectedRevision: rt.data.revision, mode: 'types', types: ['text/html', 'text/css'],
      })
      const reread = await owner.get('/api/account/runtime')
      const restored = typeof reread.data?.revision === 'string'
        ? await owner.post('/api/account/runtime', { op: 'compression.save', expectedRevision: reread.data.revision, mode: 'default', types: [] })
        : { status: 0 }
      check('SPECIFIED-TYPES-SAVED-AND-RESTORED', saved.status === 200 && reread.status === 200 && reread.data?.compression?.mode === 'types' && (reread.data?.compression?.types ?? []).includes('text/css') && restored.status === 200, {
        savedStatus: saved.status, mode: reread.data?.compression?.mode ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('application-manager', {
    prefix: 'S12T11', as: 'owner', needs: ['account'], probe: '/api/account/runtime',
    paths: /^\/api\/account\/runtime(?:\/log\?target=[A-Za-z0-9:_-]+)?$/, requests: 20,
    unit: [{ id: 'S12T11-UNIT-1', file: 'apps/api/src/account-runtime-workspace.test.ts', name: 'account runtime workspace reads logs only for a valid target and refuses non-owners before the agent' }],
    checks: ['RUNTIME-WORKSPACE-READ', 'INVALID-ENV-NAME-REFUSED', 'ROOT-TRAVERSAL-REFUSED', 'STALE-REVISION-CONFLICT'],
    async run({ owner, fixture, check, refused }) {
      const rt = await owner.get('/api/account/runtime')
      const domId = (rt.data?.domains ?? [])[0]?.id ?? ZERO_UUID
      check('RUNTIME-WORKSPACE-READ', rt.status === 200 && rt.data?.context?.accountId === fixture.accountId && Array.isArray(rt.data?.host?.runtimes) && Array.isArray(rt.data?.apps), {
        status: rt.status, runtimes: Array.isArray(rt.data?.host?.runtimes) ? rt.data.host.runtimes.length : null,
      })
      refused('INVALID-ENV-NAME-REFUSED', await owner.post('/api/account/runtime', {
        op: 'app.save', expectedRevision: ZERO_REV,
        app: { name: 'badenv', runtime: 'node', root: 'apps/badenv', startup: 'app.js', domainId: domId, path: '/app', env: { '1TOKEN': 'bad' } },
      }), 'VALIDATION')
      refused('ROOT-TRAVERSAL-REFUSED', await owner.post('/api/account/runtime', {
        op: 'app.save', expectedRevision: ZERO_REV,
        app: { name: 'badroot', runtime: 'node', root: '../escape', startup: 'app.js', domainId: domId, path: '/app', env: {} },
      }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await owner.post('/api/account/runtime', {
        op: 'compression.save', expectedRevision: ZERO_REV, mode: 'default', types: [],
      }), 'CONFLICT')
    },
  }),

  tool('web-apps', {
    prefix: 'S12T12', as: 'owner', needs: ['account'], probe: '/api/account/runtime',
    paths: /^\/api\/account\/runtime$/, requests: 20,
    unit: [{ id: 'S12T12-UNIT-1', file: 'apps/agent/src/web-apps.test.ts', name: 'web app staging and configuration refuses a second app on one domain path, a static app with a run mode and a disabled feature' }],
    checks: ['RUNTIME-VIEW-READ', 'DUAL-ENV-INPUT-REFUSED', 'INSECURE-GIT-URL-REFUSED', 'STALE-DEPLOY-CONFLICT'],
    async run({ owner, fixture, check, refused }) {
      const rt = await owner.get('/api/account/runtime')
      const domId = (rt.data?.domains ?? [])[0]?.id ?? ZERO_UUID
      check('RUNTIME-VIEW-READ', rt.status === 200 && rt.data?.context?.accountId === fixture.accountId && typeof rt.data?.revision === 'string', {
        status: rt.status, apps: Array.isArray(rt.data?.apps) ? rt.data.apps.length : null,
      })
      refused('DUAL-ENV-INPUT-REFUSED', await owner.post('/api/account/runtime', {
        op: 'webapp.configure', expectedRevision: ZERO_REV, name: 'xqweb',
        config: { domainId: domId, path: '/web', runtime: 'node', category: 'server', framework: null, startup: 'server.js', startCommand: null, buildCommand: null, outputDir: null, env: { A: '1' }, envText: 'A=1' },
      }), 'VALIDATION')
      refused('INSECURE-GIT-URL-REFUSED', await owner.post('/api/account/runtime', {
        op: 'webapp.stage', expectedRevision: ZERO_REV,
        app: { name: 'xqweb', source: { kind: 'git', url: 'http://example.com/repo.git', branch: null }, subfolder: null, domainId: domId, path: '/web' },
      }), 'VALIDATION')
      refused('STALE-DEPLOY-CONFLICT', await owner.post('/api/account/runtime', {
        op: 'webapp.deploy', expectedRevision: ZERO_REV, name: 'xqweb',
      }), 'CONFLICT')
    },
  }),

  tool('php-version-selector', {
    prefix: 'S12T13', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/(?:domains(?:\/${ID})?|account\/php-selector)$`), requests: 15,
    unit: [{ id: 'S12T13-UNIT-1', file: 'apps/web/src/board-port/approved-xpanel-workspaces.test.ts', name: 'account workspace structures and native binding boundaries requires the narrow PHP capability and the selected active owner before exposing the PATCH form' }],
    checks: ['MULTIPHP-DOMAIN-REPORTED', 'MISSING-DOMAIN-NOT-FOUND', 'SELECTOR-ROUTE-UNEXPOSED'],
    async run({ owner, fixture, check, refused }) {
      const listed = await owner.get('/api/domains')
      const dom = (listed.data?.domains ?? []).find(item => item?.name === fixture.domain)
      check('MULTIPHP-DOMAIN-REPORTED', listed.status === 200 && typeof dom?.php?.version === 'string' && typeof dom?.php?.handler === 'string', {
        status: listed.status, version: dom?.php?.version ?? null,
      })
      refused('MISSING-DOMAIN-NOT-FOUND', await owner.get(`/api/domains/${ZERO_UUID}`), 'NOT_FOUND')
      refused('SELECTOR-ROUTE-UNEXPOSED', await owner.get('/api/account/php-selector'), 404)
    },
  }),

  tool('nodejs-apps', {
    prefix: 'S12T14', as: 'owner', needs: ['account'], probe: '/api/account/runtime',
    paths: /^\/api\/account\/(?:runtime|nodejs-apps)$/, requests: 15,
    unit: [{ id: 'S12T14-UNIT-1', file: 'apps/agent/src/account-runtime.test.ts', name: 'applyRuntimeOp saves a new app stopped and keeps paths unique per domain' }],
    checks: ['NODE-RUNTIME-OBSERVED', 'NODE-TRAVERSAL-REFUSED', 'LEGACY-NODEJS-ROUTE-UNEXPOSED'],
    async run({ owner, check, refused }) {
      const rt = await owner.get('/api/account/runtime')
      const nodeRt = (rt.data?.host?.runtimes ?? []).find(item => item?.kind === 'node')
      const domId = (rt.data?.domains ?? [])[0]?.id ?? ZERO_UUID
      check('NODE-RUNTIME-OBSERVED', rt.status === 200 && nodeRt !== undefined && typeof nodeRt.available === 'boolean', {
        status: rt.status, available: nodeRt?.available ?? null,
      })
      refused('NODE-TRAVERSAL-REFUSED', await owner.post('/api/account/runtime', {
        op: 'app.save', expectedRevision: ZERO_REV,
        app: { name: 'xqnode', runtime: 'node', root: '../escape', startup: 'server.js', domainId: domId, path: '/node', env: {} },
      }), 'VALIDATION')
      refused('LEGACY-NODEJS-ROUTE-UNEXPOSED', await owner.get('/api/account/nodejs-apps'), 404)
    },
  }),

  tool('python-apps', {
    prefix: 'S12T15', as: 'owner', needs: ['account'], probe: '/api/account/runtime',
    paths: /^\/api\/account\/(?:runtime(?:\/log\?target=[^/]+)?|python-apps)$/, requests: 15,
    unit: [{ id: 'S12T15-UNIT-1', file: 'apps/agent/src/account-runtime.test.ts', name: 'dependency installs run as the account in its slice and are admitted only in their exact shape' }],
    checks: ['PYTHON-RUNTIME-OBSERVED', 'BAD-LOG-TARGET-REFUSED', 'LEGACY-PYTHON-ROUTE-UNEXPOSED'],
    async run({ owner, check, refused }) {
      const rt = await owner.get('/api/account/runtime')
      const pyRt = (rt.data?.host?.runtimes ?? []).find(item => item?.kind === 'python')
      check('PYTHON-RUNTIME-OBSERVED', rt.status === 200 && pyRt !== undefined && typeof pyRt.available === 'boolean', {
        status: rt.status, available: pyRt?.available ?? null,
      })
      refused('BAD-LOG-TARGET-REFUSED', await owner.get('/api/account/runtime/log?target=deps:..'), 'VALIDATION')
      refused('LEGACY-PYTHON-ROUTE-UNEXPOSED', await owner.get('/api/account/python-apps'), 404)
    },
  }),

  tool('ruby-apps', {
    prefix: 'S12T16', as: 'owner', needs: ['account'], probe: '/api/account/runtime',
    paths: /^\/api\/account\/(?:runtime|ruby-apps)$/, requests: 15,
    unit: [{ id: 'S12T16-UNIT-1', file: 'apps/agent/src/account-runtime.test.ts', name: 'host facts reads installed versions and reports what is missing truthfully' }],
    checks: ['RUBY-RUNTIME-OBSERVED', 'RESERVED-PORT-ENV-REFUSED', 'LEGACY-RUBY-ROUTE-UNEXPOSED'],
    async run({ owner, check, refused }) {
      const rt = await owner.get('/api/account/runtime')
      const rubyRt = (rt.data?.host?.runtimes ?? []).find(item => item?.kind === 'ruby')
      const domId = (rt.data?.domains ?? [])[0]?.id ?? ZERO_UUID
      check('RUBY-RUNTIME-OBSERVED', rt.status === 200 && rubyRt !== undefined && typeof rubyRt.available === 'boolean', {
        status: rt.status, available: rubyRt?.available ?? null,
      })
      refused('RESERVED-PORT-ENV-REFUSED', await owner.post('/api/account/runtime', {
        op: 'app.save', expectedRevision: ZERO_REV,
        app: { name: 'xqruby', runtime: 'ruby', root: 'apps/xqruby', startup: 'config.ru', domainId: domId, path: '/ruby', env: { PORT: '3000' } },
      }), 'VALIDATION')
      refused('LEGACY-RUBY-ROUTE-UNEXPOSED', await owner.get('/api/account/ruby-apps'), 404)
    },
  }),

  tool('terminal', {
    prefix: 'S12T17', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/account/terminal',
    paths: new RegExp(String.raw`^\/api\/(?:account\/terminal|accounts\/${ID})$`), requests: 25,
    unit: [{ id: 'S12T17-UNIT-1', file: 'apps/api/src/terminal-feature.test.ts', name: 'terminal sessions over the panel listeners (loopback) opens the owner jailed shell, relays input and UTF-8 output, closes explicitly and audits start and stop without keystrokes' }],
    checks: ['DISABLED-SHELL-FORBIDDEN', 'EXTRA-BODY-REFUSED', 'JAILED-TICKET-AND-CLOSE'],
    async run({ owner, root, fixture, check, refused, undo }) {
      const initial = await owner.get('/api/account/terminal')
      refused('DISABLED-SHELL-FORBIDDEN', await owner.post('/api/account/terminal', {}), 'FORBIDDEN')
      refused('EXTRA-BODY-REFUSED', await owner.post('/api/account/terminal', { cmd: 'id' }), 'VALIDATION')
      if (typeof fixture.accountId !== 'string') {
        check('JAILED-TICKET-AND-CLOSE', false, { initialStatus: initial.status })
        return
      }
      undo('account jailed shell', async () => {
        await owner.delete('/api/account/terminal')
        const reset = await root.patch(`/api/accounts/${fixture.accountId}`, { shell: 'none' })
        return reset.status === 200
      })
      const enabled = await root.patch(`/api/accounts/${fixture.accountId}`, { shell: 'jailed' })
      const afterEnable = await owner.get('/api/account/terminal')
      const opened = afterEnable.data?.execution?.state === 'available'
        ? await owner.post('/api/account/terminal', {})
        : { status: 0, data: null }
      const closed = await owner.delete('/api/account/terminal')
      check('JAILED-TICKET-AND-CLOSE', initial.status === 200 && enabled.status === 200 && afterEnable.data?.shell === 'jailed' && (afterEnable.data?.execution?.state === 'unavailable' || (opened.status === 201 && typeof opened.data?.ticket?.ticket === 'string')) && closed.status === 200, {
        enabledStatus: enabled.status, shellMode: afterEnable.data?.shell ?? null, executionState: afterEnable.data?.execution?.state ?? null, closedStatus: closed.status,
      })
    },
  }),

  tool('apache-handlers', {
    prefix: 'S12T18', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/domains(?:\/${ID}\/web-directives\/handlers)?$`), requests: 25,
    unit: [{ id: 'S12T18-UNIT-1', file: 'apps/api/src/web-directives-workspace.test.ts', name: 'web directives over the checked .htaccess workspace maps account handlers next to the read-only system mapping and keeps CGI to the per-account identity' }],
    checks: ['INVALID-HANDLER-REFUSED', 'SYSTEM-EXTENSION-PROTECTED', 'CGI-HANDLER-SAVED-AND-CLEARED'],
    async run({ owner, fixture, check, refused, undo }) {
      const domains = await owner.get('/api/domains')
      const domId = (domains.data?.domains ?? []).find(item => item?.name === fixture.domain)?.id
      if (typeof domId !== 'string') {
        check('INVALID-HANDLER-REFUSED', false, { status: domains.status })
        check('SYSTEM-EXTENSION-PROTECTED', false, { status: domains.status })
        check('CGI-HANDLER-SAVED-AND-CLEARED', false, { status: domains.status })
        return
      }
      const path = `/api/domains/${domId}/web-directives/handlers`
      const before = await owner.get(path)
      const rev = typeof before.data?.document?.revision === 'string' ? before.data.document.revision : ZERO_REV
      refused('INVALID-HANDLER-REFUSED', await owner.put(path, {
        expectedRevision: rev, model: { entries: [{ handler: 'invalid-handler', extensions: ['.cgi'] }] },
      }), 'VALIDATION')
      refused('SYSTEM-EXTENSION-PROTECTED', await owner.put(path, {
        expectedRevision: rev, model: { entries: [{ handler: 'default-handler', extensions: ['.php'] }] },
      }), 'VALIDATION')
      undo('apache handlers', async () => {
        const now = await owner.get(path)
        if (now.status !== 200 || typeof now.data?.document?.revision !== 'string') return false
        if ((now.data?.model?.entries ?? []).length === 0) return true
        return (await owner.put(path, { expectedRevision: now.data.document.revision, model: { entries: [] } })).status === 200
      })
      const saved = await owner.put(path, {
        expectedRevision: rev, model: { entries: [{ handler: 'cgi-script', extensions: ['.cgi'] }] },
      })
      const savedRev = saved.data?.document?.revision
      const cleared = typeof savedRev === 'string'
        ? await owner.put(path, { expectedRevision: savedRev, model: { entries: [] } })
        : { status: 0, data: null }
      check('CGI-HANDLER-SAVED-AND-CLEARED', before.status === 200 && Array.isArray(before.data?.system) && saved.status === 200 && saved.data?.managed === true && cleared.status === 200 && (cleared.data?.model?.entries ?? []).length === 0, {
        savedStatus: saved.status, clearedStatus: cleared.status,
      })
    },
  }),

  tool('change-language', {
    prefix: 'S12T19', as: 'owner', needs: ['account'], probe: '/api/auth/personal-preferences',
    paths: /^\/api\/auth\/personal-preferences$/, requests: 20,
    unit: [{ id: 'S12T19-UNIT-1', file: 'apps/api/src/personal-preferences.test.ts', name: 'personal preferences saves language, position and switches, and reads them for rendering' }],
    checks: ['UNKNOWN-LOCALE-REFUSED', 'STALE-REVISION-CONFLICT', 'ARABIC-LOCALE-SAVED-AND-RESTORED'],
    async run({ owner, check, refused, undo }) {
      const before = await owner.get('/api/auth/personal-preferences')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const base = {
        locale: before.data?.locale ?? null,
        noticePosition: before.data?.noticePosition ?? 'top-right',
        notifications: before.data?.notifications ?? { disk: true, bandwidth: true, announcements: true },
        onboardingDismissed: Boolean(before.data?.onboardingDismissed),
      }
      refused('UNKNOWN-LOCALE-REFUSED', await owner.put('/api/auth/personal-preferences', { ...base, locale: 'xx', expectedRevision: rev }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await owner.put('/api/auth/personal-preferences', { ...base, locale: 'ar', expectedRevision: ZERO_REV }), 'CONFLICT')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('ARABIC-LOCALE-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('personal locale', async () => {
        const now = await owner.get('/api/auth/personal-preferences')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.locale === base.locale) return true
        return (await owner.put('/api/auth/personal-preferences', { ...base, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await owner.put('/api/auth/personal-preferences', { ...base, locale: 'ar', expectedRevision: rev })
      const reread = await owner.get('/api/auth/personal-preferences')
      const restored = typeof reread.data?.revision === 'string'
        ? await owner.put('/api/auth/personal-preferences', { ...base, expectedRevision: reread.data.revision })
        : { status: 0 }
      check('ARABIC-LOCALE-SAVED-AND-RESTORED', saved.status === 200 && reread.status === 200 && reread.data?.locale === 'ar' && restored.status === 200, {
        savedStatus: saved.status, localeAfterSave: reread.data?.locale ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('team-audit-log', {
    prefix: 'S12T20', as: 'owner', needs: ['account'], probe: '/api/account/team-audit', page: ACCOUNT_SECURITY_PAGE,
    paths: /^\/api\/account\/(?:team-audit(?:\?[A-Za-z0-9=&._%-]+)?|preferences)$/, requests: 20,
    unit: [{ id: 'S12T20-UNIT-1', file: 'apps/api/src/account-team-audit.test.ts', name: 'team audit page names the team login when the request came from a member' }],
    checks: ['AUDIT-SCOPED-TO-ACCOUNT', 'AUDITED-WRITE-FILTERED', 'INVALID-CURSOR-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const initial = await owner.get('/api/account/team-audit')
      check('AUDIT-SCOPED-TO-ACCOUNT', initial.status === 200 && initial.data?.context?.accountId === fixture.accountId && Array.isArray(initial.data?.rows), {
        status: initial.status, count: Array.isArray(initial.data?.rows) ? initial.data.rows.length : null,
      })
      const prefs = await owner.get('/api/account/preferences')
      if (prefs.status === 200 && typeof prefs.data?.revision === 'string') {
        await owner.patch('/api/account/preferences', {
          notificationPosition: prefs.data?.preferences?.notificationPosition ?? 'top-right',
          expectedRevision: prefs.data.revision,
        })
      }
      const filtered = await owner.get('/api/account/team-audit?q=preferences')
      check('AUDITED-WRITE-FILTERED', filtered.status === 200 && filtered.data?.context?.accountId === fixture.accountId && Array.isArray(filtered.data?.rows), {
        status: filtered.status, rows: Array.isArray(filtered.data?.rows) ? filtered.data.rows.length : null,
      })
      refused('INVALID-CURSOR-REFUSED', await owner.get('/api/account/team-audit?before=invalid'), 'VALIDATION')
    },
  }),

  tool('change-style', {
    prefix: 'S12T21', as: 'owner', needs: ['account'], probe: '/api/auth/ui-preferences',
    paths: /^\/api\/auth\/ui-preferences(?:\?owner=1)?$/, requests: 20,
    unit: [{ id: 'S12T21-UNIT-1', file: 'apps/api/src/ui-preferences.test.ts', name: 'personal UI preferences API returns default and registered choices without exposing storage identities' }],
    checks: ['UNKNOWN-THEME-REFUSED', 'SELECTOR-QUERY-REFUSED', 'REGISTERED-THEME-SAVED'],
    async run({ owner, check, refused }) {
      const before = await owner.get('/api/auth/ui-preferences')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const choice = (before.data?.choices ?? [])[0] ?? null
      refused('UNKNOWN-THEME-REFUSED', await owner.put('/api/auth/ui-preferences', { uiTheme: 'nonexistent-theme', expectedRevision: rev }), 'VALIDATION')
      refused('SELECTOR-QUERY-REFUSED', await owner.get('/api/auth/ui-preferences?owner=1'), 'VALIDATION')
      const saved = typeof choice === 'string' && before.status === 200
        ? await owner.put('/api/auth/ui-preferences', { uiTheme: choice, expectedRevision: rev })
        : { status: 0, data: null }
      check('REGISTERED-THEME-SAVED', before.status === 200 && typeof choice === 'string' && saved.status === 200 && saved.data?.uiTheme === choice && saved.data?.state === 'saved', {
        status: saved.status, uiTheme: saved.data?.uiTheme ?? null,
      })
    },
  }),

  tool('show-accounts-over-quota', {
    prefix: 'S12T22', as: 'root', needs: ['account'], probe: '/api/accounts/health',
    paths: /^\/api\/accounts\/(?:health(?:\?username=[A-Za-z0-9_-]+)?|disk-quotas(?:\?q=[a-z0-9_-]+)?)$/, requests: 20,
    unit: [{ id: 'S12T22-UNIT-1', file: 'apps/api/src/account-health-workspace.test.ts', name: 'account health workspace API rechecks exactly the selected visible accounts and refuses others as absent' }],
    checks: ['HEALTH-AND-QUOTAS-OBSERVED', 'INVALID-USERNAME-REFUSED', 'ABSENT-ACCOUNT-NOT-FOUND'],
    async run({ root, fixture, check, refused }) {
      const [health, quotas] = await Promise.all([
        root.get(`/api/accounts/health?username=${fixture.username}`),
        root.get(`/api/accounts/disk-quotas?q=${fixture.username}`),
      ])
      const acctRow = (health.data?.accounts ?? []).find(item => item?.username === fixture.username)
      const quotaRow = (quotas.data?.rows ?? []).find(item => item?.username === fixture.username)
      check('HEALTH-AND-QUOTAS-OBSERVED', health.status === 200 && acctRow !== undefined && Array.isArray(acctRow.checks) && quotas.status === 200 && quotaRow !== undefined, {
        healthStatus: health.status, quotaStatus: quotas.status, source: quotaRow?.source ?? null,
      })
      refused('INVALID-USERNAME-REFUSED', await root.get('/api/accounts/health?username=BAD_NAME'), 'VALIDATION')
      refused('ABSENT-ACCOUNT-NOT-FOUND', await root.get('/api/accounts/health?username=zzznosuchacct'), 'NOT_FOUND')
    },
  }),

  tool('view-bandwidth-usage', {
    prefix: 'S12T23', as: 'root', needs: ['account'], probe: '/api/server/monitoring/bandwidth',
    paths: /^\/api\/server\/monitoring\/bandwidth(?:\?month=2026-01)?$/, requests: 15,
    unit: [{ id: 'S12T23-UNIT-1', file: 'apps/api/src/metering-workspace.test.ts', name: 'metering API boundary keeps unmeasured bandwidth null, never zero, and refuses measured rows without totals' }],
    checks: ['CURRENT-MONTH-OBSERVED', 'MONTH-SELECTOR-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const bw = await root.get('/api/server/monitoring/bandwidth')
      const row = (bw.data?.accounts ?? []).find(item => item?.username === fixture.username)
      check('CURRENT-MONTH-OBSERVED', bw.status === 200 && /^\d{4}-\d{2}$/.test(bw.data?.month ?? '') && row !== undefined, {
        status: bw.status, month: bw.data?.month ?? null, state: bw.data?.state ?? null,
      })
      refused('MONTH-SELECTOR-REFUSED', await root.get('/api/server/monitoring/bandwidth?month=2026-01'), 'VALIDATION')
    },
  }),

  tool('change-site-ip', {
    prefix: 'S12T24', as: 'root', needs: ['account'], probe: '/api/ips/usage',
    paths: new RegExp(String.raw`^\/api\/(?:ips(?:\/usage)?|accounts\/${ID}\/ip)$`), requests: 20,
    unit: [{ id: 'S12T24-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: "root IP tools changes a site's IP, reconciles and reports the held address" }],
    checks: ['IP-INVENTORY-OBSERVED', 'UNPOOLED-IP-FORBIDDEN', 'MALFORMED-IP-REFUSED', 'ABSENT-ACCOUNT-NOT-FOUND'],
    async run({ root, fixture, check, refused }) {
      const [ips, usage] = await Promise.all([root.get('/api/ips'), root.get('/api/ips/usage')])
      const assigned = (usage.data?.ips ?? []).some(row => (row?.accounts ?? []).some(a => a?.username === fixture.username))
      check('IP-INVENTORY-OBSERVED', ips.status === 200 && Array.isArray(ips.data?.ips) && ips.data.ips.length >= 1 && usage.status === 200 && assigned, {
        ipsStatus: ips.status, poolSize: Array.isArray(ips.data?.ips) ? ips.data.ips.length : null, assigned,
      })
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('UNPOOLED-IP-FORBIDDEN', await root.post(`/api/accounts/${acctId}/ip`, { ipv4: '192.0.2.254' }), 'FORBIDDEN')
      refused('MALFORMED-IP-REFUSED', await root.post(`/api/accounts/${acctId}/ip`, { ipv4: 'not-an-ip' }), 'VALIDATION')
      refused('ABSENT-ACCOUNT-NOT-FOUND', await root.post(`/api/accounts/${ZERO_UUID}/ip`, { ipv4: '192.0.2.254' }), 'NOT_FOUND')
    },
  }),

  tool('quota-modification', {
    prefix: 'S12T25', as: 'root', needs: ['account'], probe: '/api/accounts/disk-quotas',
    paths: new RegExp(String.raw`^\/api\/accounts\/(?:disk-quotas(?:\?[A-Za-z0-9=&_-]+)?|${ID}\/limits)$`), requests: 25,
    unit: [{ id: 'S12T25-UNIT-1', file: 'apps/api/src/account-limits-workspace.test.ts', name: 'account limit overrides and bandwidth relief routes pages the WHM Quota Modification table on the server with the limit in force and its source' }],
    checks: ['NEGATIVE-QUOTA-REFUSED', 'INVALID-SORT-REFUSED', 'QUOTA-OVERRIDE-AND-RESTORE'],
    async run({ root, fixture, check, refused, undo }) {
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('NEGATIVE-QUOTA-REFUSED', await root.patch(`/api/accounts/${acctId}/limits`, { resources: { diskMb: -10 } }), 'VALIDATION')
      refused('INVALID-SORT-REFUSED', await root.get('/api/accounts/disk-quotas?sort=invalid'), 'VALIDATION')
      if (typeof fixture.accountId !== 'string') {
        check('QUOTA-OVERRIDE-AND-RESTORE', false, { accountId: null })
        return
      }
      undo('disk quota override', async () => (await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { diskMb: null } })).status === 200)
      const updated = await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { diskMb: 2560 } })
      const table = await root.get(`/api/accounts/disk-quotas?q=${fixture.username}`)
      const row = (table.data?.rows ?? []).find(item => item?.username === fixture.username)
      const cleared = await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { diskMb: null } })
      check('QUOTA-OVERRIDE-AND-RESTORE', updated.status === 200 && table.status === 200 && row?.limitMb === 2560 && row?.source === 'account' && cleared.status === 200, {
        updatedStatus: updated.status, limitMb: row?.limitMb ?? null, source: row?.source ?? null, clearedStatus: cleared.status,
      })
    },
  }),

  tool('limit-bandwidth-usage', {
    prefix: 'S12T26', as: 'root', needs: ['account'], probe: '/api/accounts',
    paths: new RegExp(String.raw`^\/api\/accounts(?:\/bandwidth\/custom|\/${ID}\/limits)?$`), requests: 25,
    unit: [{ id: 'S12T26-UNIT-1', file: 'apps/api/src/account-limits-workspace.test.ts', name: 'account limit overrides and bandwidth relief routes saves one account override, applies it through the host reconcile and reports the effective limits' }],
    checks: ['NEGATIVE-BANDWIDTH-REFUSED', 'CUSTOM-BANDWIDTH-SAVED-AND-CLEARED'],
    async run({ root, fixture, check, refused, undo }) {
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('NEGATIVE-BANDWIDTH-REFUSED', await root.patch(`/api/accounts/${acctId}/limits`, { resources: { bandwidthMbMonth: -1 } }), 'VALIDATION')
      if (typeof fixture.accountId !== 'string') {
        check('CUSTOM-BANDWIDTH-SAVED-AND-CLEARED', false, { accountId: null })
        return
      }
      undo('bandwidth limit override', async () => (await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { bandwidthMbMonth: null } })).status === 200)
      const updated = await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { bandwidthMbMonth: 4096 } })
      const custom = await root.get('/api/accounts/bandwidth/custom')
      const entry = (custom.data?.accounts ?? []).find(item => item?.accountId === fixture.accountId)
      const cleared = await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { bandwidthMbMonth: null } })
      check('CUSTOM-BANDWIDTH-SAVED-AND-CLEARED', updated.status === 200 && custom.status === 200 && entry?.customLimitMb === 4096 && cleared.status === 200, {
        updatedStatus: updated.status, customLimitMb: entry?.customLimitMb ?? null, clearedStatus: cleared.status,
      })
    },
  }),

  tool('reset-account-bandwidth-limit', {
    prefix: 'S12T27', as: 'root', needs: ['account'], probe: '/api/accounts/bandwidth/custom',
    paths: new RegExp(String.raw`^\/api\/accounts\/(?:bandwidth\/(?:custom|reset)|${ID}\/limits)$`), requests: 25,
    unit: [{ id: 'S12T27-UNIT-1', file: 'apps/api/src/account-limits-workspace.test.ts', name: 'account limit overrides and bandwidth relief routes lists only custom bandwidth limits, resets them to the package value and relieves limited accounts until 00:00 UTC' }],
    checks: ['EMPTY-LIST-REFUSED', 'PACKAGE-DEFAULT-CONFLICT', 'CUSTOM-LIMIT-RESET-TO-PACKAGE'],
    async run({ root, fixture, check, refused, undo }) {
      refused('EMPTY-LIST-REFUSED', await root.post('/api/accounts/bandwidth/reset', { accounts: [] }), 'VALIDATION')
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('PACKAGE-DEFAULT-CONFLICT', await root.post('/api/accounts/bandwidth/reset', { accounts: [acctId] }), 'CONFLICT')
      if (typeof fixture.accountId !== 'string') {
        check('CUSTOM-LIMIT-RESET-TO-PACKAGE', false, { accountId: null })
        return
      }
      undo('reset bandwidth fallback', async () => (await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { bandwidthMbMonth: null } })).status === 200)
      const setCustom = await root.patch(`/api/accounts/${fixture.accountId}/limits`, { resources: { bandwidthMbMonth: 5120 } })
      const reset = await root.post('/api/accounts/bandwidth/reset', { accounts: [fixture.accountId] })
      const after = await root.get('/api/accounts/bandwidth/custom')
      const stillCustom = (after.data?.accounts ?? []).some(item => item?.accountId === fixture.accountId)
      check('CUSTOM-LIMIT-RESET-TO-PACKAGE', setCustom.status === 200 && reset.status === 200 && after.status === 200 && !stillCustom, {
        setStatus: setCustom.status, resetStatus: reset.status, stillCustom,
      })
    },
  }),

  tool('unsuspend-bandwidth-exceeders', {
    prefix: 'S12T28', as: 'root', needs: ['account'], probe: '/api/server/monitoring/bandwidth',
    paths: /^\/api\/(?:server\/monitoring\/bandwidth|accounts\/bandwidth\/relief)$/, requests: 15,
    unit: [{ id: 'S12T28-UNIT-1', file: 'apps/api/src/account-limits-workspace.test.ts', name: 'account limit overrides and bandwidth relief routes lists only custom bandwidth limits, resets them to the package value and relieves limited accounts until 00:00 UTC' }],
    checks: ['EMPTY-RELIEF-REFUSED', 'UNLIMITED-ACCOUNT-CONFLICT', 'ABSENT-ACCOUNT-NOT-FOUND'],
    async run({ root, fixture, refused }) {
      refused('EMPTY-RELIEF-REFUSED', await root.post('/api/accounts/bandwidth/relief', { accounts: [] }), 'VALIDATION')
      refused('UNLIMITED-ACCOUNT-CONFLICT', await root.post('/api/accounts/bandwidth/relief', { accounts: [fixture.accountId ?? ZERO_UUID] }), 'CONFLICT')
      refused('ABSENT-ACCOUNT-NOT-FOUND', await root.post('/api/accounts/bandwidth/relief', { accounts: [ZERO_UUID] }), 'NOT_FOUND')
    },
  }),

  tool('force-password-change', {
    prefix: 'S12T29', as: 'root', also: ['owner'], needs: ['account'], probe: '/api/accounts/admin',
    paths: /^\/api\/(?:accounts\/admin(?:\/password-change)?|domains)$/, requests: 25,
    unit: [{ id: 'S12T29-UNIT-1', file: 'apps/api/src/account-admin-workspace.test.ts', name: 'account administration sets the flag per account and never reaches an account outside the caller' }],
    checks: ['EMPTY-USERS-REFUSED', 'ROTATION-FLAG-BLOCKS-AND-CLEARS'],
    async run({ root, owner, fixture, check, refused, undo }) {
      refused('EMPTY-USERS-REFUSED', await root.put('/api/accounts/admin/password-change', { users: {} }), 'VALIDATION')
      undo('clear rotation flag', async () => (await root.put('/api/accounts/admin/password-change', { users: { [fixture.username]: false } })).status === 200)
      const flagged = await root.put('/api/accounts/admin/password-change', { users: { [fixture.username]: true } })
      const adminView = await root.get('/api/accounts/admin')
      const acctRow = (adminView.data?.accounts ?? []).find(item => item?.username === fixture.username)
      const blockedDomains = await owner.get('/api/domains')
      const meDuring = await owner.get('/api/auth/me')
      const cleared = await root.put('/api/accounts/admin/password-change', { users: { [fixture.username]: false } })
      const restoredDomains = await owner.get('/api/domains')
      check('ROTATION-FLAG-BLOCKS-AND-CLEARS', flagged.status === 200 && acctRow?.forcedPassword === true && blockedDomains.status === 403 && blockedDomains.data?.code === 'FORBIDDEN' && meDuring.status === 200 && cleared.status === 200 && restoredDomains.status === 200, {
        flaggedStatus: flagged.status, forcedFlag: acctRow?.forcedPassword === true, deniedStatus: blockedDomains.status, restoredStatus: restoredDomains.status,
      })
    },
  }),

  tool('rearrange-account', {
    prefix: 'S12T30', as: 'root', needs: ['account'], probe: '/api/accounts/admin',
    paths: new RegExp(String.raw`^\/api\/accounts\/(?:admin|${ID}\/rearrange)$`), requests: 20,
    unit: [{ id: 'S12T30-UNIT-1', file: 'apps/api/src/account-admin-workspace.test.ts', name: 'account administration moves an account for root only, and only an account root can see' }],
    checks: ['HOME-ROOTS-OBSERVED', 'NON-HOME-ROOT-REFUSED', 'SAME-HOME-PRECONDITION', 'EXTRA-FIELD-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const admin = await root.get('/api/accounts/admin')
      const roots = admin.data?.homeRoots
      check('HOME-ROOTS-OBSERVED', admin.status === 200 && Array.isArray(roots) && roots.some(item => item?.path === '/home'), {
        status: admin.status, roots: Array.isArray(roots) ? roots.length : null,
      })
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('NON-HOME-ROOT-REFUSED', await root.post(`/api/accounts/${acctId}/rearrange`, { root: '/etc' }), 'VALIDATION')
      refused('SAME-HOME-PRECONDITION', await root.post(`/api/accounts/${acctId}/rearrange`, { root: '/home' }), 'PRECONDITION_FAILED')
      refused('EXTRA-FIELD-REFUSED', await root.post(`/api/accounts/${acctId}/rearrange`, { root: '/home2', force: true }), 'VALIDATION')
    },
  }),

  tool('raw-apache-log-download', {
    prefix: 'S12T31', as: 'root', needs: ['account'], probe: '/api/server/logs/raw/apache',
    page: { route: '/whm/monitoring/logs', read: '/api/server/logs/retention' },
    paths: /^\/api\/server\/logs\/raw\/apache(?:\?all=1|\/(?:shadow|(?:access|error)\.log(?:\.[1-9][0-9]?)?(?:\.gz)?))?$/, requests: 15,
    unit: [{ id: 'S12T31-UNIT-1', file: 'apps/api/src/account-logs-workspace.test.ts', name: 'account site logs workspace lets only root list and download the web servers own logs by their fixed names' }],
    checks: ['APACHE-RAW-LOGS-LISTED', 'DISALLOWED-FILE-NOT-FOUND', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const listed = await root.get('/api/server/logs/raw/apache')
      check('APACHE-RAW-LOGS-LISTED', listed.status === 200 && listed.data?.server === 'apache' && Array.isArray(listed.data?.files), {
        status: listed.status, state: listed.data?.state ?? null, files: Array.isArray(listed.data?.files) ? listed.data.files.length : null,
      })
      refused('DISALLOWED-FILE-NOT-FOUND', await root.get('/api/server/logs/raw/apache/shadow'), 'NOT_FOUND')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/logs/raw/apache?all=1'), 'VALIDATION')
    },
  }),

  tool('raw-ftp-log-download', {
    prefix: 'S12T32', as: 'root', needs: ['account'], probe: '/api/domains',
    page: { route: '/whm/monitoring/logs', read: '/api/server/logs/retention' },
    paths: /^\/api\/(?:domains|server\/ftp-log\/raw(?:\?[^\s]+)?)$/, requests: 15,
    unit: [{ id: 'S12T32-UNIT-1', file: 'apps/api/src/whm-log-tools-workspace.test.ts', name: 'WHM log tools streams the gzip for a whole-second window and audits the download' }],
    checks: ['INVALID-HOURS-REFUSED', 'INVALID-DOMAIN-REFUSED', 'FTP-LOG-WINDOW-OR-DISABLED'],
    async run({ root, fixture, check, refused }) {
      refused('INVALID-HOURS-REFUSED', await root.get(`/api/server/ftp-log/raw?domain=${encodeURIComponent(fixture.domain)}&hours=5`), 'VALIDATION')
      refused('INVALID-DOMAIN-REFUSED', await root.get('/api/server/ftp-log/raw?domain=BAD%20DOMAIN&hours=24'), 'VALIDATION')
      const res = await root.get(`/api/server/ftp-log/raw?domain=${encodeURIComponent(fixture.domain)}&hours=1`)
      const validOutcome = res.status === 200 || (res.status === 409 && res.data?.code === 'SERVICE_DISABLED')
      check('FTP-LOG-WINDOW-OR-DISABLED', validOutcome, safeResponse(res))
    },
  }),

  tool('raw-nginx-log-download', {
    prefix: 'S12T33', as: 'root', needs: ['account'], probe: '/api/server/logs/raw/nginx',
    page: { route: '/whm/monitoring/logs', read: '/api/server/logs/retention' },
    paths: /^\/api\/server\/logs\/raw\/nginx(?:\?x=1|\/(?:shadow|(?:access|error)\.log(?:\.[1-9][0-9]?)?(?:\.gz)?))?$/, requests: 15,
    unit: [{ id: 'S12T33-UNIT-1', file: 'apps/api/src/account-logs-workspace.test.ts', name: 'account site logs workspace lets only root list and download the web servers own logs by their fixed names' }],
    checks: ['NGINX-RAW-LOGS-LISTED', 'DISALLOWED-FILE-NOT-FOUND', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const listed = await root.get('/api/server/logs/raw/nginx')
      check('NGINX-RAW-LOGS-LISTED', listed.status === 200 && listed.data?.server === 'nginx' && Array.isArray(listed.data?.files), {
        status: listed.status, state: listed.data?.state ?? null, files: Array.isArray(listed.data?.files) ? listed.data.files.length : null,
      })
      refused('DISALLOWED-FILE-NOT-FOUND', await root.get('/api/server/logs/raw/nginx/shadow'), 'NOT_FOUND')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/logs/raw/nginx?x=1'), 'VALIDATION')
    },
  }),
]
