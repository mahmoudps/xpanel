import { randomUUID } from 'node:crypto'
import { tool } from './kit.mjs'

/**
 * Slice s15 - reviewed WHM database server admin, IP pool/IPv6, Software Center, PHP/NGINX, OS updates,
 * web server directives/logs, TLS policies, MTA configuration/backups, FTP and Dovecot server tools.
 */

const ID = '[0-9a-f-]{36}'
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const ZERO_REV = '0'.repeat(64)
const b64 = text => Buffer.from(text).toString('base64')
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const DEFAULT_WEB = {
  timeoutSec: 120,
  clientMaxBodyMb: 128,
  tlsProtocols: ['TLSv1.2', 'TLSv1.3'],
  tlsCiphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305',
  gzip: { enabled: true, level: 5 },
  directoryIndex: ['index.php', 'index.html', 'index.htm'],
  rlimitMemMb: null,
  rlimitCpuSec: null,
  includes: { apachePreMain: '', apachePreVhost: '', apachePostVhost: '', nginxHttp: '' },
}

const effectiveWeb = settings => ({
  ...DEFAULT_WEB,
  ...(settings?.web ?? {}),
  gzip: { ...DEFAULT_WEB.gzip, ...(settings?.web?.gzip ?? {}) },
  includes: { ...DEFAULT_WEB.includes, ...(settings?.web?.includes ?? {}) },
})

