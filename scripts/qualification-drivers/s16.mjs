import { tool } from './kit.mjs'

const WEBMAIL = '/api/webmail'
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const folderQuery = folder => `${WEBMAIL}/inbox?folder=${encodeURIComponent(folder)}`
const messagesOf = response => response.data?.messages ?? []
const hasSubject = (response, subject) => response.status === 200 && messagesOf(response).some(item => item.subject === subject)
const only = (response, subject) => messagesOf(response).filter(item => item.subject === subject)
const statusOf = response => ({ status: response?.status ?? null })
const failAll = (check, ids, observed) => ids.forEach(id => check(id, false, observed))
const sendTo = (mailbox, to, subject, text, extra = {}) => mailbox.post(`${WEBMAIL}/send`, { to, subject, text, ...extra })
const delivered = (until, mailbox, folder, subject) =>
  until(() => mailbox.get(folderQuery(folder)), response => hasSubject(response, subject), { attempts: 15, delayMs: 2000 })

const SEGMENTS = Object.freeze({ key: ['keys', 'keys'], csr: ['csrs', 'csrs'], certificate: ['certificates', 'certificates'] })
const removeSslChanged = (client, basePath, changed, undo) => {
  if (!Array.isArray(changed)) return
  for (const item of changed) {
    const pair = SEGMENTS[item?.kind]
    if (!pair || typeof item?.id !== 'string') continue
    const [segment, listKey] = pair, id = item.id
    undo(`ssl ${item.kind} ${id}`, async () => {
      const view = await client.get(basePath)
      if (view.status !== 200) return false
      const row = view.data?.[listKey]?.find(entry => entry.id === id)
      if (!row) return true
      const gone = await client.delete(`${basePath}/${segment}/${id}`, { modifiedAt: row.modifiedAt })
      return gone.status === 200 && !gone.data?.[listKey]?.some(entry => entry.id === id)
    })
  }
}

const spamFields = view => view.preferences
  ? {
      inherit: view.preferences.inherit,
      enabled: view.preferences.enabled,
      addHeaderScore: view.preferences.addHeaderScore,
      spamBoxEnabled: view.preferences.spamBoxEnabled,
      autoDeleteScore: view.preferences.autoDeleteScore ?? null,
      allowlist: view.preferences.allowlist,
      blocklist: view.preferences.blocklist,
    }
  : {
      inherit: true,
      enabled: view.inherited.enabled,
      addHeaderScore: view.inherited.addHeaderScore,
      spamBoxEnabled: view.inherited.spamBoxEnabled,
      autoDeleteScore: view.inherited.autoDeleteScore ?? null,
      allowlist: [],
      blocklist: [],
    }

const svgBase64 = size =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#2563eb"/></svg>`, 'utf8').toString('base64')

export default [
  tool('service-ssl-certificates', {
    prefix: 'S16T01', as: 'root', probe: '/api/server/services/certificates',
    paths: /^\/api\/server\/(?:services\/certificates|ssl(?:\/certificates\/[a-z0-9_-]{1,64}\/install)?)$/,
    unit: [{ id: 'S16T01-UNIT-1', file: 'apps/agent/src/service-detail-routes.test.ts', name: 'agent service detail routes serves each detail to root with no-store' }],
    checks: ['ENDPOINTS-OBSERVED', 'PANEL-LISTENER-REFUSED', 'FTP-SERVICE-REFUSED', 'UNKNOWN-SERVICE-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/services/certificates')
      const store = await root.get('/api/server/ssl')
      check('ENDPOINTS-OBSERVED', view.status === 200 && view.data?.kind === 'certificates' && Array.isArray(view.data?.endpoints) && store.status === 200 && Array.isArray(store.data?.certificates), { status: view.status, store: store.status })
      refused('PANEL-LISTENER-REFUSED', await root.post('/api/server/ssl/certificates/xqcert01/install', { service: 'panel' }), 'PRECONDITION_FAILED')
      refused('FTP-SERVICE-REFUSED', await root.post('/api/server/ssl/certificates/xqcert01/install', { service: 'ftp' }), 'PRECONDITION_FAILED')
      refused('UNKNOWN-SERVICE-VALIDATION', await root.post('/api/server/ssl/certificates/xqcert01/install', { service: 'invalid' }), 'VALIDATION')
    },
  }),

  tool('nameserver-selection', {
    prefix: 'S16T02', as: 'root', probe: '/api/server/service-selection',
    paths: /^\/api\/server\/service-selection$/,
    unit: [{ id: 'S16T02-UNIT-1', file: 'apps/agent/src/server-operations.test.ts', name: 'server operations on the host keeps a disabled role daemon out of the generation and leaves nginx alone' }],
    checks: ['SELECTION-VIEW-READ', 'NOOP-CHANGE-REFUSED', 'UNSUPPORTED-DAEMON-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/service-selection')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      const dnsServer = typeof view.data?.state?.dnsServer === 'string' ? view.data.state.dnsServer : 'powerdns'
      const ftpServer = typeof view.data?.state?.ftpServer === 'string' ? view.data.state.ftpServer : 'disabled'
      check('SELECTION-VIEW-READ', view.status === 200 && typeof view.data?.revision === 'string' && ['powerdns', 'disabled'].includes(view.data?.state?.dnsServer), { status: view.status, dnsServer: view.data?.state?.dnsServer ?? null })
      refused('NOOP-CHANGE-REFUSED', await root.put('/api/server/service-selection', { dnsServer, ftpServer, expectedRevision: rev }), 'VALIDATION')
      refused('UNSUPPORTED-DAEMON-REFUSED', await root.put('/api/server/service-selection', { dnsServer: 'bind9', ftpServer: 'pure-ftpd', expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('service-manager', {
    prefix: 'S16T03', as: 'root', probe: '/api/server/service-manager',
    paths: /^\/api\/server\/service-manager(?:\/action)?$/,
    unit: [{ id: 'S16T03-UNIT-1', file: 'apps/agent/src/service-manager-routes.test.ts', name: 'service manager host routes refuses stale revisions, protected units and audit failure without submission' }],
    checks: ['INVENTORY-OBSERVED', 'UNSUPPORTED-MONITOR-ACTION-VALIDATION', 'REBOOT-WITHOUT-CONFIRMATION-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/service-manager')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      check('INVENTORY-OBSERVED', view.status === 200 && Array.isArray(view.data?.units) && typeof view.data?.revision === 'string', { status: view.status, units: Array.isArray(view.data?.units) ? view.data.units.length : null })
      refused('UNSUPPORTED-MONITOR-ACTION-VALIDATION', await root.post('/api/server/service-manager/action', { action: 'monitor', unit: 'nginx.service', expectedRevision: rev }), 'VALIDATION')
      refused('REBOOT-WITHOUT-CONFIRMATION-VALIDATION', await root.post('/api/server/service-manager/action', { action: 'reboot', confirmation: 'CANCEL', expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('php-fpm-service', {
    prefix: 'S16T04', as: 'root', probe: '/api/server/sec/php-fpm-defaults',
    paths: /^\/api\/server\/(?:sec\/php-fpm-defaults|services)$/,
    unit: [{ id: 'S16T04-UNIT-1', file: 'apps/agent/src/phase2-host.test.ts', name: 'host services reports one PHP-FPM row per installed version with running, failed and stopped master counts' }],
    checks: ['DEFAULTS-AND-MASTERS-READ', 'MAX-CHILDREN-ZERO-VALIDATION', 'MALFORMED-INI-LOCK-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/sec/php-fpm-defaults')
      const services = await root.get('/api/server/services')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      const pool = view.data?.policy?.pool ?? { mode: 'ondemand', maxChildren: 5, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }
      const ini = view.data?.policy?.ini ?? { allow_url_fopen: null, short_open_tag: null, log_errors: null, error_reporting: null }
      check('DEFAULTS-AND-MASTERS-READ', view.status === 200 && typeof view.data?.revision === 'string' && typeof view.data?.policy?.pool?.maxChildren === 'number' && services.status === 200, { status: view.status, services: services.status })
      refused('MAX-CHILDREN-ZERO-VALIDATION', await root.put('/api/server/sec/php-fpm-defaults', { policy: { pool: { ...pool, maxChildren: 0 }, ini }, expectedRevision: rev }), 'VALIDATION')
      refused('MALFORMED-INI-LOCK-VALIDATION', await root.put('/api/server/sec/php-fpm-defaults', { policy: { pool, ini: { ...ini, allow_url_fopen: { value: 'yes' } } }, expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('generate-csr', {
    prefix: 'S16T05', as: 'root', needs: ['account'], probe: '/api/server/ssl',
    paths: /^\/api\/accounts\/[a-z][a-z0-9]{0,15}\/ssl(?:\/(?:keys|csrs|certificates)(?:\/[a-z0-9][a-z0-9_-]{0,63})?)?$/,
    unit: [{ id: 'S16T05-UNIT-1', file: 'apps/api/src/ssl-store-workspace.test.ts', name: '/api/server/ssl (root store) passes the challenge passphrase to the agent only in the request body' }],
    checks: ['INVALID-COUNTRY-VALIDATION', 'ECDSA-P256-CSR-AND-KEY-CREATED', 'CSR-SANS-MATCH-REQUEST'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const base = `/api/accounts/${fixture.username}/ssl`
      const bad = await root.post(`${base}/csrs`, {
        keyType: 'ecdsa-prime256v1',
        names: [fixture.domain],
        subject: { country: 'ZZZ', state: 'CA', locality: 'SF', organization: 'xPanel' },
        label: `xq-bad-${tag}`,
      })
      refused('INVALID-COUNTRY-VALIDATION', bad, 'VALIDATION')
      const created = await root.post(`${base}/csrs`, {
        keyType: 'ecdsa-prime256v1',
        names: [fixture.domain],
        subject: { country: 'US', state: 'California', locality: 'San Francisco', organization: 'xPanel' },
        label: `xq-${tag}`,
      })
      removeSslChanged(root, base, created.data?.application?.changed, undo)
      const changedKeyId = created.data?.application?.changed?.find(item => item.kind === 'key')?.id
      const changedCsrId = created.data?.application?.changed?.find(item => item.kind === 'csr')?.id
      const key = created.data?.keys?.find(item => item.id === changedKeyId)
      const csr = created.data?.csrs?.find(item => item.id === changedCsrId)
      check('ECDSA-P256-CSR-AND-KEY-CREATED', created.status === 200 && key?.keyType === 'ec' && key?.curve === 'prime256v1' && typeof key?.publicKeySha256 === 'string' && csr?.publicKeySha256 === key?.publicKeySha256, { status: created.status, curve: key?.curve ?? null })
      check('CSR-SANS-MATCH-REQUEST', created.status === 200 && Array.isArray(csr?.names) && csr.names.length === 1 && csr.names[0] === fixture.domain, { names: csr?.names ?? null })
    },
  }),

  tool('install-ssl', {
    prefix: 'S16T06', as: 'root', needs: ['account'], probe: '/api/certificate-workspace',
    paths: /^\/api\/certificate-workspace(?:\/install)?$/,
    unit: [{ id: 'S16T06-UNIT-1', file: 'apps/agent/src/services/certificate-workspace.test.ts', name: 'manual certificate host adapter rejects mismatched keys, expired certificates, invalid clocks and oversized bodies' }],
    checks: ['WORKSPACE-DOMAINS-LISTED', 'INVALID-PEM-INSTALL-VALIDATION', 'MISSING-DOMAIN-NOT-FOUND'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get('/api/certificate-workspace')
      const rev = typeof view.data?.revision === 'number' ? view.data.revision : 0
      check('WORKSPACE-DOMAINS-LISTED', view.status === 200 && typeof view.data?.revision === 'number' && Array.isArray(view.data?.domains) && view.data.domains.some(item => item.name === fixture.domain), { status: view.status })
      refused('INVALID-PEM-INSTALL-VALIDATION', await root.post('/api/certificate-workspace/install', {
        username: fixture.username,
        domain: fixture.domain,
        expectedRevision: rev,
        fullchainPem: 'not-a-pem',
        privateKeyPem: 'not-a-key',
      }), 'VALIDATION')
      refused('MISSING-DOMAIN-NOT-FOUND', await root.post('/api/certificate-workspace/install', {
        username: fixture.username,
        domain: 'missing-domain.invalid',
        expectedRevision: rev,
        storeCertificateId: 'xqcert01',
      }), 'NOT_FOUND')
    },
  }),

  tool('auto-ssl', {
    prefix: 'S16T07', as: 'root', probe: '/api/server/sec/autossl',
    paths: /^\/api\/server\/(?:sec\/autossl|ssl\/autossl\/run)$/,
    unit: [{ id: 'S16T07-UNIT-1', file: 'apps/api/src/autossl.test.ts', name: 'AutoSSL candidates never replaces a valid uploaded certificate expiring in 10 days' }],
    checks: ['AUTOSSL-POLICY-AND-QUEUE-READ', 'MISSING-ACCOUNT-RUN-NOT-FOUND', 'UNSUPPORTED-FIELD-VALIDATION'],
    async run({ root, check, refused }) {
      const policy = await root.get('/api/server/sec/autossl')
      check('AUTOSSL-POLICY-AND-QUEUE-READ', policy.status === 200 && typeof policy.data?.revision === 'string' && typeof policy.data?.provider?.challenge === 'string' && Array.isArray(policy.data?.queue), { policy: policy.status })
      refused('MISSING-ACCOUNT-RUN-NOT-FOUND', await root.post('/api/server/ssl/autossl/run', { username: 'xqmissing99' }), 'NOT_FOUND')
      refused('UNSUPPORTED-FIELD-VALIDATION', await root.post('/api/server/ssl/autossl/run', { wildcard: true }), 'VALIDATION')
    },
  }),

  tool('ssl-hosts', {
    prefix: 'S16T08', as: 'root', probe: '/api/certificate-workspace',
    paths: /^\/api\/certificate-workspace(?:\/observations|\/[0-9a-f-]{36})?$/,
    unit: [{ id: 'S16T08-UNIT-1', file: 'apps/agent/src/services/certificate-workspace.test.ts', name: 'manual certificate host adapter writes immutable validated files with restrictive key permissions and verified bytes' }],
    checks: ['CERTIFICATES-AND-DOMAINS-READ', 'OBSERVATIONS-READ', 'DELETE-UNKNOWN-CERT-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/certificate-workspace')
      const obs = await root.get('/api/certificate-workspace/observations')
      const rev = typeof view.data?.revision === 'number' ? view.data.revision : 0
      check('CERTIFICATES-AND-DOMAINS-READ', view.status === 200 && Array.isArray(view.data?.certificates) && Array.isArray(view.data?.domains), { status: view.status })
      check('OBSERVATIONS-READ', obs.status === 200 && typeof obs.data === 'object' && obs.data !== null, { status: obs.status })
      refused('DELETE-UNKNOWN-CERT-NOT-FOUND', await root.delete(`/api/certificate-workspace/${ZERO_UUID}`, { expectedRevision: rev }), 'NOT_FOUND')
    },
  }),

  tool('ssl-storage', {
    prefix: 'S16T09', as: 'root', needs: ['account'], probe: '/api/server/ssl',
    paths: /^\/api\/(?:server\/ssl|accounts\/[a-z][a-z0-9]{0,15}\/ssl(?:\/(?:keys|csrs|certificates)(?:\/[a-z0-9][a-z0-9_-]{0,63})?)?)$/,
    unit: [{ id: 'S16T09-UNIT-1', file: 'apps/agent/src/ssl-store.test.ts', name: 'stored PEM parsing normalizes RSA and EC keys to PKCS #8 and reports type, size and public key hash' }],
    checks: ['SERVER-STORE-READ', 'SHARED-PUBLIC-KEY-ACROSS-TRIPLE', 'STALE-DELETE-CONFLICT'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const serverStore = await root.get('/api/server/ssl')
      check('SERVER-STORE-READ', serverStore.status === 200 && Array.isArray(serverStore.data?.keys) && Array.isArray(serverStore.data?.certificates), { status: serverStore.status })
      const base = `/api/accounts/${fixture.username}/ssl`
      const created = await root.post(`${base}/certificates`, {
        keyType: 'ecdsa-prime256v1',
        names: [fixture.domain],
        subject: { country: 'US', state: 'California', locality: 'San Francisco', organization: 'xPanel' },
        days: 30,
        csr: true,
        label: `xq-store-${tag}`,
      })
      removeSslChanged(root, base, created.data?.application?.changed, undo)
      const changed = Array.isArray(created.data?.application?.changed) ? created.data.application.changed : []
      const key = created.data?.keys?.find(item => item.id === changed.find(entry => entry.kind === 'key')?.id)
      const csr = created.data?.csrs?.find(item => item.id === changed.find(entry => entry.kind === 'csr')?.id)
      const cert = created.data?.certificates?.find(item => item.id === changed.find(entry => entry.kind === 'certificate')?.id)
      const sha = key?.publicKeySha256
      check('SHARED-PUBLIC-KEY-ACROSS-TRIPLE', created.status === 200 && typeof sha === 'string' && sha.length === 64 && csr?.publicKeySha256 === sha && cert?.publicKeySha256 === sha, { status: created.status, matched: csr?.publicKeySha256 === sha && cert?.publicKeySha256 === sha })
      const keyId = typeof key?.id === 'string' ? key.id : 'xqkey01'
      refused('STALE-DELETE-CONFLICT', await root.delete(`${base}/keys/${keyId}`, { modifiedAt: '1999-01-01T00:00:00.000Z' }), key ? 'CONFLICT' : 'NOT_FOUND')
    },
  }),

  tool('default-key-type', {
    prefix: 'S16T10', as: 'root', probe: '/api/server/tweak-settings',
    paths: /^\/api\/server\/(?:tweak-settings|ssl)$/,
    unit: [{ id: 'S16T10-UNIT-1', file: 'apps/agent/src/ssl-store.test.ts', name: 'stored PEM parsing refuses encrypted, weak, unsupported and multi-block keys with stable reasons' }],
    checks: ['TWEAK-DEFINITION-PRESENT', 'SSL-STORE-REPORTS-DEFAULT-KEY-TYPE', 'UNSUPPORTED-KEY-TYPE-VALIDATION'],
    async run({ root, check, refused }) {
      const tweaks = await root.get('/api/server/tweak-settings')
      const store = await root.get('/api/server/ssl')
      const rev = typeof tweaks.data?.revision === 'string' ? tweaks.data.revision : '0'.repeat(64)
      const def = Array.isArray(tweaks.data?.definitions) ? tweaks.data.definitions.find(item => item.key === 'ssl.defaultKeyType') : null
      check('TWEAK-DEFINITION-PRESENT', tweaks.status === 200 && typeof tweaks.data?.revision === 'string' && def !== null && def !== undefined, { status: tweaks.status, found: !!def })
      check('SSL-STORE-REPORTS-DEFAULT-KEY-TYPE', store.status === 200 && Array.isArray(store.data?.keyTypes) && store.data.keyTypes.includes('ecdsa-prime256v1'), { status: store.status, defaultKeyType: store.data?.defaultKeyType ?? null })
      refused('UNSUPPORTED-KEY-TYPE-VALIDATION', await root.put('/api/server/tweak-settings', { values: { 'ssl.defaultKeyType': 'rsa-512' }, expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('backup-restoration', {
    prefix: 'S16T11', as: 'root', needs: ['account'], probe: '/api/backups/workspace',
    page: { route: '/whm/backups/restore', read: '/api/backups/workspace', shows: () => ['Server backups'] },
    paths: /^\/api\/backups\/(?:workspace(?:\/runs)?|components\/[a-z0-9]{1,16}\/inventory)$/,
    unit: [{ id: 'S16T11-UNIT-1', file: 'apps/agent/src/account-backup-workspace.test.ts', name: 'account archive inspection and ownership inspects real gzip bytes and reports exact file digests' }],
    checks: ['WORKSPACE-AND-RUNS-READ', 'EMPTY-INVENTORY-BODY-VALIDATION', 'MISSING-ACCOUNT-INVENTORY-NOT-FOUND'],
    async run({ root, fixture, check, refused }) {
      const ws = await root.get('/api/backups/workspace')
      const runs = await root.get('/api/backups/workspace/runs')
      check('WORKSPACE-AND-RUNS-READ', ws.status === 200 && runs.status === 200 && Array.isArray(runs.data?.runs), { workspace: ws.status, runs: runs.status })
      refused('EMPTY-INVENTORY-BODY-VALIDATION', await root.post(`/api/backups/components/${fixture.username}/inventory`, {}), 'VALIDATION')
      refused('MISSING-ACCOUNT-INVENTORY-NOT-FOUND', await root.post('/api/backups/components/xqmissing99/inventory', { file: 'xpanel-backup-xqmissing99-20260101T000000Z.tar.gz' }), 'NOT_FOUND')
    },
  }),

  tool('file-restore', {
    prefix: 'S16T12', as: 'root', needs: ['account'], probe: '/api/backups/files',
    paths: /^\/api\/backups\/files(?:\/[a-z][a-z0-9]{0,15}(?:\/preview)?)?$/,
    unit: [{ id: 'S16T12-UNIT-1', file: 'apps/agent/src/backup-file-restore-request.test.ts', name: 'file restore request grammar derives the restored folder and creation time from the archive name only' }],
    checks: ['ACCOUNTS-AND-ARCHIVES-READ', 'TRAVERSAL-PATH-REFUSED', 'FOREIGN-ARCHIVE-NAME-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const accounts = await root.get('/api/backups/files')
      const archives = await root.get(`/api/backups/files/${fixture.username}`)
      check('ACCOUNTS-AND-ARCHIVES-READ', accounts.status === 200 && Array.isArray(accounts.data?.accounts) && archives.status === 200 && Array.isArray(archives.data?.archives), { accounts: accounts.status, archives: archives.status })
      const sampleFile = `xpanel-backup-${fixture.username}-20260101T000000Z.tar.gz`
      refused('TRAVERSAL-PATH-REFUSED', await root.post(`/api/backups/files/${fixture.username}/preview`, { file: sampleFile, paths: ['../etc/passwd'], destination: 'in-place' }), 'VALIDATION')
      refused('FOREIGN-ARCHIVE-NAME-REFUSED', await root.post(`/api/backups/files/${fixture.username}/preview`, { file: 'xpanel-backup-otheracct-20260101T000000Z.tar.gz', paths: ['public_html/index.php'], destination: 'in-place' }), 'VALIDATION')
    },
  }),

  tool('registered-apps', {
    prefix: 'S16T13', as: 'root', probe: '/api/server/registered-apps',
    paths: /^\/api\/server\/registered-apps(?:\?x=1)?$/,
    unit: [{ id: 'S16T13-UNIT-1', file: 'apps/api/src/registered-apps.test.ts', name: 'registered applications lists the built-in surfaces and every registration file, keeps invalid files with their reason, and forgets removed files' }],
    checks: ['BUILTIN-SURFACES-REGISTERED', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/registered-apps')
      const apps = Array.isArray(view.data?.apps) ? view.data.apps : []
      const names = new Set(apps.map(item => item.name))
      check('BUILTIN-SURFACES-REGISTERED', view.status === 200 && ['xwhm', 'xpanel', 'xmail'].every(name => names.has(name)), { status: view.status, count: apps.length })
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/registered-apps?x=1'), 'VALIDATION')
    },
  }),

  tool('plugin-generator', {
    prefix: 'S16T14', as: 'root', probe: '/api/server/plugins',
    paths: /^\/api\/server\/(?:plugins(?:\/[a-z0-9_-]{1,64})?|plugin-generator)$/,
    unit: [{ id: 'S16T14-UNIT-1', file: 'apps/api/src/plugin-packages.test.ts', name: 'plugin packages generates a download, installs it, lists it without icons, downloads and deletes it' }],
    checks: ['ICON-64X64-VALIDATION', 'INSTALL-AND-LIST-PACKAGE', 'DUPLICATE-WITHOUT-OVERWRITE-CONFLICT'],
    async run({ root, tag, check, refused, undo }) {
      const name = `xq_${tag}`, itemId = `xq_item_${tag}`
      const makeItem = size => ({
        id: itemId,
        name: `XQ Link ${tag}`,
        group: 'Tools',
        priority: 50,
        uri: 'https://example.org/docs',
        feature: null,
        icon: { type: 'image/svg+xml', data: svgBase64(size) },
      })
      refused('ICON-64X64-VALIDATION', await root.post('/api/server/plugin-generator', { name, items: [makeItem(64)], overwrite: false }), 'VALIDATION')
      const pkg = { format: 'xpanel-plugin-package-v1', name, items: [makeItem(48)] }
      const installed = await root.post('/api/server/plugins', { package: pkg, overwrite: false })
      if (installed.status === 200) {
        undo(`plugin ${name}`, async () => {
          const current = await root.get('/api/server/plugins')
          if (current.status !== 200) return false
          if (!current.data?.plugins?.some(row => row.name === name)) return true
          const gone = await root.delete(`/api/server/plugins/${name}`)
          return gone.status === 200 && !gone.data?.plugins?.some(row => row.name === name)
        })
      }
      check('INSTALL-AND-LIST-PACKAGE', installed.status === 200 && Array.isArray(installed.data?.plugins) && installed.data.plugins.some(row => row.name === name && row.state === 'installed'), { status: installed.status })
      refused('DUPLICATE-WITHOUT-OVERWRITE-CONFLICT', await root.post('/api/server/plugins', { package: pkg, overwrite: false }), 'CONFLICT')
    },
  }),

  tool('hooks-manager', {
    prefix: 'S16T15', as: 'root', probe: '/api/server/hooks',
    paths: /^\/api\/server\/hooks(?:\/[0-9a-f-]{36})?$/,
    unit: [{ id: 'S16T15-UNIT-1', file: 'apps/agent/src/lifecycle-hooks.test.ts', name: 'lifecycle hooks runs enabled hooks of the event in order, skips disabled ones, refuses a changed file and stops at a failing blocking hook' }],
    checks: ['HOOK-INVENTORY-READ', 'UNREVIEWED-EXECUTABLE-REFUSED', 'UNKNOWN-HOOK-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/hooks')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      check('HOOK-INVENTORY-READ', view.status === 200 && typeof view.data?.revision === 'string' && Array.isArray(view.data?.hooks), { status: view.status })
      refused('UNREVIEWED-EXECUTABLE-REFUSED', await root.post('/api/server/hooks', { point: 'account.create', stage: 'pre', executable: '../outside', expectedRevision: rev }), 'VALIDATION')
      refused('UNKNOWN-HOOK-NOT-FOUND', await root.patch(`/api/server/hooks/${ZERO_UUID}`, { enabled: false, expectedRevision: rev }), 'NOT_FOUND')
    },
  }),

  tool('webmail-home', {
    prefix: 'S16T16', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/(?:auth\/me|webmail\/(?:inbox|disk-usage|preferences))$/,
    unit: [{ id: 'S16T16-UNIT-1', file: 'apps/api/src/entry-points-security.test.ts', name: 'interactive entry point isolation on real HTTP and WebSocket listeners serves the mailbox own filters on the xMail listener through the webmail base only' }],
    checks: ['MAILBOX-SESSION-BOUND', 'QUOTA-AND-FOLDERS-OBSERVED', 'PREFERENCES-SURFACE-READ'],
    async run({ mailbox, fixture, check }) {
      const me = await mailbox.get('/api/auth/me')
      const usage = await mailbox.get(`${WEBMAIL}/disk-usage`)
      const prefs = await mailbox.get(`${WEBMAIL}/preferences`)
      check('MAILBOX-SESSION-BOUND', me.status === 200 && typeof me.data?.principal?.id === 'string' && usage.data?.mailbox === fixture.mailbox.address, { me: me.status, usage: usage.status })
      check('QUOTA-AND-FOLDERS-OBSERVED', usage.status === 200 && typeof usage.data?.quota?.state === 'string' && Array.isArray(usage.data?.folders), { quotaState: usage.data?.quota?.state ?? null, folders: Array.isArray(usage.data?.folders) ? usage.data.folders.length : null })
      check('PREFERENCES-SURFACE-READ', prefs.status === 200 && prefs.data?.context?.mailbox === fixture.mailbox.address, { status: prefs.status })
    },
  }),

  tool('webmail-message-read', {
    prefix: 'S16T17', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`, requests: 40, deadlineMs: 180000,
    paths: /^\/api\/webmail\/(?:send|inbox(?:\/[1-9]\d*)?(?:\?folder=INBOX)?)$/,
    unit: [{ id: 'S16T17-UNIT-1', file: 'apps/api/src/mail/folder-workspace.test.ts', name: 'mail folder request and selected-result boundary returns a complete selected-folder list with a real move capability and no arbitrary transport fields' }],
    checks: ['DELIVERED-MESSAGE-READ-SAFE-BODY', 'READ-MARKS-MESSAGE-SEEN', 'MISSING-UID-NOT-FOUND'],
    async run({ mailbox, fixture, tag, check, refused, until }) {
      const subject = `xq-${tag}-read`, marker = `safe-body-${tag}`
      await sendTo(mailbox, fixture.mailbox.address, subject, `Plain ${marker}`, {
        html: `<p>${marker}</p><script>alert(1)</script><img src="https://example.invalid/pixel.png" onerror="alert(2)">`,
      })
      const landed = await delivered(until, mailbox, 'INBOX', subject)
      const summary = landed.settled ? only(landed.last, subject)[0] : undefined
      if (!summary) {
        failAll(check, ['DELIVERED-MESSAGE-READ-SAFE-BODY', 'READ-MARKS-MESSAGE-SEEN'], { delivered: false })
      } else {
        const opened = await mailbox.get(`${WEBMAIL}/inbox/${summary.uid}?folder=INBOX`)
        const body = opened.data?.message?.body ?? ''
        check('DELIVERED-MESSAGE-READ-SAFE-BODY', opened.status === 200 && body.includes(marker) && !/<script|onerror/i.test(body), { status: opened.status })
        check('READ-MARKS-MESSAGE-SEEN', opened.status === 200 && opened.data?.message?.unread === false, { status: opened.status, unread: opened.data?.message?.unread ?? null })
      }
      refused('MISSING-UID-NOT-FOUND', await mailbox.get(`${WEBMAIL}/inbox/999999999?folder=INBOX`), 'NOT_FOUND')
    },
  }),

  tool('webmail-reply-forward', {
    prefix: 'S16T18', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`, requests: 40,
    paths: /^\/api\/webmail\/(?:drafts|send|inbox\?folder=(?:Drafts|Sent))$/,
    unit: [{ id: 'S16T18-UNIT-1', file: 'apps/api/src/mail/draft-workspace.test.ts', name: 'native draft APPEND and exact observed readback boundary builds real MIME, appends once with the draft flag and returns only observed provider identity' }],
    checks: ['QUOTED-REPLY-DRAFT-SAVED', 'REPLY-SUBJECT-NOT-DOUBLED-ON-SEND', 'INVALID-DRAFT-BODY-VALIDATION'],
    async run({ mailbox, fixture, tag, check, refused, until }) {
      const baseSubject = `xq-${tag}-thread`, replySubject = `Re: ${baseSubject}`, to = fixture.mailbox.address
      const draft = await mailbox.post(`${WEBMAIL}/drafts`, {
        to,
        subject: replySubject,
        text: `On today, sender wrote:\n> Original line ${tag}\n\nReply body ${tag}`,
      })
      const drafts = await mailbox.get(folderQuery('Drafts'))
      check('QUOTED-REPLY-DRAFT-SAVED', (draft.status === 200 || draft.status === 201) && hasSubject(drafts, replySubject), { draft: draft.status, listed: drafts.status })
      const sent = await sendTo(mailbox, to, replySubject, `Reply body ${tag}`)
      const inSent = await until(() => mailbox.get(folderQuery('Sent')), response => hasSubject(response, replySubject), { attempts: 10, delayMs: 2000 })
      const sentItem = inSent.settled ? only(inSent.last, replySubject)[0] : undefined
      check('REPLY-SUBJECT-NOT-DOUBLED-ON-SEND', sent.status === 201 && sentItem?.subject === replySubject && !sentItem.subject.startsWith('Re: Re:'), { send: sent.status, settled: inSent.settled })
      refused('INVALID-DRAFT-BODY-VALIDATION', await mailbox.post(`${WEBMAIL}/drafts`, { to: '', subject: '', text: '' }), 'VALIDATION')
    },
  }),

  tool('webmail-search-index', {
    prefix: 'S16T19', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`, requests: 35,
    paths: /^\/api\/webmail\/search-index(?:\?address=other%40example\.org)?$/,
    unit: [{ id: 'S16T19-UNIT-1', file: 'apps/api/src/mail/mailbox-engine-routes.test.ts', name: 'mailbox search index reads and rebuilds only the sealed mailbox' }],
    checks: ['INDEX-STATE-OBSERVED', 'FOREIGN-SELECTOR-REFUSED', 'REBUILD-OR-UNCONFIGURED-CONTRACT'],
    async run({ mailbox, fixture, check, refused, until }) {
      const view = await mailbox.get(`${WEBMAIL}/search-index`)
      const fts = view.data?.fts
      check('INDEX-STATE-OBSERVED', view.status === 200 && view.data?.mailbox === fixture.mailbox.address && ['configured', 'not-configured', 'unreadable'].includes(fts), { status: view.status, fts: fts ?? null })
      refused('FOREIGN-SELECTOR-REFUSED', await mailbox.get(`${WEBMAIL}/search-index?address=other%40example.org`), 'VALIDATION')
      if (fts === 'configured') {
        const queued = await mailbox.post(`${WEBMAIL}/search-index`, {})
        const accepted = queued.status === 202 && typeof queued.data?.job?.id === 'string'
        if (accepted) {
          await until(() => mailbox.get(`${WEBMAIL}/search-index`), res => res.status === 200 && !['queued', 'running'].includes(res.data?.job?.status), { attempts: 15, delayMs: 1000 })
        }
        check('REBUILD-OR-UNCONFIGURED-CONTRACT', accepted, { status: queued.status, jobStatus: queued.data?.job?.status ?? null })
      } else if (fts === 'not-configured' || fts === 'unreadable') {
        refused('REBUILD-OR-UNCONFIGURED-CONTRACT', await mailbox.post(`${WEBMAIL}/search-index`, {}), 'PRECONDITION_FAILED')
      } else {
        check('REBUILD-OR-UNCONFIGURED-CONTRACT', false, statusOf(view))
      }
    },
  }),

  tool('webmail-spam-marking', {
    prefix: 'S16T20', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`, requests: 50, deadlineMs: 180000,
    paths: /^\/api\/webmail\/(?:send|inbox(?:\/[1-9]\d*\/report|\?folder=(?:INBOX|Junk))?)$/,
    unit: [{ id: 'S16T20-UNIT-1', file: 'apps/api/src/mail/mailbox-engine-routes.test.ts', name: 'mailbox spam report moves the message and records one training sample for the destination uid' }],
    checks: ['MARK-JUNK-MOVES-TO-JUNK', 'MARK-NOT-JUNK-RETURNS-TO-INBOX', 'INVALID-FOLDER-PAIR-REFUSED'],
    async run({ mailbox, fixture, tag, check, refused, until }) {
      const subject = `xq-${tag}-spammark`
      await sendTo(mailbox, fixture.mailbox.address, subject, `Spam marking sample ${tag}`)
      const landed = await delivered(until, mailbox, 'INBOX', subject)
      const message = landed.settled ? only(landed.last, subject)[0] : undefined
      if (!message) {
        failAll(check, ['MARK-JUNK-MOVES-TO-JUNK', 'MARK-NOT-JUNK-RETURNS-TO-INBOX'], { delivered: false })
      } else {
        const markedJunk = await mailbox.post(`${WEBMAIL}/inbox/${message.uid}/report`, { from: 'INBOX', folder: 'Junk', uidValidity: message.uidValidity })
        const junkView = await mailbox.get(folderQuery('Junk'))
        const junkMsg = only(junkView, subject)[0]
        check('MARK-JUNK-MOVES-TO-JUNK', markedJunk.status === 200 && !!junkMsg && typeof markedJunk.data?.training === 'string', { status: markedJunk.status, training: markedJunk.data?.training ?? null })
        if (!junkMsg) {
          check('MARK-NOT-JUNK-RETURNS-TO-INBOX', false, { foundInJunk: false })
        } else {
          const markedHam = await mailbox.post(`${WEBMAIL}/inbox/${junkMsg.uid}/report`, { from: 'Junk', folder: 'INBOX', uidValidity: junkMsg.uidValidity })
          const inboxAfter = await mailbox.get(folderQuery('INBOX'))
          check('MARK-NOT-JUNK-RETURNS-TO-INBOX', markedHam.status === 200 && hasSubject(inboxAfter, subject), { status: markedHam.status, training: markedHam.data?.training ?? null })
        }
      }
      refused('INVALID-FOLDER-PAIR-REFUSED', await mailbox.post(`${WEBMAIL}/inbox/1/report`, { from: 'INBOX', folder: 'Trash', uidValidity: 1 }), 'VALIDATION')
    },
  }),

  tool('webmail-address-book', {
    prefix: 'S16T21', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`, requests: 35,
    page: { route: '/mail/contacts', read: '/api/webmail/contacts', shows: () => ['Contacts'] },
    paths: /^\/api\/webmail\/contacts(?:\/(?:import|export|[0-9a-f-]{36}))?$/,
    unit: [{ id: 'S16T21-UNIT-1', file: 'apps/api/src/mail/contact-workspace.test.ts', name: 'mailbox contact group and capacity contracts updates group membership and exported vCard categories from the same saved data' }],
    checks: ['IMPORT-THREE-VCARDS-LISTED', 'EXPORT-CONTAINS-IMPORTED-VCARDS', 'EMPTY-CONTACT-NAME-REFUSED'],
    async run({ mailbox, tag, check, refused, undo }) {
      const emails = [1, 2, 3].map(n => `xq-${tag}-c${n}@example.org`)
      const vcard = [1, 2, 3].map(n => [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:XQ Contact ${n} ${tag}`,
        `EMAIL;TYPE=INTERNET:xq-${tag}-c${n}@example.org`,
        'END:VCARD',
      ].join('\r\n')).join('\r\n')
      const imported = await mailbox.post(`${WEBMAIL}/contacts/import`, { vcard })
      const createdIds = Array.isArray(imported.data?.contacts) ? imported.data.contacts.map(item => item.id).filter(id => typeof id === 'string') : []
      for (const id of createdIds) {
        undo(`contact ${id}`, async () => {
          const view = await mailbox.get(`${WEBMAIL}/contacts`)
          if (view.status !== 200) return false
          const row = view.data?.contacts?.find(item => item.id === id)
          if (!row) return true
          const gone = await mailbox.delete(`${WEBMAIL}/contacts/${id}`, { expectedRevision: row.revision })
          return gone.status === 200
        })
      }
      const listed = await mailbox.get(`${WEBMAIL}/contacts`)
      const exported = await mailbox.get(`${WEBMAIL}/contacts/export`)
      const present = Array.isArray(listed.data?.contacts) ? emails.every(email => listed.data.contacts.some(item => item.email === email)) : false
      check('IMPORT-THREE-VCARDS-LISTED', (imported.status === 200 || imported.status === 201) && imported.data?.importedCount === 3 && present, { import: imported.status, listed: listed.status, count: imported.data?.importedCount ?? null })
      const text = typeof exported.text === 'string' ? exported.text : JSON.stringify(exported.data ?? '')
      check('EXPORT-CONTAINS-IMPORTED-VCARDS', exported.status === 200 && emails.every(email => text.includes(email)), { export: exported.status })
      refused('EMPTY-CONTACT-NAME-REFUSED', await mailbox.post(`${WEBMAIL}/contacts`, { fullName: '', email: `bad-${tag}@example.org`, phone: '', organization: '', title: '' }), 'VALIDATION')
    },
  }),

  tool('webmail-dav-config', {
    prefix: 'S16T22', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/dav-config(?:\/apple\.mobileconfig|\?x=1)?$/,
    unit: [{ id: 'S16T22-UNIT-1', file: 'apps/api/src/dav-workspace.test.ts', name: 'calendars and contacts connection gives each mailbox its own domain when served, and the account login the first served one' }],
    checks: ['DAV-CONNECTION-READ', 'PROFILE-OMITS-CREDENTIAL', 'SELECTOR-REFUSED'],
    async run({ mailbox, fixture, check, refused }) {
      const view = await mailbox.get(`${WEBMAIL}/dav-config`)
      const profile = await mailbox.get(`${WEBMAIL}/dav-config/apple.mobileconfig`)
      check('DAV-CONNECTION-READ', view.status === 200 && view.data?.mailbox === fixture.mailbox.address && view.data?.port === 2080 && view.data?.authentication === 'basic-over-tls', { status: view.status, port: view.data?.port ?? null })
      const body = typeof profile.text === 'string' ? profile.text : ''
      check('PROFILE-OMITS-CREDENTIAL', (profile.status === 200 || (profile.status === 404 && view.status === 200 && view.data?.server === null && profile.data?.code === 'NOT_FOUND')) && !body.includes(fixture.mailbox.password) && !/Password/i.test(body), { status: profile.status, server: view.data?.server ?? null })
      refused('SELECTOR-REFUSED', await mailbox.get(`${WEBMAIL}/dav-config?x=1`), 'VALIDATION')
    },
  }),

  tool('webmail-calendar', {
    prefix: 'S16T23', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`, requests: 35,
    paths: /^\/api\/webmail\/calendars(?:\/[0-9a-f-]{36}(?:\/(?:events|ics))?)?$/,
    unit: [{ id: 'S16T23-UNIT-1', file: 'apps/api/src/mail/calendar-ics.test.ts', name: 'bounded iCalendar interchange round-trips supported text, UTC timestamps and original external UIDs' }],
    checks: ['CREATE-CALENDAR-AND-EVENT', 'EXPORT-ICS-CONTAINS-EVENT', 'INVALID-EVENT-RANGE-REFUSED'],
    async run({ mailbox, tag, check, refused, undo }) {
      const initial = await mailbox.get(`${WEBMAIL}/calendars`)
      if (initial.status !== 200 || typeof initial.data?.revision !== 'string') {
        return failAll(check, ['CREATE-CALENDAR-AND-EVENT', 'EXPORT-ICS-CONTAINS-EVENT', 'INVALID-EVENT-RANGE-REFUSED'], statusOf(initial))
      }
      const created = await mailbox.post(`${WEBMAIL}/calendars`, {
        name: `XQ Cal ${tag}`,
        color: 'oklch(0.65 0.18 250)',
        timezone: 'UTC',
        expectedRevision: initial.data.revision,
      })
      const calId = created.data?.calendar?.id
      if (typeof calId !== 'string' || !/^[0-9a-f-]{36}$/.test(calId)) {
        return failAll(check, ['CREATE-CALENDAR-AND-EVENT', 'EXPORT-ICS-CONTAINS-EVENT', 'INVALID-EVENT-RANGE-REFUSED'], statusOf(created))
      }
      undo(`calendar ${calId}`, async () => {
        const current = await mailbox.get(`${WEBMAIL}/calendars/${calId}`)
        if (current.status === 404) return true
        if (current.status !== 200 || typeof current.data?.calendar?.revision !== 'string') return false
        const gone = await mailbox.delete(`${WEBMAIL}/calendars/${calId}`, { expectedRevision: current.data.calendar.revision })
        return gone.status === 200
      })
      const calRev = created.data.calendar.revision
      const eventSummary = `XQ Sync ${tag}`
      const event = await mailbox.post(`${WEBMAIL}/calendars/${calId}/events`, {
        summary: eventSummary,
        description: 'Calendar check',
        location: 'Room 1',
        dtstart: '20261115T100000Z',
        dtend: '20261115T110000Z',
        timezone: 'UTC',
        expectedRevision: calRev,
      })
      const ics = await mailbox.get(`${WEBMAIL}/calendars/${calId}/ics`)
      check('CREATE-CALENDAR-AND-EVENT', (created.status === 200 || created.status === 201) && (event.status === 200 || event.status === 201), { calendar: created.status, event: event.status })
      check('EXPORT-ICS-CONTAINS-EVENT', ics.status === 200 && typeof ics.data?.ics === 'string' && ics.data.ics.includes(eventSummary), { status: ics.status, eventsCount: ics.data?.eventsCount ?? null })
      const nextRev = typeof ics.data?.revision === 'string' ? ics.data.revision : calRev
      refused('INVALID-EVENT-RANGE-REFUSED', await mailbox.post(`${WEBMAIL}/calendars/${calId}/events`, {
        summary: 'Reversed',
        description: '',
        location: '',
        dtstart: '20261115T120000Z',
        dtend: '20261115T110000Z',
        timezone: 'UTC',
        expectedRevision: nextRev,
      }), 'VALIDATION')
    },
  }),

  tool('webmail-plus-addressing', {
    prefix: 'S16T24', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/(?:preferences|mailbox-settings)$/,
    unit: [{ id: 'S16T24-UNIT-1', file: 'apps/api/src/mail/mailbox-preferences.test.ts', name: 'mailbox preferences view maps a rendered recipient_delimiter to an explained supported state' }],
    checks: ['PLUS-DELIMITER-STATE-OBSERVED', 'SAVE-CREATE-FOLDER-MODE', 'INVALID-MODE-REFUSED'],
    async run({ mailbox, check, refused, undo }) {
      const prefs = await mailbox.get(`${WEBMAIL}/preferences`)
      const before = await mailbox.get(`${WEBMAIL}/mailbox-settings`)
      check('PLUS-DELIMITER-STATE-OBSERVED', prefs.status === 200 && typeof prefs.data?.plusAddressing === 'object' && before.status === 200, { prefs: prefs.status, settings: before.status })
      const orig = before.data?.settings ?? { addresses: [], loginAlerts: false, alertKnownRanges: false, plusFolders: 'off' }
      undo('mailbox plus-addressing settings', async () => {
        const restored = await mailbox.put(`${WEBMAIL}/mailbox-settings`, orig)
        return restored.status === 200 && restored.data?.settings?.plusFolders === orig.plusFolders
      })
      const saved = await mailbox.put(`${WEBMAIL}/mailbox-settings`, { ...orig, plusFolders: 'create' })
      check('SAVE-CREATE-FOLDER-MODE', saved.status === 200 && saved.data?.settings?.plusFolders === 'create', { status: saved.status })
      refused('INVALID-MODE-REFUSED', await mailbox.put(`${WEBMAIL}/mailbox-settings`, { ...orig, plusFolders: 'invalid-mode' }), 'VALIDATION')
    },
  }),

  tool('webmail-password', {
    prefix: 'S16T25', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/security(?:\/password)?$/,
    unit: [{ id: 'S16T25-UNIT-1', file: 'apps/api/src/mail/mailbox-security.test.ts', name: 'mailbox security (D5: the second factor guards xMail sign-in only) changes the mailbox password after the mail server accepts the current one, applies it and ends every mailbox session' }],
    checks: ['SECURITY-VIEW-BOUND-TO-MAILBOX', 'WEAK-CREDENTIAL-REFUSED', 'UNCHANGED-CREDENTIAL-REFUSED'],
    async run({ mailbox, fixture, check, refused }) {
      const view = await mailbox.get(`${WEBMAIL}/security`)
      check('SECURITY-VIEW-BOUND-TO-MAILBOX', view.status === 200 && view.data?.mailbox === fixture.mailbox.address, { status: view.status })
      refused('WEAK-CREDENTIAL-REFUSED', await mailbox.post(`${WEBMAIL}/security/password`, { currentPassword: fixture.mailbox.password, newPassword: 'short' }), 'VALIDATION')
      refused('UNCHANGED-CREDENTIAL-REFUSED', await mailbox.post(`${WEBMAIL}/security/password`, { currentPassword: fixture.mailbox.password, newPassword: fixture.mailbox.password }), 'VALIDATION')
    },
  }),

  tool('webmail-contact-info', {
    prefix: 'S16T26', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/mailbox-settings$/,
    unit: [{ id: 'S16T26-UNIT-1', file: 'apps/api/src/mail/mailbox-settings.test.ts', name: 'mailbox settings alerts once for a new IP, never for a known one, and skips known ranges unless asked' }],
    checks: ['SAVE-NOTIFICATION-ADDRESS', 'OVER-FIVE-ADDRESSES-REFUSED', 'INVALID-ADDRESS-REFUSED'],
    async run({ mailbox, tag, check, refused, undo }) {
      const before = await mailbox.get(`${WEBMAIL}/mailbox-settings`)
      if (before.status !== 200 || !before.data?.settings) {
        return failAll(check, ['SAVE-NOTIFICATION-ADDRESS', 'OVER-FIVE-ADDRESSES-REFUSED', 'INVALID-ADDRESS-REFUSED'], statusOf(before))
      }
      const orig = before.data.settings
      undo('mailbox contact settings', async () => {
        const restored = await mailbox.put(`${WEBMAIL}/mailbox-settings`, orig)
        return restored.status === 200 && JSON.stringify(restored.data?.settings?.addresses) === JSON.stringify(orig.addresses)
      })
      const notify = `notify-${tag}@example.org`
      const saved = await mailbox.put(`${WEBMAIL}/mailbox-settings`, { ...orig, addresses: [notify], loginAlerts: true })
      check('SAVE-NOTIFICATION-ADDRESS', saved.status === 200 && Array.isArray(saved.data?.settings?.addresses) && saved.data.settings.addresses.includes(notify), { status: saved.status })
      const six = [1, 2, 3, 4, 5, 6].map(n => `n${n}-${tag}@example.org`)
      refused('OVER-FIVE-ADDRESSES-REFUSED', await mailbox.put(`${WEBMAIL}/mailbox-settings`, { ...orig, addresses: six }), 'VALIDATION')
      refused('INVALID-ADDRESS-REFUSED', await mailbox.put(`${WEBMAIL}/mailbox-settings`, { ...orig, addresses: ['not-an-email'] }), 'VALIDATION')
    },
  }),

  tool('webmail-spam-box', {
    prefix: 'S16T27', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/spam-preferences$/,
    unit: [{ id: 'S16T27-UNIT-1', file: 'apps/api/src/mail/mailbox-spam.test.ts', name: 'sealed mailbox spam preferences saves only the current mailbox record, with immutable binding and exact readback' }],
    checks: ['SPAM-BOX-ENABLE-SAVED', 'SPAM-BOX-DISABLE-SAVED', 'STALE-REVISION-CONFLICT'],
    async run({ mailbox, check, refused, undo }) {
      const before = await mailbox.get(`${WEBMAIL}/spam-preferences`)
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        return failAll(check, ['SPAM-BOX-ENABLE-SAVED', 'SPAM-BOX-DISABLE-SAVED', 'STALE-REVISION-CONFLICT'], statusOf(before))
      }
      const orig = spamFields(before.data)
      undo('mailbox spam-box preferences', async () => {
        const now = await mailbox.get(`${WEBMAIL}/spam-preferences`)
        if (now.status !== 200) return false
        if (JSON.stringify(now.data.effective) === JSON.stringify(before.data.effective)) return true
        const saved = await mailbox.put(`${WEBMAIL}/spam-preferences`, { ...orig, expectedRevision: now.data.revision })
        return saved.status === 200
      })
      const enabled = await mailbox.put(`${WEBMAIL}/spam-preferences`, {
        inherit: false,
        enabled: true,
        addHeaderScore: orig.addHeaderScore,
        spamBoxEnabled: true,
        autoDeleteScore: orig.autoDeleteScore,
        allowlist: [],
        blocklist: [],
        expectedRevision: before.data.revision,
      })
      check('SPAM-BOX-ENABLE-SAVED', enabled.status === 200 && enabled.data?.effective?.spamBoxEnabled === true, { status: enabled.status })
      const disabled = await mailbox.put(`${WEBMAIL}/spam-preferences`, {
        inherit: false,
        enabled: true,
        addHeaderScore: orig.addHeaderScore,
        spamBoxEnabled: false,
        autoDeleteScore: orig.autoDeleteScore,
        allowlist: [],
        blocklist: [],
        expectedRevision: enabled.data?.revision ?? before.data.revision,
      })
      check('SPAM-BOX-DISABLE-SAVED', disabled.status === 200 && disabled.data?.effective?.spamBoxEnabled === false, { status: disabled.status })
      refused('STALE-REVISION-CONFLICT', await mailbox.put(`${WEBMAIL}/spam-preferences`, {
        ...orig,
        expectedRevision: '0'.repeat(64),
      }), 'CONFLICT')
    },
  }),

  tool('webmail-boxtrapper', {
    prefix: 'S16T28', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/boxtrapper(?:\/queue)?$/,
    unit: [{ id: 'S16T28-UNIT-1', file: 'apps/agent/src/boxtrapper-program.test.ts', name: 'BoxTrapper delivery decisions queues an unknown sender, sends one challenge a day, and releases on the token' }],
    checks: ['BOXTRAPPER-VIEW-READ', 'OWN-FORWARD-LOOP-REFUSED', 'INVALID-QUEUE-DAY-REFUSED'],
    async run({ mailbox, fixture, check, refused }) {
      const view = await mailbox.get(`${WEBMAIL}/boxtrapper`)
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      const config = view.data?.config ?? {}
      check('BOXTRAPPER-VIEW-READ', view.status === 200 && view.data?.context?.mailbox === fixture.mailbox.address && typeof view.data?.revision === 'string', { status: view.status, hostState: view.data?.host?.state ?? null })
      refused('OWN-FORWARD-LOOP-REFUSED', await mailbox.put(`${WEBMAIL}/boxtrapper`, {
        config: { ...config, forward: [fixture.mailbox.address] },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('INVALID-QUEUE-DAY-REFUSED', await mailbox.post(`${WEBMAIL}/boxtrapper/queue`, { op: 'queue', args: { day: 'not-a-day' } }), 'VALIDATION')
    },
  }),

  tool('webmail-quota', {
    prefix: 'S16T29', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/disk-usage(?:\?mailbox=other)?$/,
    unit: [{ id: 'S16T29-UNIT-1', file: 'apps/api/src/mail/mailbox-usage.test.ts', name: '/api/webmail/disk-usage reads RFC 8438 STATUS SIZE and RFC 9208 quota for the sealed mailbox only' }],
    checks: ['IMAP-QUOTA-OBSERVED', 'MAILBOX-SELECTOR-REFUSED'],
    async run({ mailbox, fixture, check, refused }) {
      const view = await mailbox.get(`${WEBMAIL}/disk-usage`)
      const quota = view.data?.quota
      check('IMAP-QUOTA-OBSERVED', view.status === 200 && view.data?.mailbox === fixture.mailbox.address && typeof quota?.state === 'string' && (quota?.state !== 'read' || (typeof quota.usedBytes === 'number' && quota.limitBytes === 256 * 1024 * 1024)), { status: view.status, quotaState: quota?.state ?? null, limitBytes: quota?.limitBytes ?? null })
      refused('MAILBOX-SELECTOR-REFUSED', await mailbox.get(`${WEBMAIL}/disk-usage?mailbox=other`), 'VALIDATION')
    },
  }),

  tool('webmail-disk-cleanup', {
    prefix: 'S16T30', as: 'mailbox', needs: ['account', 'mailbox'], probe: `${WEBMAIL}/inbox`,
    paths: /^\/api\/webmail\/disk-usage(?:\/preview\?folder=INBOX(?:&largerThanMb=30)?)?$/,
    unit: [{ id: 'S16T30-UNIT-1', file: 'apps/api/src/mail/mailbox-usage.test.ts', name: 'cleanup criteria grammar maps age, size and read state to RFC 3501 search keys' }],
    checks: ['EMPTY-CRITERIA-REFUSED', 'LARGER-THAN-30MB-PREVIEW-READ'],
    async run({ mailbox, check, refused }) {
      const usage = await mailbox.get(`${WEBMAIL}/disk-usage`)
      refused('EMPTY-CRITERIA-REFUSED', await mailbox.get(`${WEBMAIL}/disk-usage/preview?folder=INBOX`), 'VALIDATION')
      const preview = await mailbox.get(`${WEBMAIL}/disk-usage/preview?folder=INBOX&largerThanMb=30`)
      const uids = preview.data?.batch?.uids
      check('LARGER-THAN-30MB-PREVIEW-READ', usage.status === 200 && preview.status === 200 && Number.isInteger(preview.data?.matched) && Array.isArray(uids), { usage: usage.status, preview: preview.status, matched: preview.data?.matched ?? null })
    },
  }),

  tool('aapanel-port-rules', {
    prefix: 'S16T31', as: 'root', probe: '/api/firewall',
    paths: /^\/api\/firewall(?:\/rules)?$/,
    unit: [{ id: 'S16T31-UNIT-1', file: 'apps/api/src/firewall-workspace.test.ts', name: 'firewall rule-set rules lets system rules move and narrow but never be deleted, widened or unlocked' }],
    checks: ['PORT-RULES-INVENTORY-READ', 'PORT-70000-OUT-OF-RANGE-REFUSED', 'UNSUPPORTED-FIELD-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/firewall')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      check('PORT-RULES-INVENTORY-READ', view.status === 200 && Array.isArray(view.data?.rules) && typeof view.data?.revision === 'string', { status: view.status, rules: Array.isArray(view.data?.rules) ? view.data.rules.length : null })
      refused('PORT-70000-OUT-OF-RANGE-REFUSED', await root.post('/api/firewall/rules', {
        kind: 'port',
        action: 'accept',
        protocol: 'tcp',
        port: '70000',
        source: null,
        forwardTo: null,
        list: null,
        comment: 'invalid port check',
        enabled: true,
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNSUPPORTED-FIELD-REFUSED', await root.post('/api/firewall/rules', { direction: 'outbound' }), 'VALIDATION')
    },
  }),

  tool('aapanel-ip-rules', {
    prefix: 'S16T32', as: 'root', probe: '/api/firewall',
    paths: /^\/api\/firewall(?:\/rules(?:\/[A-Za-z0-9_-]{1,64})?)?$/,
    unit: [{ id: 'S16T32-UNIT-1', file: 'apps/api/src/firewall-workspace.test.ts', name: 'firewall rule-set rules round-trips the project firewall bundle and refuses unknown versions or lists it does not carry' }],
    checks: ['ADDRESS-RULES-INVENTORY-READ', 'MALFORMED-IP-REFUSED', 'DELETE-UNKNOWN-RULE-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/firewall')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      check('ADDRESS-RULES-INVENTORY-READ', view.status === 200 && Array.isArray(view.data?.rules) && typeof view.data?.revision === 'string', { status: view.status })
      refused('MALFORMED-IP-REFUSED', await root.post('/api/firewall/rules', {
        kind: 'ip',
        action: 'drop',
        protocol: null,
        port: null,
        source: '999.999.999.999',
        forwardTo: null,
        list: null,
        comment: 'malformed ip check',
        enabled: true,
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('DELETE-UNKNOWN-RULE-NOT-FOUND', await root.delete('/api/firewall/rules/xq_missing_rule_99', { expectedRevision: rev }), 'NOT_FOUND')
    },
  }),

  tool('aapanel-port-forward', {
    prefix: 'S16T33', as: 'root', probe: '/api/firewall',
    paths: /^\/api\/firewall(?:\/(?:rules|export))?$/,
    unit: [{ id: 'S16T33-UNIT-1', file: 'apps/api/src/firewall-workspace.test.ts', name: 'firewall switch and ping block reads the switch beside the rules' }],
    checks: ['FORWARD-EXPORT-BUNDLE-READ', 'INVALID-FORWARD-TARGET-REFUSED', 'INVALID-FORWARD-PORT-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/firewall')
      const exported = await root.get('/api/firewall/export')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      check('FORWARD-EXPORT-BUNDLE-READ', view.status === 200 && exported.status === 200, { view: view.status, export: exported.status })
      refused('INVALID-FORWARD-TARGET-REFUSED', await root.post('/api/firewall/rules', {
        kind: 'forward',
        action: 'accept',
        protocol: 'tcp',
        port: '2222',
        source: null,
        forwardTo: 'not-a-host-port',
        list: null,
        comment: 'bad forward target',
        enabled: true,
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('INVALID-FORWARD-PORT-REFUSED', await root.post('/api/firewall/rules', {
        kind: 'forward',
        action: 'accept',
        protocol: 'tcp',
        port: '70000',
        source: null,
        forwardTo: '127.0.0.1:22',
        list: null,
        comment: 'bad forward port',
        enabled: true,
        expectedRevision: rev,
      }), 'VALIDATION')
    },
  }),
]