export default [
  tool('db-root-password', {
    prefix: 'S15T01', as: 'root', probe: '/api/server/databases/root-password',
    paths: /^\/api\/server\/databases\/root-password(?:\?x=1)?$/, requests: 15,
    unit: [{ id: 'S15T01-UNIT-1', file: 'apps/api/src/whm-db-admin-workspace.test.ts', name: 'WHM database administration API applies the password policy before dispatch and never echoes the password' }],
    checks: ['ROOT-DB-CLIENT-READ', 'SHORT-DB-CREDENTIAL-REFUSED', 'SPACE-DB-CREDENTIAL-REFUSED', 'EXTRA-DB-FIELD-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/databases/root-password')
      check('ROOT-DB-CLIENT-READ', view.status === 200 && view.data?.clientFile?.path === '/root/.my.cnf', {
        status: view.status, mariadb: view.data?.mariadb ?? null,
      })
      refused('SHORT-DB-CREDENTIAL-REFUSED', await root.post('/api/server/databases/root-password', {
        password: 'short',
      }), 'VALIDATION')
      refused('SPACE-DB-CREDENTIAL-REFUSED', await root.post('/api/server/databases/root-password', {
        password: 'has space 123!',
      }), 'VALIDATION')
      refused('EXTRA-DB-FIELD-REFUSED', await root.post('/api/server/databases/root-password', {
        password: 'Xq9!ValidDatabasePhrase#2026', extra: 1,
      }), 'VALIDATION')
    },
  }),

  tool('db-repair', {
    prefix: 'S15T02', as: 'root', needs: ['account'], probe: '/api/server/databases/overview',
    paths: new RegExp(String.raw`^\/api\/(?:server\/databases\/(?:overview|maintenance)|databases(?:\/repair|\/${ID})?)$`), requests: 25,
    unit: [{ id: 'S15T02-UNIT-1', file: 'apps/api/src/whm-db-admin-workspace.test.ts', name: 'WHM database administration API sends only the validated maintenance request and returns the checked report' }],
    checks: ['SYSTEM-SCHEMA-REPAIR-REFUSED', 'UNSUPPORTED-REPAIR-ACTION-REFUSED', 'POSTGRESQL-REPAIR-PRECONDITION', 'DATABASE-CHECKED-AND-REPAIRED'],
    async run({ root, fixture, tag, check, refused, undo }) {
      refused('SYSTEM-SCHEMA-REPAIR-REFUSED', await root.post('/api/server/databases/maintenance', {
        database: 'mysql', action: 'repair',
      }), 'VALIDATION')
      refused('UNSUPPORTED-REPAIR-ACTION-REFUSED', await root.post('/api/server/databases/maintenance', {
        database: `${fixture.username}_db`, action: 'optimize',
      }), 'VALIDATION')
      refused('POSTGRESQL-REPAIR-PRECONDITION', await root.post('/api/databases/repair', {
        accountId: fixture.accountId, database: `${fixture.username}_db`, engine: 'postgresql', operation: 'repair',
      }), 'PRECONDITION_FAILED')
      const dbName = `${fixture.username}_rpr_${tag.slice(0, 4)}`
      const created = await root.post('/api/databases', { accountId: fixture.accountId, name: dbName, engine: 'mariadb' })
      const dbId = created.data?.database?.id
      if (typeof dbId === 'string') {
        undo('repair test database', async () => [200, 404].includes((await root.delete(`/api/databases/${dbId}`)).status))
      }
      const checked = typeof dbId === 'string'
        ? await root.post('/api/server/databases/maintenance', { database: dbName, action: 'check' })
        : { status: 0, data: null }
      const repaired = typeof dbId === 'string'
        ? await root.post('/api/server/databases/maintenance', { database: dbName, action: 'repair' })
        : { status: 0, data: null }
      if (typeof dbId === 'string') await root.delete(`/api/databases/${dbId}`)
      check('DATABASE-CHECKED-AND-REPAIRED', created.status === 201 && checked.status === 200 && Array.isArray(checked.data?.tables) && repaired.status === 200 && Array.isArray(repaired.data?.tables), {
        createdStatus: created.status, checkedStatus: checked.status, repairedStatus: repaired.status,
      })
    },
  }),

  tool('add-ip', {
    prefix: 'S15T03', as: 'root', probe: '/api/ips',
    paths: /^\/api\/ips$/, requests: 15,
    unit: [{ id: 'S15T03-UNIT-1', file: 'apps/api/src/ip-allocation.test.ts', name: 'IP API router and desired-state allocation diagnostics rejects a missing or non-string pool address as 422 without success effects' }],
    checks: ['POOL-IPS-READ', 'CIDR-RANGE-ADD-REFUSED', 'LOOPBACK-IP-ADD-REFUSED', 'DUPLICATE-POOL-IP-CONFLICT'],
    async run({ root, check, refused }) {
      const list = await root.get('/api/ips')
      const firstIp = (list.data?.ips ?? [])[0]?.address
      check('POOL-IPS-READ', list.status === 200 && Array.isArray(list.data?.ips) && list.data.ips.length >= 1, {
        status: list.status, count: Array.isArray(list.data?.ips) ? list.data.ips.length : null,
      })
      refused('CIDR-RANGE-ADD-REFUSED', await root.post('/api/ips', { address: '192.0.2.128/23' }), 'VALIDATION')
      refused('LOOPBACK-IP-ADD-REFUSED', await root.post('/api/ips', { address: '127.0.0.2', role: 'dedicated' }), 'VALIDATION')
      if (typeof firstIp === 'string') {
        refused('DUPLICATE-POOL-IP-CONFLICT', await root.post('/api/ips', { address: firstIp, role: 'dedicated' }), 'CONFLICT')
      } else {
        check('DUPLICATE-POOL-IP-CONFLICT', false, { hasPoolIp: false })
      }
    },
  }),

  tool('assign-ipv6', {
    prefix: 'S15T04', as: 'root', needs: ['account'], probe: '/api/ips',
    paths: new RegExp(String.raw`^\/api\/(?:ips|accounts\/${ID}\/ipv6)$`), requests: 15,
    unit: [{ id: 'S15T04-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: 'root IP tools saves IPv6 ranges and assigns the next address to an account' }],
    checks: ['MALFORMED-RANGE-ID-REFUSED', 'EXTRA-IPV6-FIELD-REFUSED', 'MISSING-RANGE-NOT-FOUND', 'MISSING-ACCOUNT-IPV6-NOT-FOUND'],
    async run({ root, fixture, refused }) {
      refused('MALFORMED-RANGE-ID-REFUSED', await root.post(`/api/accounts/${fixture.accountId}/ipv6`, {
        rangeId: 'not-a-uuid',
      }), 'VALIDATION')
      refused('EXTRA-IPV6-FIELD-REFUSED', await root.post(`/api/accounts/${fixture.accountId}/ipv6`, {
        rangeId: ZERO_UUID, extra: 1,
      }), 'VALIDATION')
      refused('MISSING-RANGE-NOT-FOUND', await root.post(`/api/accounts/${fixture.accountId}/ipv6`, {
        rangeId: ZERO_UUID,
      }), 'NOT_FOUND')
      refused('MISSING-ACCOUNT-IPV6-NOT-FOUND', await root.post(`/api/accounts/${ZERO_UUID}/ipv6`, {
        rangeId: ZERO_UUID,
      }), 'NOT_FOUND')
    },
  }),

  tool('ip-migration-wizard', {
    prefix: 'S15T05', as: 'root', probe: '/api/ips',
    paths: /^\/api\/ips(?:\/migrate)?$/, requests: 15,
    unit: [{ id: 'S15T05-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: 'root IP tools migrates addresses and rebuilds the pool from the host report only' }],
    checks: ['EMPTY-MIGRATION-REFUSED', 'SAME-ADDRESS-MIGRATION-REFUSED', 'MIXED-FAMILY-MIGRATION-REFUSED', 'UNPOOLED-MIGRATION-NOT-FOUND'],
    async run({ root, refused }) {
      refused('EMPTY-MIGRATION-REFUSED', await root.post('/api/ips/migrate', { mappings: [] }), 'VALIDATION')
      refused('SAME-ADDRESS-MIGRATION-REFUSED', await root.post('/api/ips/migrate', {
        mappings: [{ from: '192.0.2.10', to: '192.0.2.10' }],
      }), 'VALIDATION')
      refused('MIXED-FAMILY-MIGRATION-REFUSED', await root.post('/api/ips/migrate', {
        mappings: [{ from: '192.0.2.10', to: '2001:db8::1' }],
      }), 'VALIDATION')
      refused('UNPOOLED-MIGRATION-NOT-FOUND', await root.post('/api/ips/migrate', {
        mappings: [{ from: '192.0.2.250', to: '192.0.2.251' }],
      }), 'NOT_FOUND')
    },
  }),

  tool('ipv6-ranges', {
    prefix: 'S15T06', as: 'root', restores: ['/api/ips/ranges'], probe: '/api/ips',
    paths: /^\/api\/ips(?:\/ranges)?$/, requests: 25,
    unit: [{ id: 'S15T06-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: 'root IP tools saves IPv6 ranges and assigns the next address to an account' }],
    checks: ['HOST-BITS-CIDR-REFUSED', 'OVERLAPPING-RANGES-REFUSED', 'UNKNOWN-RANGE-OWNER-NOT-FOUND', 'IPV6-RANGE-SAVED-AND-RESTORED'],
    async run({ root, tag, check, refused, undo }) {
      const before = await root.get('/api/ips/ranges')
      const origRanges = Array.isArray(before.data?.ranges) ? structuredClone(before.data.ranges) : null
      const r1 = randomUUID(), r2 = randomUUID()
      refused('HOST-BITS-CIDR-REFUSED', await root.put('/api/ips/ranges', {
        ranges: [{ id: r1, cidr: '2001:db8::1/64', ownerKind: 'root', ownerId: null, notes: '' }],
      }), 'VALIDATION')
      refused('OVERLAPPING-RANGES-REFUSED', await root.put('/api/ips/ranges', {
        ranges: [
          { id: r1, cidr: '2001:db8::/48', ownerKind: 'root', ownerId: null, notes: '' },
          { id: r2, cidr: '2001:db8:0:1::/64', ownerKind: 'root', ownerId: null, notes: '' },
        ],
      }), 'VALIDATION')
      refused('UNKNOWN-RANGE-OWNER-NOT-FOUND', await root.put('/api/ips/ranges', {
        ranges: [{ id: r1, cidr: '2001:db8:9::/64', ownerKind: 'account', ownerId: ZERO_UUID, notes: '' }],
      }), 'NOT_FOUND')
      if (before.status !== 200 || !origRanges) {
        check('IPV6-RANGE-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('ipv6 ranges', async () => (await root.put('/api/ips/ranges', { ranges: origRanges })).status === 200)
      const addedRange = { id: r1, cidr: '2001:db8:cafe::/64', ownerKind: 'root', ownerId: null, notes: `xq-${tag}` }
      const saved = await root.put('/api/ips/ranges', { ranges: [...origRanges, addedRange] })
      const restored = await root.put('/api/ips/ranges', { ranges: origRanges })
      check('IPV6-RANGE-SAVED-AND-RESTORED', saved.status === 200 && (saved.data?.ranges ?? []).some(r => r?.cidr === '2001:db8:cafe::/64') && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('rebuild-ip-pool', {
    prefix: 'S15T07', as: 'root', probe: '/api/ips',
    paths: new RegExp(String.raw`^\/api\/ips(?:\/rebuild|\/${ID})?$`), requests: 20,
    unit: [{ id: 'S15T07-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: 'root IP tools migrates addresses and rebuilds the pool from the host report only' }],
    checks: ['REBUILD-EXTRA-FIELD-REFUSED', 'REBUILD-GET-METHOD-REFUSED', 'IP-POOL-REBUILT-FROM-HOST'],
    async run({ root, check, refused, undo }) {
      refused('REBUILD-EXTRA-FIELD-REFUSED', await root.post('/api/ips/rebuild', { force: true }), 'VALIDATION')
      refused('REBUILD-GET-METHOD-REFUSED', await root.get('/api/ips/rebuild'), 405)
      const rebuilt = await root.post('/api/ips/rebuild', {})
      const added = Array.isArray(rebuilt.data?.added) ? rebuilt.data.added : null
      if (added && added.length > 0) {
        const ids = added.map(item => item?.id).filter(id => typeof id === 'string')
        undo('rebuilt pool entries', async () => {
          for (const id of ids) await root.delete(`/api/ips/${id}`)
          return true
        })
        for (const id of ids) await root.delete(`/api/ips/${id}`)
      }
      check('IP-POOL-REBUILT-FROM-HOST', rebuilt.status === 200 && Array.isArray(added), {
        status: rebuilt.status, addedCount: added?.length ?? null,
      })
    },
  }),

  tool('ip-usage-report', {
    prefix: 'S15T08', as: 'root', needs: ['account'], probe: '/api/ips/usage',
    paths: /^\/api\/ips(?:\/usage|\?x=1)?$/, requests: 15,
    unit: [{ id: 'S15T08-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: "root IP tools changes a site's IP, reconciles and reports the held address" }],
    checks: ['IP-USAGE-INCLUDES-ACCOUNT', 'IP-USAGE-SELECTOR-REFUSED', 'IP-USAGE-POST-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const usage = await root.get('/api/ips/usage')
      const rows = Array.isArray(usage.data?.ips) ? usage.data.ips : []
      const hasAcct = rows.some(ip => (ip?.accounts ?? []).some(a => a?.username === fixture.username))
      const shapesOk = rows.length >= 1 && rows.every(ip => Array.isArray(ip?.domains) && Array.isArray(ip?.mail) && Array.isArray(ip?.resellers))
      check('IP-USAGE-INCLUDES-ACCOUNT', usage.status === 200 && hasAcct && shapesOk, {
        status: usage.status, hasAcct, shapesOk,
      })
      refused('IP-USAGE-SELECTOR-REFUSED', await root.get('/api/ips?x=1'), 'VALIDATION')
      refused('IP-USAGE-POST-REFUSED', await root.post('/api/ips/usage', {}), 405)
    },
  }),

  tool('reserved-ips', {
    prefix: 'S15T09', as: 'root', restores: ['/api/ips'], probe: '/api/ips',
    paths: new RegExp(String.raw`^\/api\/ips(?:\/${ID})?$`), requests: 25,
    unit: [{ id: 'S15T09-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: 'root IP tools edits reservation and reverse DNS, and refuses unknown fields and non-root callers' }],
    checks: ['DEFAULT-IP-RESERVE-REFUSED', 'UNKNOWN-PATCH-FIELD-REFUSED', 'ABSENT-IP-PATCH-NOT-FOUND', 'REVERSE-DNS-NOTE-SAVED-AND-RESTORED'],
    async run({ root, tag, check, refused, undo }) {
      const list = await root.get('/api/ips')
      const primary = (list.data?.ips ?? []).find(item => item?.isPrimary === true) ?? (list.data?.ips ?? [])[0]
      const pid = primary?.id ?? ZERO_UUID
      refused('DEFAULT-IP-RESERVE-REFUSED', await root.patch(`/api/ips/${pid}`, { reserved: true }), primary?.id ? 'VALIDATION' : 'NOT_FOUND')
      refused('UNKNOWN-PATCH-FIELD-REFUSED', await root.patch(`/api/ips/${pid}`, { role: 'shared' }), 'VALIDATION')
      refused('ABSENT-IP-PATCH-NOT-FOUND', await root.patch(`/api/ips/${ZERO_UUID}`, { notes: 'absent' }), 'NOT_FOUND')
      if (list.status !== 200 || typeof primary?.id !== 'string') {
        check('REVERSE-DNS-NOTE-SAVED-AND-RESTORED', false, { status: list.status })
        return
      }
      const origPtr = primary.ptrHostname ?? null
      const origNotes = primary.notes ?? ''
      undo('primary ip metadata', async () => (await root.patch(`/api/ips/${primary.id}`, {
        ptrHostname: origPtr, notes: origNotes,
      })).status === 200)
      const ptrTarget = `ptr-${tag}.example.test`
      const patched = await root.patch(`/api/ips/${primary.id}`, { ptrHostname: ptrTarget, notes: `xq-${tag}` })
      const restored = await root.patch(`/api/ips/${primary.id}`, { ptrHostname: origPtr, notes: origNotes })
      check('REVERSE-DNS-NOTE-SAVED-AND-RESTORED', patched.status === 200 && patched.data?.ip?.ptrHostname === ptrTarget && restored.status === 200, {
        patchedStatus: patched.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('module-installers', {
    prefix: 'S15T10', as: 'root', probe: '/api/server/software-center?page=module',
    paths: /^\/api\/server\/software-center(?:\?page=(?:module|bad)|\/apply)?$/, requests: 15,
    unit: [{ id: 'S15T10-UNIT-1', file: 'apps/api/src/software-center-workspace.test.ts', name: 'software center API workspace authenticates and requires root before forwarding a page read, then re-checks' }],
    checks: ['MODULE-CATALOG-READ', 'INVALID-PAGE-QUERY-REFUSED', 'INVALID-APPLY-ACTION-REFUSED', 'STALE-MODULE-APPLY-CONFLICT'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software-center?page=module')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      const phpVersions = new Set(view.data?.phpVersions ?? [])
      const phpComps = (view.data?.components ?? []).filter(c => c?.category === 'php')
      const versionsMatch = phpComps.every(c => phpVersions.has(c.phpVersion))
      check('MODULE-CATALOG-READ', view.status === 200 && Array.isArray(view.data?.components) && versionsMatch, {
        status: view.status, components: Array.isArray(view.data?.components) ? view.data.components.length : null,
      })
      refused('INVALID-PAGE-QUERY-REFUSED', await root.get('/api/server/software-center?page=bad'), 'VALIDATION')
      refused('INVALID-APPLY-ACTION-REFUSED', await root.post('/api/server/software-center/apply', {
        action: 'purge', componentIds: ['perl-json'], expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-MODULE-APPLY-CONFLICT', await root.post('/api/server/software-center/apply', {
        action: 'install', componentIds: ['perl-json'], expectedRevision: ZERO_REV,
      }), 'CONFLICT')
    },
  }),

  tool('xwhm-perl-modules', {
    prefix: 'S15T11', as: 'root', probe: '/api/server/software-center?page=module',
    paths: /^\/api\/server\/software-center(?:\?page=module|\/(?:preview|apply))$/, requests: 15,
    unit: [{ id: 'S15T11-UNIT-1', file: 'apps/api/src/software-center-workspace.test.ts', name: 'software center API workspace audits, re-checks root around the mutation and returns the submitted job' }],
    checks: ['PERL-MODULES-LISTED', 'ARBITRARY-CPAN-NAME-REFUSED', 'PERL-PREVIEW-EVALUATED', 'STALE-PERL-APPLY-CONFLICT'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software-center?page=module')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      const perlComps = (view.data?.components ?? []).filter(c => c?.category === 'perl')
      const perlJson = perlComps.find(c => c?.id === 'perl-json') ?? perlComps[0]
      check('PERL-MODULES-LISTED', view.status === 200 && perlComps.length > 0, {
        status: view.status, perlCount: perlComps.length,
      })
      refused('ARBITRARY-CPAN-NAME-REFUSED', await root.post('/api/server/software-center/preview', {
        action: 'install', componentIds: ['CPAN::Meta'], expectedRevision: rev,
      }), 'VALIDATION')
      const preview = await root.post('/api/server/software-center/preview', {
        action: perlJson?.state === 'installed' ? 'remove' : 'install',
        componentIds: [perlJson?.id ?? 'perl-json'],
        expectedRevision: rev,
      })
      check('PERL-PREVIEW-EVALUATED', preview.status === 200 && typeof preview.data?.preview?.state === 'string', {
        status: preview.status, previewState: preview.data?.preview?.state ?? null,
      })
      refused('STALE-PERL-APPLY-CONFLICT', await root.post('/api/server/software-center/apply', {
        action: 'install', componentIds: ['perl-json'], expectedRevision: ZERO_REV,
      }), 'CONFLICT')
    },
  }),

  tool('pear-packages', {
    prefix: 'S15T12', as: 'root', probe: '/api/server/software-center?page=module',
    paths: /^\/api\/server\/(?:software-center\?page=module|services\/pear(?:\?version=(?:8\.3|5\.6)|\/(?:search|change))?)$/, requests: 15,
    unit: [{ id: 'S15T12-UNIT-1', file: 'apps/agent/src/svc-tools.test.ts', name: 'PEAR per PHP version gives each version its own library' }],
    checks: ['PEAR-VERSION-LIBRARY-READ', 'UNSUPPORTED-PEAR-VERSION-REFUSED', 'FLAG-INJECTION-SEARCH-REFUSED', 'INVALID-PEAR-OPERATION-REFUSED'],
    async run({ root, check, refused }) {
      const pear = await root.get('/api/server/services/pear?version=8.3')
      check('PEAR-VERSION-LIBRARY-READ', pear.status === 200 && pear.data?.library === '/usr/share/xpanel/pear/8.3/php', {
        status: pear.status, state: pear.data?.state ?? null,
      })
      refused('UNSUPPORTED-PEAR-VERSION-REFUSED', await root.get('/api/server/services/pear?version=5.6'), 'VALIDATION')
      refused('FLAG-INJECTION-SEARCH-REFUSED', await root.post('/api/server/services/pear/search', {
        version: '8.3', name: '--force',
      }), 'VALIDATION')
      refused('INVALID-PEAR-OPERATION-REFUSED', await root.post('/api/server/services/pear/change', {
        version: '8.3', operation: 'purge', name: 'Mail',
      }), 'VALIDATION')
    },
  }),

  tool('pecl-extensions', {
    prefix: 'S15T13', as: 'root', probe: '/api/server/software-center?page=module',
    paths: /^\/api\/server\/software-center(?:\?page=module|\/preview)$/, requests: 15,
    unit: [{ id: 'S15T13-UNIT-1', file: 'apps/api/src/software-center-workspace.test.ts', name: 'software center API workspace forwards a preview bound to the reviewed revision' }],
    checks: ['PHP-EXTENSIONS-LISTED', 'ARBITRARY-PECL-SOURCE-REFUSED', 'PACKAGED-EXTENSION-PREVIEWED', 'UNREVIEWED-EXTENSION-PREVIEW-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software-center?page=module')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      const phpExts = (view.data?.components ?? []).filter(c => c?.category === 'php')
      const sampleExt = phpExts[0]
      check('PHP-EXTENSIONS-LISTED', view.status === 200 && phpExts.length > 0, {
        status: view.status, count: phpExts.length,
      })
      refused('ARBITRARY-PECL-SOURCE-REFUSED', await root.post('/api/server/software-center/preview', {
        action: 'install', componentIds: ['pecl/swoole'], expectedRevision: rev,
      }), 'VALIDATION')
      const validPreview = await root.post('/api/server/software-center/preview', {
        action: sampleExt?.state === 'installed' ? 'remove' : 'install',
        componentIds: [sampleExt?.id ?? 'php83-redis'],
        expectedRevision: rev,
      })
      check('PACKAGED-EXTENSION-PREVIEWED', validPreview.status === 200 && typeof validPreview.data?.preview?.state === 'string', {
        status: validPreview.status, state: validPreview.data?.preview?.state ?? null,
      })
      const unknownPreview = await root.post('/api/server/software-center/preview', {
        action: 'install', componentIds: ['php83-swoole'], expectedRevision: rev,
      })
      check('UNREVIEWED-EXTENSION-PREVIEW-REFUSED', unknownPreview.status === 200 && unknownPreview.data?.preview?.state === 'refused', {
        status: unknownPreview.status, reason: unknownPreview.data?.preview?.reason ?? null,
      })
    },
  }),

  tool('php-ini-editor', {
    prefix: 'S15T14', as: 'root', probe: '/api/server/php/manage',
    paths: /^\/api\/server\/php\/manage(?:\/preview)?$/, requests: 15,
    unit: [{ id: 'S15T14-UNIT-1', file: 'apps/api/src/php-manage-workspace.test.ts', name: 'PHP management workspace forwards previews and audits every submitted job' }],
    checks: ['LITERAL-TRUE-DIRECTIVE-REFUSED', 'SERVER-OWNED-DIRECTIVE-REFUSED', 'STALE-PHP-INI-CONFLICT', 'MEMORY-LIMIT-INI-PREVIEWED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/php/manage')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      const installed = (view.data?.versions ?? []).find(v => v?.fpmInstalled === true) ?? (view.data?.versions ?? [])[0]
      const ver = installed?.version ?? view.data?.defaultVersion ?? '8.3'
      const baseIni = installed?.ini ?? {}
      refused('LITERAL-TRUE-DIRECTIVE-REFUSED', await root.post('/api/server/php/manage/preview', {
        operation: 'set-ini', version: ver, ini: { true: '1' }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('SERVER-OWNED-DIRECTIVE-REFUSED', await root.post('/api/server/php/manage/preview', {
        operation: 'set-ini', version: ver, ini: { disable_functions: '' }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-PHP-INI-CONFLICT', await root.post('/api/server/php/manage/preview', {
        operation: 'set-ini', version: ver, ini: { ...baseIni, memory_limit: '256M' }, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      const preview = await root.post('/api/server/php/manage/preview', {
        operation: 'set-ini', version: ver, ini: { ...baseIni, memory_limit: '256M' }, expectedRevision: rev,
      })
      check('MEMORY-LIMIT-INI-PREVIEWED', preview.status === 200 && preview.data?.preview?.ini?.after?.memory_limit === '256M', {
        status: preview.status, state: preview.data?.preview?.state ?? null,
      })
    },
  }),

  tool('php-manager-system', {
    prefix: 'S15T15', as: 'root', probe: '/api/server/php/manage',
    paths: /^\/api\/server\/php\/(?:manage|default)$/, requests: 20,
    unit: [{ id: 'S15T15-UNIT-1', file: 'apps/api/src/php-manage-workspace.test.ts', name: 'PHP management workspace changes the default for new domains only after a revision-bound check that it is installed and supported' }],
    checks: ['CONVERT-ALL-FIELD-REFUSED', 'UNINSTALLED-DEFAULT-REFUSED', 'STALE-PHP-DEFAULT-CONFLICT', 'SYSTEM-DEFAULT-SAVED-FOR-NEW-DOMAINS'],
    async run({ root, check, refused, undo }) {
      const view = await root.get('/api/server/php/manage')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      const origDefault = view.data?.defaultVersion ?? '8.3'
      const uninstalled = (view.data?.versions ?? []).find(v => v?.fpmInstalled === false)?.version ?? (view.data?.installable ?? [])[0]
      refused('CONVERT-ALL-FIELD-REFUSED', await root.put('/api/server/php/default', {
        version: origDefault, expectedRevision: rev, convertAll: true,
      }), 'VALIDATION')
      if (typeof uninstalled === 'string') {
        refused('UNINSTALLED-DEFAULT-REFUSED', await root.put('/api/server/php/default', {
          version: uninstalled, expectedRevision: rev,
        }), 'PRECONDITION_FAILED')
      } else {
        refused('UNINSTALLED-DEFAULT-REFUSED', await root.put('/api/server/php/default', {
          version: '9.9', expectedRevision: rev,
        }), 'VALIDATION')
      }
      refused('STALE-PHP-DEFAULT-CONFLICT', await root.put('/api/server/php/default', {
        version: origDefault, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (view.status !== 200 || typeof view.data?.revision !== 'string') {
        check('SYSTEM-DEFAULT-SAVED-FOR-NEW-DOMAINS', false, { status: view.status })
        return
      }
      undo('system php default', async () => {
        const now = await root.get('/api/server/php/manage')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.defaultVersion === origDefault) return true
        return (await root.put('/api/server/php/default', { version: origDefault, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/server/php/default', { version: origDefault, expectedRevision: rev })
      check('SYSTEM-DEFAULT-SAVED-FOR-NEW-DOMAINS', saved.status === 200 && saved.data?.scope === 'new-domains-only', {
        status: saved.status, scope: saved.data?.scope ?? null,
      })
    },
  }),

  tool('php-manager-domains', {
    prefix: 'S15T16', as: 'root', needs: ['account'], probe: '/api/server/php/manage',
    paths: /^\/api\/server\/php\/(?:manage|domain)$/, requests: 25,
    unit: [{ id: 'S15T16-UNIT-1', file: 'apps/api/src/php-manage-workspace.test.ts', name: 'PHP management workspace moves every PHP domain of one account to an installed version and reconciles once' }],
    checks: ['ZERO-MAX-CHILDREN-REFUSED', 'ABOVE-CEILING-CHILDREN-REFUSED', 'UNKNOWN-PHP-DOMAIN-NOT-FOUND', 'DOMAIN-FPM-POOL-SAVED-AND-RESET'],
    async run({ root, fixture, check, refused, undo }) {
      const view = await root.get('/api/server/php/manage')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      refused('ZERO-MAX-CHILDREN-REFUSED', await root.post('/api/server/php/domain', {
        domain: fixture.domain,
        fpm: { mode: 'ondemand', maxChildren: 0, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('ABOVE-CEILING-CHILDREN-REFUSED', await root.post('/api/server/php/domain', {
        domain: fixture.domain,
        fpm: { mode: 'ondemand', maxChildren: 10001, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNKNOWN-PHP-DOMAIN-NOT-FOUND', await root.post('/api/server/php/domain', {
        domain: 'missing-nowhere.example.test', fpm: null, expectedRevision: rev,
      }), 'NOT_FOUND')
      if (view.status !== 200 || typeof view.data?.revision !== 'string') {
        check('DOMAIN-FPM-POOL-SAVED-AND-RESET', false, { status: view.status })
        return
      }
      undo('domain fpm pool', async () => {
        const now = await root.get('/api/server/php/manage')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        return (await root.post('/api/server/php/domain', {
          domain: fixture.domain, fpm: null, expectedRevision: now.data.revision,
        })).status === 200
      })
      const customized = await root.post('/api/server/php/domain', {
        domain: fixture.domain,
        fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 400, processIdleTimeoutSec: 10 },
        expectedRevision: rev,
      })
      const afterCustom = await root.get('/api/server/php/manage')
      const reset = typeof afterCustom.data?.revision === 'string'
        ? await root.post('/api/server/php/domain', { domain: fixture.domain, fpm: null, expectedRevision: afterCustom.data.revision })
        : { status: 0 }
      check('DOMAIN-FPM-POOL-SAVED-AND-RESET', customized.status === 200 && customized.data?.fpm?.maxChildren === 2 && reset.status === 200, {
        customizedStatus: customized.status, resetStatus: reset.status,
      })
    },
  }),

  tool('nginx-proxy-manager', {
    prefix: 'S15T17', as: 'root', needs: ['account'], probe: '/api/server/nginx-proxy',
    paths: /^\/api\/server\/nginx-proxy(?:\/(?:domains\/[a-z0-9.-]+|cache))?$/, requests: 25,
    unit: [{ id: 'S15T17-UNIT-1', file: 'apps/api/src/nginx-proxy-workspace.test.ts', name: 'NGINX Reverse Proxy Manager switches and purges the cache per account and in bulk, leaving others alone' }],
    checks: ['LOOPBACK-UPSTREAM-REFUSED', 'METADATA-UPSTREAM-REFUSED', 'PANEL-PORT-UPSTREAM-REFUSED', 'PROXY-RULE-AND-CACHE-PURGE'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const [overview, dom] = await Promise.all([
        root.get('/api/server/nginx-proxy'),
        root.get(`/api/server/nginx-proxy/domains/${fixture.domain}`),
      ])
      const domRev = typeof dom.data?.revision === 'string' ? dom.data.revision : ZERO_REV
      refused('LOOPBACK-UPSTREAM-REFUSED', await root.post(`/api/server/nginx-proxy/domains/${fixture.domain}`, {
        expectedRevision: domRev,
        add: { path: '/app', target: 'http://127.0.0.1:9000', websocket: false, hostHeader: 'client' },
      }), 'VALIDATION')
      refused('METADATA-UPSTREAM-REFUSED', await root.post(`/api/server/nginx-proxy/domains/${fixture.domain}`, {
        expectedRevision: domRev,
        add: { path: '/meta', target: 'http://169.254.169.254', websocket: false, hostHeader: 'client' },
      }), 'VALIDATION')
      refused('PANEL-PORT-UPSTREAM-REFUSED', await root.post(`/api/server/nginx-proxy/domains/${fixture.domain}`, {
        expectedRevision: domRev,
        add: { path: '/panel', target: 'http://203.0.113.7:2087', websocket: false, hostHeader: 'client' },
      }), 'VALIDATION')
      if (dom.status !== 200 || typeof dom.data?.revision !== 'string') {
        check('PROXY-RULE-AND-CACHE-PURGE', false, { status: dom.status })
        return
      }
      const rulePath = `/xq-${tag}`
      undo('nginx proxy rule', async () => {
        const cur = await root.get(`/api/server/nginx-proxy/domains/${fixture.domain}`)
        if (cur.status !== 200 || typeof cur.data?.revision !== 'string') return false
        if (!(cur.data?.rules ?? []).some(r => r?.path === rulePath)) return true
        return (await root.post(`/api/server/nginx-proxy/domains/${fixture.domain}`, {
          expectedRevision: cur.data.revision, remove: rulePath,
        })).status === 200
      })
      const added = await root.post(`/api/server/nginx-proxy/domains/${fixture.domain}`, {
        expectedRevision: domRev,
        add: { path: rulePath, target: 'https://203.0.113.7:9443', websocket: true, hostHeader: 'client' },
      })
      const removed = typeof added.data?.revision === 'string'
        ? await root.post(`/api/server/nginx-proxy/domains/${fixture.domain}`, { expectedRevision: added.data.revision, remove: rulePath })
        : { status: 0 }
      const acctRow = (overview.data?.accounts ?? []).find(a => a?.username === fixture.username)
      const cacheRev = typeof acctRow?.cache?.revision === 'string' ? acctRow.cache.revision : ZERO_REV
      const purged = await root.post('/api/server/nginx-proxy/cache', {
        op: 'purge', accounts: [{ username: fixture.username, expectedRevision: cacheRev }],
      })
      check('PROXY-RULE-AND-CACHE-PURGE', added.status === 200 && removed.status === 200 && purged.status === 200, {
        addedStatus: added.status, removedStatus: removed.status, purgedStatus: purged.status,
      })
    },
  }),

  tool('package-db-rebuild', {
    prefix: 'S15T18', as: 'root', probe: '/api/server/repair/diagnostics',
    paths: /^\/api\/server\/repair\/(?:diagnostics|preview|run)$/, requests: 15,
    unit: [{ id: 'S15T18-UNIT-1', file: 'apps/agent/src/repair-center-routes.test.ts', name: 'RHEL RPM database rebuild route keeps the rebuild unavailable without a recovery provider and refuses it on Debian hosts' }],
    checks: ['REPAIR-DIAGNOSTICS-READ', 'MALFORMED-REPAIR-REVISION-REFUSED', 'FALSE-ACCEPT-REMOVALS-REFUSED', 'RPMDB-REBUILD-GUARDED'],
    async run({ root, check, refused }) {
      const diag = await root.get('/api/server/repair/diagnostics')
      const rev = typeof diag.data?.revision === 'string' ? diag.data.revision : ZERO_REV
      check('REPAIR-DIAGNOSTICS-READ', diag.status === 200 && Array.isArray(diag.data?.diagnostics) && typeof diag.data?.family === 'string', {
        status: diag.status, family: diag.data?.family ?? null,
      })
      refused('MALFORMED-REPAIR-REVISION-REFUSED', await root.post('/api/server/repair/preview', {
        repairId: 'rpmdb-rebuild', expectedRevision: 'bad',
      }), 'VALIDATION')
      refused('FALSE-ACCEPT-REMOVALS-REFUSED', await root.post('/api/server/repair/run', {
        repairId: 'rpmdb-rebuild', expectedRevision: rev, acceptRemovals: false,
      }), 'VALIDATION')
      refused('RPMDB-REBUILD-GUARDED', await root.post('/api/server/repair/run', {
        repairId: 'rpmdb-rebuild', expectedRevision: rev,
      }), 'PRECONDITION_FAILED')
    },
  }),

  tool('os-update', {
    prefix: 'S15T19', as: 'root', probe: '/api/server/updates/plan',
    page: { route: '/whm/software/updates', read: '/api/server/updates/plan', shows: () => ['System updates'] },
    paths: /^\/api\/server\/updates\/(?:plan(?:\?excludeKernel=(?:true|false))?|apply)$/, requests: 15,
    unit: [{ id: 'S15T19-UNIT-1', file: 'apps/api/src/system-updates-workspace.test.ts', name: 'kernel exclusion API contract forwards only the fixed preview option and bound apply intent' }],
    checks: ['OS-UPDATE-PLAN-AND-KERNEL-FILTER', 'FALSE-EXCLUDE-QUERY-REFUSED', 'SECURITY-WITH-PACKAGES-REFUSED', 'STALE-UPDATES-APPLY-CONFLICT'],
    async run({ root, check, refused }) {
      const [fullPlan, noKernel] = await Promise.all([
        root.get('/api/server/updates/plan'),
        root.get('/api/server/updates/plan?excludeKernel=true'),
      ])
      const noKernelPkgs = noKernel.data?.plan?.packages ?? []
      const distinctExcludeRevision = typeof noKernel.data?.plan?.revision === 'string'
        && noKernel.data.plan.revision !== fullPlan.data?.plan?.revision
        && Array.isArray(noKernelPkgs)
        && noKernelPkgs.every(pkg => typeof pkg?.kernel === 'boolean')
      check('OS-UPDATE-PLAN-AND-KERNEL-FILTER', fullPlan.status === 200 && noKernel.status === 200 && noKernel.data?.plan?.excludeKernel === true && distinctExcludeRevision, {
        fullStatus: fullPlan.status, filteredStatus: noKernel.status, distinctExcludeRevision,
      })
      refused('FALSE-EXCLUDE-QUERY-REFUSED', await root.get('/api/server/updates/plan?excludeKernel=false'), 'VALIDATION')
      refused('SECURITY-WITH-PACKAGES-REFUSED', await root.post('/api/server/updates/apply', {
        expectedRevision: ZERO_REV, mode: 'security', packages: ['openssl'],
      }), 'VALIDATION')
      refused('STALE-UPDATES-APPLY-CONFLICT', await root.post('/api/server/updates/apply', {
        expectedRevision: ZERO_REV, mode: 'security', excludeKernel: true,
      }), 'CONFLICT')
    },
  }),

  tool('server-software-update', {
    prefix: 'S15T20', as: 'root', probe: '/api/server/updates/plan?excludeKernel=true',
    page: { route: '/whm/software/updates', read: '/api/server/updates/plan?excludeKernel=true', shows: () => ['System updates'] },
    paths: /^\/api\/server\/updates\/(?:plan\?excludeKernel=true|apply)$/, requests: 15,
    unit: [{ id: 'S15T20-UNIT-1', file: 'apps/api/src/system-updates-workspace.test.ts', name: 'system updates API workspace re-checks root after the body read and after the host call, forwarding only the reviewed body' }],
    checks: ['EXCLUDED-KERNEL-PLAN-READ', 'NON-BOOLEAN-EXCLUDE-REFUSED', 'FLAG-PACKAGE-NAME-REFUSED', 'STALE-SOFTWARE-APPLY-CONFLICT'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/updates/plan?excludeKernel=true')
      const pkgs = view.data?.plan?.packages ?? []
      const cleanList = Array.isArray(pkgs) && pkgs.every(pkg => typeof pkg?.kernel === 'boolean' && pkg?.name !== 'xpanel')
      check('EXCLUDED-KERNEL-PLAN-READ', view.status === 200 && view.data?.plan?.excludeKernel === true && cleanList, {
        status: view.status, packageCount: Array.isArray(pkgs) ? pkgs.length : null,
      })
      refused('NON-BOOLEAN-EXCLUDE-REFUSED', await root.post('/api/server/updates/apply', {
        expectedRevision: ZERO_REV, mode: 'all', excludeKernel: 'linux-*',
      }), 'VALIDATION')
      refused('FLAG-PACKAGE-NAME-REFUSED', await root.post('/api/server/updates/apply', {
        expectedRevision: ZERO_REV, mode: 'selected', packages: ['-o'],
      }), 'VALIDATION')
      refused('STALE-SOFTWARE-APPLY-CONFLICT', await root.post('/api/server/updates/apply', {
        expectedRevision: ZERO_REV, mode: 'all', excludeKernel: true,
      }), 'CONFLICT')
    },
  }),

  tool('directory-index-priority', {
    prefix: 'S15T21', as: 'root', also: ['owner'], needs: ['account'], restores: ['/api/server/settings'], probe: '/api/server/settings',
    paths: /^\/api\/(?:server\/settings|domains|accounts\/[a-z][a-z0-9]{0,15}\/files)$/, requests: 35,
    unit: [{ id: 'S15T21-UNIT-1', file: 'packages/render/src/edge/web-directives.test.ts', name: 'web stack directives renders saved Global Configuration, compression, DirectoryIndex order and memory limits' }],
    checks: ['TRAVERSAL-DIRECTORY-INDEX-REFUSED', 'DUPLICATE-DIRECTORY-INDEX-REFUSED', 'DIRECTORY-INDEX-PRIORITY-SWAPPED'],
    async run({ root, owner, fixture, site, tag, until, check, refused, undo }) {
      const before = await root.get('/api/server/settings')
      const origSettings = before.data?.settings
      const baseWeb = effectiveWeb(origSettings)
      refused('TRAVERSAL-DIRECTORY-INDEX-REFUSED', await root.put('/api/server/settings', {
        ...(origSettings ?? {}), web: { ...baseWeb, directoryIndex: ['../index.php'] },
      }), 'VALIDATION')
      refused('DUPLICATE-DIRECTORY-INDEX-REFUSED', await root.put('/api/server/settings', {
        ...(origSettings ?? {}), web: { ...baseWeb, directoryIndex: ['index.php', 'index.php'] },
      }), 'VALIDATION')
      if (before.status !== 200 || !origSettings) {
        check('DIRECTORY-INDEX-PRIORITY-SWAPPED', false, { status: before.status })
        return
      }
      undo('server web settings', async () => (await root.put('/api/server/settings', origSettings)).status === 200)
      const domRes = await owner.get('/api/domains')
      const dom = (domRes.data?.domains ?? [])[0]
      const home = domRes.data?.context?.home
      const rel = dom && typeof home === 'string' && typeof dom.docRoot === 'string' && dom.docRoot.startsWith(`${home}/`)
        ? dom.docRoot.slice(home.length + 1)
        : 'public_html'
      const sendFile = body => owner.post(`/api/accounts/${fixture.username}/files`, body)
      const subDir = `${rel}/xq-${tag}`
      undo('index priority folder', async () => {
        const item = await sendFile({ op: 'trash', path: subDir })
        if (item.status !== 200) return true
        return (await sendFile({ op: 'purge-trash', trashId: item.data?.id, originalPath: item.data?.originalPath, deletedAt: item.data?.deletedAt })).status === 200
      })
      await sendFile({ op: 'mkdir', path: subDir })
      await sendFile({ op: 'put-bytes', path: `${subDir}/index.php`, contentBase64: b64(`<?php echo 'PHP_${tag}';`) })
      await sendFile({ op: 'put-bytes', path: `${subDir}/index.html`, contentBase64: b64(`HTML_${tag}`) })
      const probeIndex = query => site.get(fixture.domain, `/xq-${tag}/?${query}`, { headers: { authorization: 'Bearer xq-nocache' } }).catch(() => ({ status: 0, text: '' }))
      const phpFirst = await root.put('/api/server/settings', {
        ...origSettings, web: { ...baseWeb, directoryIndex: ['index.php', 'index.html'] },
      })
      const firstProbe = await until(() => probeIndex('v=1'), hit => hit.status === 200 && hit.text.includes(`PHP_${tag}`), { attempts: 10, delayMs: 500 })
      const firstHit = firstProbe.last ?? { status: 0, text: '' }
      const htmlFirst = await root.put('/api/server/settings', {
        ...origSettings, web: { ...baseWeb, directoryIndex: ['index.html', 'index.php'] },
      })
      const secondProbe = await until(() => probeIndex('v=2'), hit => hit.status === 200 && hit.text.includes(`HTML_${tag}`), { attempts: 10, delayMs: 500 })
      const secondHit = secondProbe.last ?? { status: 0, text: '' }
      const restored = await root.put('/api/server/settings', origSettings)
      const trashed = await sendFile({ op: 'trash', path: subDir })
      if (trashed.status === 200) {
        await sendFile({ op: 'purge-trash', trashId: trashed.data?.id, originalPath: trashed.data?.originalPath, deletedAt: trashed.data?.deletedAt })
      }
      check('DIRECTORY-INDEX-PRIORITY-SWAPPED', phpFirst.status === 200 && htmlFirst.status === 200 && firstHit.status === 200 && firstHit.text.includes(`PHP_${tag}`) && secondHit.status === 200 && secondHit.text.includes(`HTML_${tag}`) && restored.status === 200, {
        phpFirstStatus: phpFirst.status, htmlFirstStatus: htmlFirst.status, firstServed: firstHit.status, secondServed: secondHit.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('web-config-includes', {
    prefix: 'S15T22', as: 'root', restores: ['/api/server/settings'], probe: '/api/server/settings',
    paths: /^\/api\/server\/settings$/, requests: 20,
    unit: [{ id: 'S15T22-UNIT-1', file: 'packages/render/src/edge/web-directives.test.ts', name: 'web stack directives places Include Editor text at its insertion points' }],
    checks: ['NUL-INCLUDE-BYTE-REFUSED', 'INVALID-NGINX-INCLUDE-ROLLED-BACK', 'COMMENT-INCLUDE-SAVED-AND-RESTORED'],
    async run({ root, tag, check, refused, undo }) {
      const before = await root.get('/api/server/settings')
      const origSettings = before.data?.settings
      const baseWeb = effectiveWeb(origSettings)
      refused('NUL-INCLUDE-BYTE-REFUSED', await root.put('/api/server/settings', {
        ...(origSettings ?? {}), web: { ...baseWeb, includes: { ...baseWeb.includes, nginxHttp: 'bad\0include' } },
      }), 'VALIDATION')
      refused('INVALID-NGINX-INCLUDE-ROLLED-BACK', await root.put('/api/server/settings', {
        ...(origSettings ?? {}), web: { ...baseWeb, includes: { ...baseWeb.includes, nginxHttp: 'bogus_unknown_directive on;' } },
      }), origSettings ? 'CONFIG_TEST_FAILED' : 'VALIDATION')
      if (before.status !== 200 || !origSettings) {
        check('COMMENT-INCLUDE-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('web config includes', async () => (await root.put('/api/server/settings', origSettings)).status === 200)
      const marker = `# xq-${tag}`
      const saved = await root.put('/api/server/settings', {
        ...origSettings, web: { ...baseWeb, includes: { ...baseWeb.includes, nginxHttp: marker } },
      })
      const restored = await root.put('/api/server/settings', origSettings)
      check('COMMENT-INCLUDE-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.settings?.web?.includes?.nginxHttp === marker && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('process-memory-limit', {
    prefix: 'S15T23', as: 'root', restores: ['/api/server/settings'], probe: '/api/server/settings',
    paths: /^\/api\/server\/settings$/, requests: 20,
    unit: [{ id: 'S15T23-UNIT-1', file: 'packages/core/src/server-web-settings.test.ts', name: 'server web settings refuses missing, unknown and out-of-range fields' }],
    checks: ['ZERO-MEMORY-LIMIT-REFUSED', 'FRACTIONAL-MEMORY-LIMIT-REFUSED', 'MEMORY-LIMIT-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/settings')
      const origSettings = before.data?.settings
      const baseWeb = effectiveWeb(origSettings)
      refused('ZERO-MEMORY-LIMIT-REFUSED', await root.put('/api/server/settings', {
        ...(origSettings ?? {}), web: { ...baseWeb, rlimitMemMb: 0 },
      }), 'VALIDATION')
      refused('FRACTIONAL-MEMORY-LIMIT-REFUSED', await root.put('/api/server/settings', {
        ...(origSettings ?? {}), web: { ...baseWeb, rlimitMemMb: 1.5 },
      }), 'VALIDATION')
      if (before.status !== 200 || !origSettings) {
        check('MEMORY-LIMIT-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('process memory limit', async () => (await root.put('/api/server/settings', origSettings)).status === 200)
      const saved = await root.put('/api/server/settings', {
        ...origSettings, web: { ...baseWeb, rlimitMemMb: 512, rlimitCpuSec: 240 },
      })
      const restored = await root.put('/api/server/settings', origSettings)
      check('MEMORY-LIMIT-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.settings?.web?.rlimitMemMb === 512 && restored.status === 200, {
        savedStatus: saved.status, rlimitMemMb: saved.data?.settings?.web?.rlimitMemMb ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('web-log-rotation', {
    prefix: 'S15T24', as: 'root', probe: '/api/server/settings',
    paths: /^\/api\/server\/(?:settings|logs\/(?:retention(?:\?x=1)?|raw\/nginx(?:\/shadow)?))$/, requests: 15,
    unit: [{ id: 'S15T24-UNIT-1', file: 'apps/agent/src/log-rotation.test.ts', name: 'raw access log rotation after metering rotates once per UTC day, only while the meter follows the file, and verifies that nginx reopened it' }],
    checks: ['RETENTION-AND-RAW-NGINX-READ', 'RETENTION-SELECTOR-REFUSED', 'TRAVERSAL-RAW-LOG-NOT-FOUND'],
    async run({ root, check, refused }) {
      const [ret, raw] = await Promise.all([
        root.get('/api/server/logs/retention'),
        root.get('/api/server/logs/raw/nginx'),
      ])
      check('RETENTION-AND-RAW-NGINX-READ', ret.status === 200 && typeof ret.data?.panelRotateDays === 'number' && raw.status === 200 && Array.isArray(raw.data?.files), {
        retentionStatus: ret.status, rawStatus: raw.status,
      })
      refused('RETENTION-SELECTOR-REFUSED', await root.get('/api/server/logs/retention?x=1'), 'VALIDATION')
      refused('TRAVERSAL-RAW-LOG-NOT-FOUND', await root.get('/api/server/logs/raw/nginx/shadow'), 'NOT_FOUND')
    },
  }),

  tool('piped-logging', {
    prefix: 'S15T25', as: 'root', needs: ['account'], probe: '/api/server/settings',
    paths: /^\/api\/server\/settings$/, requests: 15,
    unit: [{ id: 'S15T25-UNIT-1', file: 'packages/render/src/edge/apache.test.ts', name: 'renderApacheBase trusts Nginx on loopback for the client IP and HTTPS flag' }],
    checks: ['NO-PIPED-LOGGING-SETTING', 'UNKNOWN-PIPED-FIELD-REFUSED', 'EDGE-SERVES-DOMAIN-DIRECTLY'],
    async run({ root, fixture, site, check, refused }) {
      const view = await root.get('/api/server/settings')
      const baseWeb = effectiveWeb(view.data?.settings)
      check('NO-PIPED-LOGGING-SETTING', view.status === 200 && Boolean(view.data?.settings) && !Object.hasOwn(view.data?.settings?.web ?? {}, 'pipedLogging'), {
        status: view.status,
      })
      refused('UNKNOWN-PIPED-FIELD-REFUSED', await root.put('/api/server/settings', {
        ...(view.data?.settings ?? {}), web: { ...baseWeb, pipedLogging: true },
      }), 'VALIDATION')
      const served = await site.get(fixture.domain, '/').catch(() => ({ status: 0 }))
      check('EDGE-SERVES-DOMAIN-DIRECTLY', served.status >= 200 && served.status < 500, {
        status: served.status,
      })
    },
  }),

  tool('panel-log-rotation', {
    prefix: 'S15T26', as: 'root', needs: ['account'], probe: '/api/server/logs/retention',
    paths: /^\/api\/server\/(?:logs\/retention|tweak-settings)$/, requests: 25,
    unit: [{ id: 'S15T26-UNIT-1', file: 'packages/render/src/extended/extended.test.ts', name: '1. First-Run Setup, Hostname Change & Filesystem Quota Initialization renderLogrotateConfig rotates error, backend and PHP-FPM logs but never the metered site access logs' }],
    checks: ['ZERO-PANEL-ROTATE-DAYS-REFUSED', 'STALE-PANEL-ROTATE-CONFLICT', 'PANEL-ROTATE-DAYS-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/tweak-settings')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origValues = before.data?.values ? structuredClone(before.data.values) : null
      refused('ZERO-PANEL-ROTATE-DAYS-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(origValues ?? {}), 'logs.panelRotateDays': 0 }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-PANEL-ROTATE-CONFLICT', await root.put('/api/server/tweak-settings', {
        values: origValues ?? {}, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || !origValues || typeof before.data?.revision !== 'string') {
        check('PANEL-ROTATE-DAYS-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('panel log rotation days', async () => {
        const now = await root.get('/api/server/tweak-settings')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.values, origValues)) return true
        return (await root.put('/api/server/tweak-settings', { values: origValues, expectedRevision: now.data.revision })).status === 200
      })
      const nextDays = origValues['logs.panelRotateDays'] === 21 ? 28 : 21
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...origValues, 'logs.panelRotateDays': nextDays }, expectedRevision: rev,
      })
      const ret = await root.get('/api/server/logs/retention')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values: origValues, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('PANEL-ROTATE-DAYS-SAVED-AND-RESTORED', saved.status === 200 && ret.status === 200 && ret.data?.panelRotateDays === nextDays && restored.status === 200, {
        savedStatus: saved.status, panelRotateDays: ret.data?.panelRotateDays ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('webdisk-tls', {
    prefix: 'S15T27', as: 'root', probe: '/api/server/sec/webdisk-tls',
    paths: /^\/api\/server\/sec\/webdisk-tls$/, requests: 25,
    unit: [{ id: 'S15T27-UNIT-1', file: 'apps/agent/src/mail-cert-policy.test.ts', name: 'Web Disk TLS policy keeps the defaults and orders the protocols' }],
    checks: ['LEGACY-TLS10-WEBDISK-REFUSED', 'WEAK-RC4-WEBDISK-REFUSED', 'STALE-WEBDISK-TLS-CONFLICT', 'WEBDISK-TLS-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/sec/webdisk-tls')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origPolicy = before.data?.policy ?? { protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'ECDHE+AESGCM' }
      refused('LEGACY-TLS10-WEBDISK-REFUSED', await root.put('/api/server/sec/webdisk-tls', {
        policy: { protocols: ['TLSv1', 'TLSv1.2'], ciphers: 'ECDHE+AESGCM' }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('WEAK-RC4-WEBDISK-REFUSED', await root.put('/api/server/sec/webdisk-tls', {
        policy: { protocols: ['TLSv1.2'], ciphers: 'RC4-SHA:MD5' }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-WEBDISK-TLS-CONFLICT', await root.put('/api/server/sec/webdisk-tls', {
        policy: origPolicy, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || !before.data?.policy || typeof before.data?.revision !== 'string') {
        check('WEBDISK-TLS-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('webdisk tls policy', async () => {
        const now = await root.get('/api/server/sec/webdisk-tls')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.policy, origPolicy)) return true
        return (await root.put('/api/server/sec/webdisk-tls', { policy: origPolicy, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/server/sec/webdisk-tls', {
        policy: { protocols: ['TLSv1.3'], ciphers: origPolicy.ciphers }, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/sec/webdisk-tls', { policy: origPolicy, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('WEBDISK-TLS-SAVED-AND-RESTORED', saved.status === 200 && same(saved.data?.policy?.protocols, ['TLSv1.3']) && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('panel-web-tls', {
    prefix: 'S15T28', as: 'root', probe: '/api/server/panel-tls',
    paths: /^\/api\/server\/panel-tls$/, restores: ['/api/server/panel-tls'], requests: 20,
    unit: [{ id: 'S15T28-UNIT-1', file: 'packages/core/src/server-operations.test.ts', name: 'server operation rules validates the panel TLS policy' }],
    checks: ['PANEL-TLS-POLICY-READ', 'LEGACY-TLS11-PANEL-REFUSED', 'INJECTED-CIPHER-SYNTAX-REFUSED', 'BOGUS-OPENSSL-CIPHER-ROLLED-BACK'],
    async run({ root, check, refused, undo }) {
      const view = await root.get('/api/server/panel-tls')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      const origPolicy = view.data?.policy
      if (view.status === 200 && Array.isArray(origPolicy?.protocols) && typeof origPolicy?.ciphers === 'string') {
        undo('panel-web-tls', async () => {
          const cur = await root.get('/api/server/panel-tls')
          if (cur.status !== 200) return false
          if (same(cur.data?.policy, origPolicy)) return true
          return (await root.put('/api/server/panel-tls', {
            protocols: origPolicy.protocols, ciphers: origPolicy.ciphers, expectedRevision: cur.data.revision,
          })).status === 200
        })
      }
      check('PANEL-TLS-POLICY-READ', view.status === 200 && Array.isArray(view.data?.policy?.protocols) && typeof view.data?.policy?.ciphers === 'string', {
        status: view.status, protocols: view.data?.policy?.protocols ?? null,
      })
      refused('LEGACY-TLS11-PANEL-REFUSED', await root.put('/api/server/panel-tls', {
        protocols: ['TLSv1.1'], ciphers: 'HIGH:!aNULL:!MD5', expectedRevision: rev,
      }), 'VALIDATION')
      refused('INJECTED-CIPHER-SYNTAX-REFUSED', await root.put('/api/server/panel-tls', {
        protocols: ['TLSv1.2'], ciphers: 'HIGH; include /etc/hosts', expectedRevision: rev,
      }), 'VALIDATION')
      refused('BOGUS-OPENSSL-CIPHER-ROLLED-BACK', await root.put('/api/server/panel-tls', {
        protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'NOT_A_REAL_OPENSSL_CIPHER_NAME', expectedRevision: rev,
      }), 'CONFIG_TEST_FAILED')
    },
  }),

  tool('mta-basic-editor', {
    prefix: 'S15T29', as: 'root', probe: '/api/server/mail-server/server',
    paths: /^\/api\/server\/(?:mail-server\/server|mailx\/server(?:\/preview)?)$/, requests: 20,
    unit: [{ id: 'S15T29-UNIT-1', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server settings and routing policy previews the exact rendered change, then saves and applies it with the changed keys in the audit' }],
    checks: ['SUBMISSION-TLS-AUTH-OBSERVED', 'OWNED-MILTER-KEY-REFUSED', 'OPEN-RELAY-NETWORKS-REFUSED', 'MTA-BASIC-DIFF-PREVIEWED'],
    async run({ root, check, refused }) {
      const [observed, mailx] = await Promise.all([
        root.get('/api/server/mail-server/server'),
        root.get('/api/server/mailx/server'),
      ])
      const rev = typeof mailx.data?.revision === 'string' ? mailx.data.revision : ZERO_REV
      const basePolicy = mailx.data?.policy ?? { postfix: {}, dovecot: {}, rbl: null, certificates: { smtp: null, submission: null, imap: null } }
      check('SUBMISSION-TLS-AUTH-OBSERVED', observed.status === 200 && Array.isArray(observed.data?.services) && mailx.status === 200, {
        observedStatus: observed.status, mailxStatus: mailx.status,
      })
      refused('OWNED-MILTER-KEY-REFUSED', await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, postfix: { ...(basePolicy.postfix ?? {}), smtpd_milters: 'inet:127.0.0.1:9999' } },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('OPEN-RELAY-NETWORKS-REFUSED', await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, postfix: { ...(basePolicy.postfix ?? {}), mynetworks: '0.0.0.0/0' } },
        expectedRevision: rev,
      }), 'VALIDATION')
      const preview = await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, postfix: { ...(basePolicy.postfix ?? {}), smtpd_helo_required: 'yes' } },
        expectedRevision: rev,
      })
      check('MTA-BASIC-DIFF-PREVIEWED', preview.status === 200 && Array.isArray(preview.data?.changes), {
        status: preview.status, changes: Array.isArray(preview.data?.changes) ? preview.data.changes.length : null,
      })
    },
  }),

  tool('mta-config-manager', {
    prefix: 'S15T30', as: 'root', probe: '/api/server/mail-server/server',
    paths: new RegExp(String.raw`^\/api\/server\/(?:mail-server\/server|mailx\/advanced|mailx-config\/(?:backups(?:\/${ID})?|restore|reset))$`), requests: 25,
    unit: [{ id: 'S15T30-UNIT-1', file: 'apps/api/src/mailx-config-workspace.test.ts', name: 'mail configuration backups backup, change, then restore gives back the generated configuration byte for byte' }],
    checks: ['PRIVILEGED-POSTFIX-KEY-REFUSED', 'INVALID-RESET-TYPE-REFUSED', 'ABSENT-BACKUP-RESTORE-NOT-FOUND', 'BACKUP-CHANGE-RESTORE-BYTE-IDENTICAL'],
    async run({ root, check, refused, undo }) {
      const [adv, bks] = await Promise.all([
        root.get('/api/server/mailx/advanced'),
        root.get('/api/server/mailx-config/backups'),
      ])
      const advRev = typeof adv.data?.revision === 'string' ? adv.data.revision : ZERO_REV
      const compRev = typeof bks.data?.compositeRevision === 'string' ? bks.data.compositeRevision : ZERO_REV
      refused('PRIVILEGED-POSTFIX-KEY-REFUSED', await root.put('/api/server/mailx/advanced', {
        policy: { postfix: { mailbox_command: '/bin/sh' } }, expectedRevision: advRev,
      }), 'VALIDATION')
      refused('INVALID-RESET-TYPE-REFUSED', await root.post('/api/server/mailx-config/reset', {
        type: 'acls', expectedRevision: compRev,
      }), 'VALIDATION')
      refused('ABSENT-BACKUP-RESTORE-NOT-FOUND', await root.post('/api/server/mailx-config/restore', {
        backup: '11111111-1111-4111-8111-111111111111', expectedRevision: compRev,
      }), 'NOT_FOUND')
      if (adv.status !== 200 || bks.status !== 200 || typeof adv.data?.revision !== 'string') {
        check('BACKUP-CHANGE-RESTORE-BYTE-IDENTICAL', false, { advStatus: adv.status, bksStatus: bks.status })
        return
      }
      const created = await root.post('/api/server/mailx-config/backups', {})
      const backupId = created.data?.backup?.id
      const origFp = created.data?.backup?.fingerprint
      if (typeof backupId !== 'string' || typeof origFp !== 'string') {
        check('BACKUP-CHANGE-RESTORE-BYTE-IDENTICAL', false, { createdStatus: created.status })
        return
      }
      undo('mailx config backup restore', async () => {
        const cur = await root.get('/api/server/mailx-config/backups')
        if (cur.status !== 200 || typeof cur.data?.compositeRevision !== 'string') return false
        if (cur.data?.fingerprint === origFp) return true
        return (await root.post('/api/server/mailx-config/restore', {
          backup: backupId, expectedRevision: cur.data.compositeRevision,
        })).status === 200
      })
      const curTimeout = adv.data?.policy?.postfix?.smtp_connect_timeout
      const nextTimeout = curTimeout === '25s' ? '20s' : '25s'
      const changed = await root.put('/api/server/mailx/advanced', {
        policy: { postfix: { ...(adv.data?.policy?.postfix ?? {}), smtp_connect_timeout: nextTimeout } },
        expectedRevision: advRev,
      })
      const afterChange = await root.get('/api/server/mailx-config/backups')
      const restored = typeof afterChange.data?.compositeRevision === 'string'
        ? await root.post('/api/server/mailx-config/restore', { backup: backupId, expectedRevision: afterChange.data.compositeRevision })
        : { status: 0, data: null }
      check('BACKUP-CHANGE-RESTORE-BYTE-IDENTICAL', changed.status === 200 && afterChange.status === 200 && afterChange.data?.fingerprint !== origFp && restored.status === 200 && restored.data?.fingerprint === origFp, {
        changedStatus: changed.status, restoredStatus: restored.status, byteIdentical: restored.data?.fingerprint === origFp,
      })
    },
  }),

  tool('ftp-server-config', {
    prefix: 'S15T31', as: 'root', probe: '/api/server/ftp/settings',
    paths: /^\/api\/server\/(?:ftp\/settings|services\/ftp)$/, requests: 25,
    unit: [{ id: 'S15T31-UNIT-1', file: 'apps/agent/src/ftp-server.test.ts', name: 'FTP server settings refuses cleartext-only FTP, an inverted port range and uploads without anonymous logins' }],
    checks: ['CLEARTEXT-FTP-REFUSED', 'INVERTED-PASSIVE-PORTS-REFUSED', 'ANON-UPLOAD-WITHOUT-LOGIN-REFUSED', 'FTP-SETTINGS-APPLIED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/ftp/settings')
      const cur = before.data?.settings ?? {
        enabled: true, tls: 'required', tlsCipherSuite: 'HIGH:!aNULL:!MD5',
        anonymous: false, anonymousUploads: false, maxIdleMinutes: 15,
        maxConnections: 50, maxConnectionsPerIp: 8, passivePorts: { min: 49152, max: 65534 },
        brokenClients: false, listingLimit: 10000,
      }
      refused('CLEARTEXT-FTP-REFUSED', await root.put('/api/server/ftp/settings', {
        settings: { ...cur, tls: 'disabled' },
      }), 'VALIDATION')
      refused('INVERTED-PASSIVE-PORTS-REFUSED', await root.put('/api/server/ftp/settings', {
        settings: { ...cur, passivePorts: { min: 40000, max: 30000 } },
      }), 'VALIDATION')
      refused('ANON-UPLOAD-WITHOUT-LOGIN-REFUSED', await root.put('/api/server/ftp/settings', {
        settings: { ...cur, anonymous: false, anonymousUploads: true },
      }), 'VALIDATION')
      if (before.status !== 200 || !before.data?.settings) {
        check('FTP-SETTINGS-APPLIED-AND-RESTORED', false, { status: before.status })
        return
      }
      const origSettings = structuredClone(before.data.settings)
      undo('ftp server settings', async () => (await root.put('/api/server/ftp/settings', { settings: origSettings })).status === 200)
      const nextPerIp = origSettings.maxConnectionsPerIp === 2 ? 3 : 2
      const saved = await root.put('/api/server/ftp/settings', {
        settings: { ...origSettings, maxConnectionsPerIp: nextPerIp, tls: 'required' },
      })
      const detail = await root.get('/api/server/services/ftp')
      const restored = await root.put('/api/server/ftp/settings', { settings: origSettings })
      check('FTP-SETTINGS-APPLIED-AND-RESTORED', saved.status === 200 && saved.data?.settings?.maxConnectionsPerIp === nextPerIp && detail.status === 200 && restored.status === 200, {
        savedStatus: saved.status, detailStatus: detail.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('ftp-server-selection', {
    prefix: 'S15T32', as: 'root', restores: ['/api/server/service-selection'], probe: '/api/server/service-selection',
    paths: new RegExp(String.raw`^\/api\/(?:server\/(?:service-selection|services\/ftp)|jobs\/${ID})$`), requests: 40,
    unit: [{ id: 'S15T32-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations offers only a disable option beside the one DNS and FTP daemon' }],
    checks: ['UNSUPPORTED-FTP-DAEMON-REFUSED', 'UNCHANGED-FTP-SELECTION-REFUSED', 'STALE-FTP-SELECTION-CONFLICT', 'FTP-DISABLED-AND-REENABLED'],
    async run({ root, check, refused, undo, until }) {
      const before = await root.get('/api/server/service-selection')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origState = before.data?.state ?? { dnsServer: 'powerdns', ftpServer: 'pure-ftpd' }
      refused('UNSUPPORTED-FTP-DAEMON-REFUSED', await root.put('/api/server/service-selection', {
        dnsServer: origState.dnsServer, ftpServer: 'proftpd', expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNCHANGED-FTP-SELECTION-REFUSED', await root.put('/api/server/service-selection', {
        dnsServer: origState.dnsServer, ftpServer: origState.ftpServer, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-FTP-SELECTION-CONFLICT', await root.put('/api/server/service-selection', {
        dnsServer: origState.dnsServer, ftpServer: origState.ftpServer === 'disabled' ? 'pure-ftpd' : 'disabled', expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || !before.data?.state || typeof before.data?.revision !== 'string') {
        check('FTP-DISABLED-AND-REENABLED', false, { status: before.status })
        return
      }
      const waitJob = async res => {
        const jid = res.data?.job?.id
        if (typeof jid !== 'string') return true
        const settled = await until(() => root.get(`/api/jobs/${jid}`), r => ['succeeded', 'failed', 'cancelled'].includes(r.data?.job?.status), { attempts: 12, delayMs: 1000 })
        return settled.settled && settled.last?.data?.job?.status === 'succeeded'
      }
      undo('ftp service selection', async () => {
        const now = await root.get('/api/server/service-selection')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.state?.ftpServer === origState.ftpServer && now.data?.state?.dnsServer === origState.dnsServer) return true
        const putRes = await root.put('/api/server/service-selection', {
          dnsServer: origState.dnsServer, ftpServer: origState.ftpServer, expectedRevision: now.data.revision,
        })
        if (![200, 202].includes(putRes.status)) return false
        return waitJob(putRes)
      })
      const targetFtp = origState.ftpServer === 'disabled' ? 'pure-ftpd' : 'disabled'
      const switched = await root.put('/api/server/service-selection', {
        dnsServer: origState.dnsServer, ftpServer: targetFtp, expectedRevision: rev,
      })
      const switchDone = [200, 202].includes(switched.status) && await waitJob(switched)
      const mid = await root.get('/api/server/service-selection')
      const restored = typeof mid.data?.revision === 'string'
        ? await root.put('/api/server/service-selection', {
            dnsServer: origState.dnsServer, ftpServer: origState.ftpServer, expectedRevision: mid.data.revision,
          })
        : { status: 0, data: null }
      const restoreDone = [200, 202].includes(restored.status) && await waitJob(restored)
      check('FTP-DISABLED-AND-REENABLED', switchDone && (switched.data?.state?.ftpServer ?? mid.data?.state?.ftpServer) === targetFtp && restoreDone, {
        switchedStatus: switched.status, targetFtp, restoredStatus: restored.status,
      })
    },
  }),

  tool('mailbox-server-config', {
    prefix: 'S15T33', as: 'root', probe: '/api/server/mail-server/server',
    paths: /^\/api\/server\/(?:mail-server\/server|mailx\/server(?:\/preview)?)$/, requests: 20,
    unit: [{ id: 'S15T33-UNIT-1', file: 'apps/agent/src/mailx-policy.test.ts', name: 'server settings and routing policy renders derived Postfix keys, the port 25 certificate and the Dovecot file only for saved sections' }],
    checks: ['MISSING-LMTP-PROTOCOL-REFUSED', 'UNIMPLEMENTED-DOVECOT-KEY-REFUSED', 'INJECTED-DOVECOT-CIPHER-REFUSED', 'DOVECOT-POP3-DISABLE-PREVIEWED'],
    async run({ root, check, refused }) {
      const mailx = await root.get('/api/server/mailx/server')
      const rev = typeof mailx.data?.revision === 'string' ? mailx.data.revision : ZERO_REV
      const basePolicy = mailx.data?.policy ?? { postfix: {}, dovecot: {}, rbl: null, certificates: { smtp: null, submission: null, imap: null } }
      refused('MISSING-LMTP-PROTOCOL-REFUSED', await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, dovecot: { ...(basePolicy.dovecot ?? {}), protocols: 'imap' } },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNIMPLEMENTED-DOVECOT-KEY-REFUSED', await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, dovecot: { ...(basePolicy.dovecot ?? {}), mail_max_userip_connections: '5' } },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('INJECTED-DOVECOT-CIPHER-REFUSED', await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, dovecot: { ...(basePolicy.dovecot ?? {}), ssl_cipher_list: 'HIGH;rm -rf' } },
        expectedRevision: rev,
      }), 'VALIDATION')
      const preview = await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, dovecot: { ...(basePolicy.dovecot ?? {}), protocols: 'imap lmtp', ssl_min_protocol: 'TLSv1.2' } },
        expectedRevision: rev,
      })
      check('DOVECOT-POP3-DISABLE-PREVIEWED', preview.status === 200 && Array.isArray(preview.data?.changes), {
        status: preview.status, changes: Array.isArray(preview.data?.changes) ? preview.data.changes.length : null,
      })
    },
  }),
]
