import { tool } from './kit.mjs'

const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const ZERO_REV = '0'.repeat(64)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOST_ID_RE = /^[a-z0-9]{12}$/

const uuidOrZero = value => (typeof value === 'string' && UUID_RE.test(value) ? value : ZERO_UUID)
const revOf = value => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : ZERO_REV)
const hostIdOrZero = value => (typeof value === 'string' && HOST_ID_RE.test(value) ? value : '000000000000')

const PLUGIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect x="4" y="4" width="40" height="40" fill="#2563eb"/></svg>'
const PLUGIN_ICON_B64 = Buffer.from(PLUGIN_SVG, 'utf8').toString('base64')

export default [
  tool('aapanel-docker-container-detail', {
    prefix: 'S19T01', as: 'root', probe: '/api/server/software/containers/scope',
    paths: /^\/api\/server\/software\/containers\/(?:scope|detail\?unknown=1|op)$/,
    unit: [{ id: 'S19T01-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container routes builds a plan whose policy, revalidation and verification bind to the observed container' }],
    checks: ['HOST-CONTAINERS-SCOPE-OBSERVED', 'DETAIL-UNKNOWN-SELECTOR-VALIDATION', 'RESTART-POLICY-ENUM-VALIDATION', 'COMMIT-SHORT-ID-VALIDATION'],
    async run({ root, check, refused }) {
      const scope = await root.get('/api/server/software/containers/scope')
      const rev = revOf(scope.data?.revision)
      check('HOST-CONTAINERS-SCOPE-OBSERVED', scope.status === 200 && scope.data?.scope === 'host' && ['read', 'unavailable'].includes(scope.data?.state) && Array.isArray(scope.data?.stats), { status: scope.status, state: scope.data?.state ?? null, stats: Array.isArray(scope.data?.stats) ? scope.data.stats.length : null })
      refused('DETAIL-UNKNOWN-SELECTOR-VALIDATION', await root.get('/api/server/software/containers/detail?unknown=1'), 'VALIDATION')
      refused('RESTART-POLICY-ENUM-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'stack.restart-policy', name: 'demo', service: 'web', restart: 'invalid' },
      }), 'VALIDATION')
      refused('COMMIT-SHORT-ID-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'container.commit', id: 'short-id', tag: 'demo:v1' },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-images', {
    prefix: 'S19T02', as: 'root', probe: '/api/server/software/containers/engine',
    paths: /^\/api\/server\/software\/containers\/(?:engine|search\?unknown=1|op)$/,
    unit: [{ id: 'S19T02-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container engine parsers normalizes podman arrays and docker JSON lines' }],
    checks: ['CONTAINER-IMAGES-INVENTORY-OBSERVED', 'IMAGE-SEARCH-SELECTOR-VALIDATION', 'IMAGE-REMOVE-ID-VALIDATION'],
    async run({ root, check, refused }) {
      const engine = await root.get('/api/server/software/containers/engine')
      const rev = revOf(engine.data?.revision)
      check('CONTAINER-IMAGES-INVENTORY-OBSERVED', engine.status === 200 && ['read', 'unavailable'].includes(engine.data?.state) && Array.isArray(engine.data?.engines) && engine.data.engines.every(e => Array.isArray(e.images)), { status: engine.status, state: engine.data?.state ?? null, engines: Array.isArray(engine.data?.engines) ? engine.data.engines.length : null })
      refused('IMAGE-SEARCH-SELECTOR-VALIDATION', await root.get('/api/server/software/containers/search?unknown=1'), 'VALIDATION')
      refused('IMAGE-REMOVE-ID-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'image.remove', id: 'not-64-hex' },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-compose', {
    prefix: 'S19T03', as: 'root', probe: '/api/server/software/containers/policy',
    paths: /^\/api\/server\/software\/containers\/(?:policy|scope|op)$/,
    unit: [{ id: 'S19T03-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container routes enforces root, strict bodies, the observed revision and an admitted state transition' }],
    checks: ['COMPOSE-TEMPLATES-POLICY-OBSERVED', 'COMPOSE-STACKS-SCOPE-OBSERVED', 'INVALID-STACK-YAML-VALIDATION', 'INVALID-STACK-NAME-VALIDATION'],
    async run({ root, check, refused }) {
      const policy = await root.get('/api/server/software/containers/policy')
      check('COMPOSE-TEMPLATES-POLICY-OBSERVED', policy.status === 200 && typeof policy.data?.revision === 'string' && Array.isArray(policy.data?.templates) && typeof policy.data?.stackPath === 'string', { status: policy.status, templates: Array.isArray(policy.data?.templates) ? policy.data.templates.length : null })
      const scope = await root.get('/api/server/software/containers/scope')
      const rev = revOf(scope.data?.revision)
      check('COMPOSE-STACKS-SCOPE-OBSERVED', scope.status === 200 && Array.isArray(scope.data?.stacks), { status: scope.status, stacks: Array.isArray(scope.data?.stacks) ? scope.data.stacks.length : null })
      refused('INVALID-STACK-YAML-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'stack.save', name: 'demo', yaml: 'services:\u0000broken', env: null, notes: '', template: null },
      }), 'VALIDATION')
      refused('INVALID-STACK-NAME-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'stack.save', name: 'BAD_STACK', yaml: 'services:\n  web:\n    image: nginx:alpine\n', env: null, notes: '', template: null },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-networks', {
    prefix: 'S19T04', as: 'root', probe: '/api/server/software/containers/engine',
    paths: /^\/api\/server\/software\/containers\/(?:engine|scope|op)$/,
    unit: [{ id: 'S19T04-UNIT-1', file: 'apps/web/src/sw-containers-client.test.ts', name: 'container workspaces paints engine facts, images, registries and networks while every engine write stays disabled' }],
    checks: ['ENGINE-NETWORKS-OBSERVED', 'SCOPE-NETWORKS-OBSERVED', 'NETWORK-CREATE-NAME-VALIDATION'],
    async run({ root, check, refused }) {
      const engine = await root.get('/api/server/software/containers/engine')
      check('ENGINE-NETWORKS-OBSERVED', engine.status === 200 && Array.isArray(engine.data?.engines) && engine.data.engines.every(e => Array.isArray(e.networks)), { status: engine.status, engines: Array.isArray(engine.data?.engines) ? engine.data.engines.length : null })
      const scope = await root.get('/api/server/software/containers/scope')
      const rev = revOf(scope.data?.revision)
      check('SCOPE-NETWORKS-OBSERVED', scope.status === 200 && Array.isArray(scope.data?.networks), { status: scope.status, networks: Array.isArray(scope.data?.networks) ? scope.data.networks.length : null })
      refused('NETWORK-CREATE-NAME-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'network.create', name: 'BAD_NET', subnet: null, gateway: null, range: null, ipv6Subnet: null, labels: [] },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-volumes', {
    prefix: 'S19T05', as: 'root', probe: '/api/server/software/containers/engine',
    paths: /^\/api\/server\/software\/containers\/(?:engine|scope|op)$/,
    unit: [{ id: 'S19T05-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container engine parsers refuses malformed, duplicate, oversized or injected engine output' }],
    checks: ['ENGINE-VOLUMES-OBSERVED', 'SCOPE-VOLUMES-OBSERVED', 'VOLUME-CREATE-CONTROL-VALIDATION'],
    async run({ root, check, refused }) {
      const engine = await root.get('/api/server/software/containers/engine')
      check('ENGINE-VOLUMES-OBSERVED', engine.status === 200 && Array.isArray(engine.data?.engines) && engine.data.engines.every(e => Array.isArray(e.volumes)), { status: engine.status, engines: Array.isArray(engine.data?.engines) ? engine.data.engines.length : null })
      const scope = await root.get('/api/server/software/containers/scope')
      const rev = revOf(scope.data?.revision)
      check('SCOPE-VOLUMES-OBSERVED', scope.status === 200 && Array.isArray(scope.data?.volumes), { status: scope.status, volumes: Array.isArray(scope.data?.volumes) ? scope.data.volumes.length : null })
      refused('VOLUME-CREATE-CONTROL-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'volume.create', name: 'bad\u0000vol', options: [], labels: [] },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-registries', {
    prefix: 'S19T06', as: 'root', probe: '/api/server/software/containers/policy',
    paths: /^\/api\/server\/software\/containers\/(?:policy|scope|op)$/,
    unit: [{ id: 'S19T06-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container routes reads present engines, marks absent ones and never claims unavailable output as read' }],
    checks: ['REGISTRY-TRUST-POLICY-OBSERVED', 'ACCOUNT-REGISTRY-LOGINS-OBSERVED', 'POLICY-SAVE-REVISION-VALIDATION', 'EMPTY-REGISTRY-CREDENTIAL-VALIDATION'],
    async run({ root, check, refused }) {
      const policy = await root.get('/api/server/software/containers/policy')
      check('REGISTRY-TRUST-POLICY-OBSERVED', policy.status === 200 && typeof policy.data?.revision === 'string' && Array.isArray(policy.data?.registries), { status: policy.status, registries: Array.isArray(policy.data?.registries) ? policy.data.registries.length : null })
      const scope = await root.get('/api/server/software/containers/scope')
      const rev = revOf(scope.data?.revision)
      check('ACCOUNT-REGISTRY-LOGINS-OBSERVED', scope.status === 200 && Array.isArray(scope.data?.logins), { status: scope.status, logins: Array.isArray(scope.data?.logins) ? scope.data.logins.length : null })
      refused('POLICY-SAVE-REVISION-VALIDATION', await root.post('/api/server/software/containers/policy', { policy: { registries: [] } }), 'VALIDATION')
      refused('EMPTY-REGISTRY-CREDENTIAL-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'registry.login', host: 'docker.io', username: 'alice', password: '' },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-settings', {
    prefix: 'S19T07', as: 'root', probe: '/api/server/software/containers/engine',
    paths: /^\/api\/server\/software\/containers\/(?:engine|policy|op)$/,
    unit: [{ id: 'S19T07-UNIT-1', file: 'apps/web/src/sw-containers-client.test.ts', name: 'container workspaces reads containers, keeps absent engines honest and submits a confirmed lifecycle job once' }],
    checks: ['DAEMONLESS-ENGINE-SETTINGS-OBSERVED', 'REGISTRIES-CONFIG-PATH-OBSERVED', 'ENGINE-REPAIR-EXTRA-FIELD-VALIDATION'],
    async run({ root, check, refused }) {
      const engine = await root.get('/api/server/software/containers/engine')
      const rev = revOf(engine.data?.revision)
      check('DAEMONLESS-ENGINE-SETTINGS-OBSERVED', engine.status === 200 && engine.data?.actions?.daemonWrite === false && Array.isArray(engine.data?.engines) && engine.data.engines.every(e => e.facts === null || Array.isArray(e.facts?.registries)), { status: engine.status, daemonWrite: engine.data?.actions?.daemonWrite ?? null })
      const policy = await root.get('/api/server/software/containers/policy')
      check('REGISTRIES-CONFIG-PATH-OBSERVED', policy.status === 200 && typeof policy.data?.configPath === 'string' && Array.isArray(policy.data?.registries), { status: policy.status, configPath: policy.data?.configPath ?? null })
      refused('ENGINE-REPAIR-EXTRA-FIELD-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: 'xqacct', expectedRevision: rev, action: { op: 'engine.repair', daemon: 'restart' },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-system-monitor', {
    prefix: 'S19T08', as: 'root', probe: '/api/server/monitoring/performance',
    paths: /^\/api\/server\/monitoring\/performance(?:\?window=(?:1h|24h|7d|30d))?$/,
    unit: [{ id: 'S19T08-UNIT-1', file: 'apps/api/src/monitoring-workspace.test.ts', name: 'host performance history downsamples into fixed buckets with gaps, averages and maxima' }],
    checks: ['HOUR-WINDOW-SERIES-OBSERVED', 'DAY-AND-WEEK-WINDOWS-OBSERVED', 'UNSUPPORTED-WINDOW-VALIDATION'],
    async run({ root, check, refused }) {
      const oneHour = await root.get('/api/server/monitoring/performance')
      check('HOUR-WINDOW-SERIES-OBSERVED', oneHour.status === 200 && ['read', 'unavailable'].includes(oneHour.data?.state) && oneHour.data?.window === '1h' && Array.isArray(oneHour.data?.points), { status: oneHour.status, state: oneHour.data?.state ?? null, points: Array.isArray(oneHour.data?.points) ? oneHour.data.points.length : null })
      const day = await root.get('/api/server/monitoring/performance?window=24h')
      const week = await root.get('/api/server/monitoring/performance?window=7d')
      check('DAY-AND-WEEK-WINDOWS-OBSERVED', day.status === 200 && day.data?.window === '24h' && week.status === 200 && week.data?.window === '7d', { dayStatus: day.status, weekStatus: week.status })
      refused('UNSUPPORTED-WINDOW-VALIDATION', await root.get('/api/server/monitoring/performance?window=30d'), 'VALIDATION')
    },
  }),

  tool('aapanel-mail-bcc', {
    prefix: 'S19T09', as: 'root', probe: '/api/server/mailx/bcc',
    page: { route: '/whm/email/bcc', read: '/api/server/mailx/bcc', shows: () => ['Mail BCC copies'] },
    paths: /^\/api\/server\/mailx\/bcc$/,
    unit: [{ id: 'S19T09-UNIT-1', file: 'apps/api/src/completion-security-email-filters.test.ts', name: 'mail-filter configuration HTTP security acceptance with disposable state reads deterministic revisions without allocating state and binds even empty revisions to their context' }],
    checks: ['BCC-POLICY-OBSERVED', 'SELF-COPY-LOOP-VALIDATION', 'INVALID-ALWAYS-BCC-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/mailx/bcc')
      const rev = revOf(view.data?.revision)
      check('BCC-POLICY-OBSERVED', view.status === 200 && view.data?.section === 'bcc' && typeof view.data?.revision === 'string' && Array.isArray(view.data?.policy?.sender) && Array.isArray(view.data?.policy?.recipient), { status: view.status, senderRules: Array.isArray(view.data?.policy?.sender) ? view.data.policy.sender.length : null })
      refused('SELF-COPY-LOOP-VALIDATION', await root.put('/api/server/mailx/bcc', {
        expectedRevision: rev,
        policy: { alwaysBcc: null, sender: [{ match: 'loop@example.test', copyTo: 'loop@example.test' }], recipient: [] },
      }), 'VALIDATION')
      refused('INVALID-ALWAYS-BCC-VALIDATION', await root.put('/api/server/mailx/bcc', {
        expectedRevision: rev,
        policy: { alwaysBcc: 'not-an-email', sender: [], recipient: [] },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-mail-campaigns', {
    prefix: 'S19T10', as: 'root', needs: ['account'], probe: '/api/server/mail/marketing',
    page: { route: '/whm/email/marketing', read: '/api/server/mail/marketing', shows: () => ['Mail campaigns & automation'] },
    restores: ['/api/server/mail/marketing'],
    paths: /^\/api\/server\/mail\/marketing(?:\/(?:groups\/(?:add|remove)|templates\/(?:save|remove|preview)|campaigns\/(?:save|remove)))?$/,
    unit: [{ id: 'S19T10-UNIT-1', file: 'apps/api/src/mail-marketing.test.ts', name: 'campaigns, lists and flows sends at its rate, puts a working unsubscribe link in each message and excludes who used it' }],
    checks: ['MARKETING-WORKSPACE-OBSERVED', 'CAMPAIGN-DRAFT-AND-UNSUBSCRIBE-PREVIEW', 'UNKNOWN-TEMPLATE-VAR-VALIDATION'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const initial = await root.get('/api/server/mail/marketing')
      check('MARKETING-WORKSPACE-OBSERVED', initial.status === 200 && typeof initial.data?.revision === 'string' && Array.isArray(initial.data?.campaigns) && Array.isArray(initial.data?.templates), { status: initial.status, campaigns: Array.isArray(initial.data?.campaigns) ? initial.data.campaigns.length : null })
      const grpName = `xq-camp-grp-${tag}`
      const tplName = `xq-camp-tpl-${tag}`
      const campName = `xq-camp-${tag}`
      const domain = typeof fixture.domain === 'string' && fixture.domain.includes('.') ? fixture.domain : 'example.test'
      undo('mail campaign fixture', async () => {
        let cur = await root.get('/api/server/mail/marketing')
        if (cur.status !== 200) return false
        const camp = Array.isArray(cur.data?.campaigns) ? cur.data.campaigns.find(c => c.name === campName) : null
        if (camp?.id) cur = await root.post('/api/server/mail/marketing/campaigns/remove', { id: camp.id, expectedRevision: revOf(cur.data?.revision) })
        const tpl = Array.isArray(cur.data?.templates) ? cur.data.templates.find(t => t.name === tplName) : null
        if (tpl?.id) cur = await root.post('/api/server/mail/marketing/templates/remove', { id: tpl.id, expectedRevision: revOf(cur.data?.revision) })
        const grp = Array.isArray(cur.data?.groups) ? cur.data.groups.find(g => g.name === grpName) : null
        if (grp?.id) cur = await root.post('/api/server/mail/marketing/groups/remove', { id: grp.id, expectedRevision: revOf(cur.data?.revision) })
        return cur.status === 200
      })
      const gRes = await root.post('/api/server/mail/marketing/groups/add', { name: grpName, expectedRevision: revOf(initial.data?.revision) })
      const tRes = await root.post('/api/server/mail/marketing/templates/save', { name: tplName, subject: 'Update for {address}', text: 'Hello {address}', html: '', expectedRevision: revOf(gRes.data?.revision) })
      const tplRow = Array.isArray(tRes.data?.templates) ? tRes.data.templates.find(t => t.name === tplName) : null
      const pRes = await root.post('/api/server/mail/marketing/templates/preview', { id: uuidOrZero(tplRow?.id), expectedRevision: revOf(tRes.data?.revision) })
      const cRes = await root.post('/api/server/mail/marketing/campaigns/save', {
        name: campName, fromName: 'Updates', fromAddress: `news@${domain}`, subject: '', group: grpName, template: tplName, ratePerMinute: 30, scheduledAt: '', expectedRevision: revOf(tRes.data?.revision),
      })
      const created = Array.isArray(cRes.data?.campaigns) ? cRes.data.campaigns.find(c => c.name === campName) : null
      check('CAMPAIGN-DRAFT-AND-UNSUBSCRIBE-PREVIEW', cRes.status === 200 && Boolean(created) && pRes.status === 200 && typeof pRes.data?.text === 'string' && pRes.data.text.includes('/mail/unsubscribe'), { campaignStatus: cRes.status, created: Boolean(created), previewHasUnsubscribe: typeof pRes.data?.text === 'string' && pRes.data.text.includes('/mail/unsubscribe') })
      refused('UNKNOWN-TEMPLATE-VAR-VALIDATION', await root.post('/api/server/mail/marketing/templates/save', {
        name: `bad-${tag}`, subject: 'Hi', text: 'Hello {unknownField}', html: '', expectedRevision: revOf(cRes.data?.revision),
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-mail-subscribers', {
    prefix: 'S19T11', as: 'root', probe: '/api/server/mail/marketing',
    page: { route: '/whm/email/marketing', read: '/api/server/mail/marketing', shows: () => ['Mail campaigns & automation'] },
    restores: ['/api/server/mail/marketing'],
    paths: /^\/api\/server\/mail\/marketing(?:\/(?:groups\/(?:add|remove)|subscribers\/(?:import|remove)|suppressed\/(?:add|remove)))?$/,
    unit: [{ id: 'S19T11-UNIT-1', file: 'apps/api/src/mail-marketing.test.ts', name: 'campaigns, lists and flows skips a suppressed address until it is removed, and counts log results' }],
    checks: ['SUBSCRIBERS-AND-SUPPRESSION-OBSERVED', 'IMPORT-AND-SUPPRESS-ROUNDTRIP', 'MALFORMED-SUBSCRIBER-IMPORT-VALIDATION'],
    async run({ root, tag, check, refused, undo }) {
      const initial = await root.get('/api/server/mail/marketing')
      check('SUBSCRIBERS-AND-SUPPRESSION-OBSERVED', initial.status === 200 && Array.isArray(initial.data?.subscribers) && Array.isArray(initial.data?.suppressed), { status: initial.status, subscribersTotal: initial.data?.subscribersTotal ?? null, suppressedTotal: initial.data?.suppressedTotal ?? null })
      const grpName = `xq-sub-grp-${tag}`
      const addr = `sub-${tag}@remote.test`
      undo('mail subscriber fixture', async () => {
        let cur = await root.get('/api/server/mail/marketing')
        if (cur.status !== 200) return false
        if (Array.isArray(cur.data?.suppressed) && cur.data.suppressed.some(s => s.address === addr)) {
          cur = await root.post('/api/server/mail/marketing/suppressed/remove', { address: addr, expectedRevision: revOf(cur.data?.revision) })
        }
        if (Array.isArray(cur.data?.subscribers) && cur.data.subscribers.some(s => s.address === addr)) {
          cur = await root.post('/api/server/mail/marketing/subscribers/remove', { address: addr, expectedRevision: revOf(cur.data?.revision) })
        }
        const grp = Array.isArray(cur.data?.groups) ? cur.data.groups.find(g => g.name === grpName) : null
        if (grp?.id) cur = await root.post('/api/server/mail/marketing/groups/remove', { id: grp.id, expectedRevision: revOf(cur.data?.revision) })
        return cur.status === 200
      })
      const gRes = await root.post('/api/server/mail/marketing/groups/add', { name: grpName, expectedRevision: revOf(initial.data?.revision) })
      const iRes = await root.post('/api/server/mail/marketing/subscribers/import', { group: grpName, addresses: addr, expectedRevision: revOf(gRes.data?.revision) })
      const sRes = await root.post('/api/server/mail/marketing/suppressed/add', { address: addr, expectedRevision: revOf(iRes.data?.revision) })
      const hasSub = Array.isArray(sRes.data?.subscribers) && sRes.data.subscribers.some(s => s.address === addr)
      const hasSup = Array.isArray(sRes.data?.suppressed) && sRes.data.suppressed.some(s => s.address === addr && s.reason === 'manual')
      check('IMPORT-AND-SUPPRESS-ROUNDTRIP', sRes.status === 200 && hasSub && hasSup, { status: sRes.status, imported: hasSub, suppressed: hasSup })
      refused('MALFORMED-SUBSCRIBER-IMPORT-VALIDATION', await root.post('/api/server/mail/marketing/subscribers/import', {
        group: grpName, addresses: 'not-a-valid-address', expectedRevision: revOf(sRes.data?.revision),
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-mail-automation', {
    prefix: 'S19T12', as: 'root', needs: ['account'], probe: '/api/server/mail/marketing',
    page: { route: '/whm/email/marketing', read: '/api/server/mail/marketing', shows: () => ['Mail campaigns & automation'] },
    restores: ['/api/server/mail/marketing'],
    paths: /^\/api\/server\/mail\/marketing(?:\/(?:groups\/(?:add|remove)|templates\/(?:save|remove)|flows\/(?:save|remove)))?$/,
    unit: [{ id: 'S19T12-UNIT-1', file: 'apps/api/src/mail-marketing.test.ts', name: 'campaigns, lists and flows runs a flow for a new group member: first step after its delay, then the webhook' }],
    checks: ['AUTOMATION-FLOWS-OBSERVED', 'FLOW-CREATE-ROUNDTRIP', 'INVALID-FLOW-STEP-VALIDATION'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const initial = await root.get('/api/server/mail/marketing')
      check('AUTOMATION-FLOWS-OBSERVED', initial.status === 200 && Array.isArray(initial.data?.flows), { status: initial.status, flows: Array.isArray(initial.data?.flows) ? initial.data.flows.length : null })
      const grpName = `xq-flow-grp-${tag}`
      const tplName = `xq-flow-tpl-${tag}`
      const flowName = `xq-flow-${tag}`
      const domain = typeof fixture.domain === 'string' && fixture.domain.includes('.') ? fixture.domain : 'example.test'
      undo('mail automation flow fixture', async () => {
        let cur = await root.get('/api/server/mail/marketing')
        if (cur.status !== 200) return false
        const flw = Array.isArray(cur.data?.flows) ? cur.data.flows.find(f => f.name === flowName) : null
        if (flw?.id) cur = await root.post('/api/server/mail/marketing/flows/remove', { id: flw.id, expectedRevision: revOf(cur.data?.revision) })
        const tpl = Array.isArray(cur.data?.templates) ? cur.data.templates.find(t => t.name === tplName) : null
        if (tpl?.id) cur = await root.post('/api/server/mail/marketing/templates/remove', { id: tpl.id, expectedRevision: revOf(cur.data?.revision) })
        const grp = Array.isArray(cur.data?.groups) ? cur.data.groups.find(g => g.name === grpName) : null
        if (grp?.id) cur = await root.post('/api/server/mail/marketing/groups/remove', { id: grp.id, expectedRevision: revOf(cur.data?.revision) })
        return cur.status === 200
      })
      const gRes = await root.post('/api/server/mail/marketing/groups/add', { name: grpName, expectedRevision: revOf(initial.data?.revision) })
      const tRes = await root.post('/api/server/mail/marketing/templates/save', { name: tplName, subject: 'Welcome {address}', text: 'Step 1', html: '', expectedRevision: revOf(gRes.data?.revision) })
      const fRes = await root.post('/api/server/mail/marketing/flows/save', {
        name: flowName, group: grpName, fromName: 'Flow', fromAddress: `flow@${domain}`, steps: ['delay 5', `send ${tplName}`], expectedRevision: revOf(tRes.data?.revision),
      })
      const created = Array.isArray(fRes.data?.flows) ? fRes.data.flows.find(f => f.name === flowName) : null
      check('FLOW-CREATE-ROUNDTRIP', fRes.status === 200 && Boolean(created) && created.steps === 2, { status: fRes.status, steps: created?.steps ?? null })
      refused('INVALID-FLOW-STEP-VALIDATION', await root.post('/api/server/mail/marketing/flows/save', {
        name: `bad-flow-${tag}`, group: grpName, fromName: 'Flow', fromAddress: `flow@${domain}`, steps: ['exec /bin/true'], expectedRevision: revOf(fRes.data?.revision),
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-file-share', {
    prefix: 'S19T13', as: 'root', probe: '/api/server/file-sharing',
    paths: /^\/api\/server\/file-sharing(?:\/links)?$/,
    unit: [{ id: 'S19T13-UNIT-1', file: 'apps/agent/src/ops-file-sharing.test.ts', name: 'share grammar accepts managed paths and documented host specs and rejects everything else' }],
    checks: ['NFS-EXPORTS-OBSERVED', 'SHARE-LINKS-LISTED', 'OUTSIDE-MANAGED-EXPORT-VALIDATION', 'INVALID-LINK-EXPIRY-VALIDATION'],
    async run({ root, check, refused }) {
      const nfs = await root.get('/api/server/file-sharing')
      const savedRev = revOf(nfs.data?.savedRevision)
      check('NFS-EXPORTS-OBSERVED', nfs.status === 200 && typeof nfs.data?.savedRevision === 'string' && ['read', 'unavailable'].includes(nfs.data?.observed?.state), { status: nfs.status, state: nfs.data?.observed?.state ?? null })
      const links = await root.get('/api/server/file-sharing/links')
      const linksRev = revOf(links.data?.revision)
      check('SHARE-LINKS-LISTED', links.status === 200 && typeof links.data?.revision === 'string' && Array.isArray(links.data?.links), { status: links.status, links: Array.isArray(links.data?.links) ? links.data.links.length : null })
      refused('OUTSIDE-MANAGED-EXPORT-VALIDATION', await root.put('/api/server/file-sharing', {
        expectedSavedRevision: savedRev,
        config: { version: 1, shares: [{ id: 'shr_0000000000000001', path: '/etc/exports', clients: [{ host: '192.0.2.10', permission: 'ro', squashRoot: true, subtreeCheck: false }] }] },
      }), 'VALIDATION')
      refused('INVALID-LINK-EXPIRY-VALIDATION', await root.post('/api/server/file-sharing/links', {
        path: '/home/alice/file.txt', expiresHours: 0, expectedRevision: linksRev,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-log-security-analysis', {
    prefix: 'S19T14', as: 'root', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains|server\/logs\/security-analysis\?domainId=(?:[0-9a-f-]{36}|invalid))$/i,
    unit: [{ id: 'S19T14-UNIT-1', file: 'apps/agent/src/log-security-analysis.test.ts', name: 'access log security analysis reports three SQL injection requests as three findings of that type, with samples' }],
    checks: ['SITE-ACCESS-LOG-SCANNED', 'MALFORMED-DOMAIN-ID-VALIDATION', 'UNKNOWN-SITE-NOT-FOUND'],
    async run({ root, fixture, check, refused }) {
      const domRes = await root.get('/api/domains')
      const domains = Array.isArray(domRes.data?.domains) ? domRes.data.domains : []
      const match = domains.find(d => d.name === fixture.domain || d.accountId === fixture.accountId) ?? domains[0]
      const domId = uuidOrZero(match?.id)
      const report = await root.get(`/api/server/logs/security-analysis?domainId=${domId}`)
      check('SITE-ACCESS-LOG-SCANNED', report.status === 200 && typeof report.data?.scan?.scannedBytes === 'number' && Array.isArray(report.data?.findings), { status: report.status, scannedBytes: report.data?.scan?.scannedBytes ?? null, findings: Array.isArray(report.data?.findings) ? report.data.findings.length : null })
      refused('MALFORMED-DOMAIN-ID-VALIDATION', await root.get('/api/server/logs/security-analysis?domainId=invalid'), 'VALIDATION')
      refused('UNKNOWN-SITE-NOT-FOUND', await root.get(`/api/server/logs/security-analysis?domainId=${ZERO_UUID}`), 'NOT_FOUND')
    },
  }),

  tool('aapanel-os-log-audit', {
    prefix: 'S19T15', as: 'root', probe: '/api/server/monitoring/logs?unit=nginx.service&lines=25',
    paths: /^\/api\/server\/monitoring\/logs\?(?:unit=(?:nginx\.service|xpanel-api\.service|shadow\.service)(?:&lines=(?:25|999))?)$/,
    unit: [{ id: 'S19T15-UNIT-1', file: 'apps/agent/src/host-monitoring-route.test.ts', name: 'host monitoring agent route enforces methods and refuses selectors on fixed reads' }],
    checks: ['JOURNAL-UNIT-LOG-OBSERVED', 'UNREVIEWED-UNIT-VALIDATION', 'EXCESS-LINES-VALIDATION'],
    async run({ root, check, refused }) {
      const log = await root.get('/api/server/monitoring/logs?unit=xpanel-api.service&lines=25')
      check('JOURNAL-UNIT-LOG-OBSERVED', log.status === 200 && ['read', 'unavailable'].includes(log.data?.state) && log.data?.unit === 'xpanel-api.service' && Array.isArray(log.data?.items), { status: log.status, state: log.data?.state ?? null, items: Array.isArray(log.data?.items) ? log.data.items.length : null })
      refused('UNREVIEWED-UNIT-VALIDATION', await root.get('/api/server/monitoring/logs?unit=shadow.service&lines=25'), 'VALIDATION')
      refused('EXCESS-LINES-VALIDATION', await root.get('/api/server/monitoring/logs?unit=nginx.service&lines=999'), 'VALIDATION')
    },
  }),

  tool('aapanel-software-logs', {
    prefix: 'S19T16', as: 'root', probe: '/api/server/logs/database?log=error',
    paths: /^\/api\/server\/logs\/database\?log=(?:error|slow|postgresql)$/,
    unit: [{ id: 'S19T16-UNIT-1', file: 'apps/agent/src/database-logs.test.ts', name: 'database logs reads the slow log from the path the server reports and states the recording settings' }],
    checks: ['MARIADB-ERROR-LOG-OBSERVED', 'MARIADB-SLOW-LOG-OBSERVED', 'UNSUPPORTED-DB-LOG-VALIDATION'],
    async run({ root, check, refused }) {
      const errLog = await root.get('/api/server/logs/database?log=error')
      check('MARIADB-ERROR-LOG-OBSERVED', errLog.status === 200 && errLog.data?.log === 'error' && ['read', 'unavailable'].includes(errLog.data?.state) && Array.isArray(errLog.data?.entries), { status: errLog.status, state: errLog.data?.state ?? null, entries: Array.isArray(errLog.data?.entries) ? errLog.data.entries.length : null })
      const slowLog = await root.get('/api/server/logs/database?log=slow')
      check('MARIADB-SLOW-LOG-OBSERVED', slowLog.status === 200 && slowLog.data?.log === 'slow' && ['read', 'unavailable'].includes(slowLog.data?.state) && Array.isArray(slowLog.data?.entries), { status: slowLog.status, state: slowLog.data?.state ?? null, entries: Array.isArray(slowLog.data?.entries) ? slowLog.data.entries.length : null })
      refused('UNSUPPORTED-DB-LOG-VALIDATION', await root.get('/api/server/logs/database?log=postgresql'), 'VALIDATION')
    },
  }),

  tool('aapanel-ddns', {
    prefix: 'S19T17', as: 'root', probe: '/api/server/host-tools/ddns',
    restores: ['/api/server/host-tools/ddns'],
    paths: /^\/api\/server\/host-tools\/(?:ddns(?:\/[a-z0-9]{12})?|ddns-settings)$/,
    unit: [{ id: 'S19T17-UNIT-1', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API dynamic DNS cycle updates on a changed address at the next check, and only then' }],
    checks: ['DDNS-SETTINGS-AND-RECORDS-OBSERVED', 'LOCAL-DDNS-RECORD-ROUNDTRIP', 'CLOUDFLARE-MISSING-CREDENTIAL-VALIDATION'],
    async run({ root, tag, check, refused, undo }) {
      const settings = await root.get('/api/server/host-tools/ddns-settings')
      const initial = await root.get('/api/server/host-tools/ddns')
      check('DDNS-SETTINGS-AND-RECORDS-OBSERVED', settings.status === 200 && typeof settings.data?.intervalMinutes === 'number' && initial.status === 200 && Array.isArray(initial.data?.rows), { settingsStatus: settings.status, intervalMinutes: settings.data?.intervalMinutes ?? null, records: Array.isArray(initial.data?.rows) ? initial.data.rows.length : null })
      const hostname = `ddns-${tag}.example.test`
      let createdId = null
      undo('host ddns record', async () => {
        if (!createdId) return true
        const cur = await root.get('/api/server/host-tools/ddns')
        if (cur.status !== 200) return false
        if (!Array.isArray(cur.data?.rows) || !cur.data.rows.some(r => r.id === createdId)) return true
        const del = await root.delete(`/api/server/host-tools/ddns/${createdId}`, { expectedRevision: revOf(cur.data?.revision) })
        return del.status === 200 || del.status === 404
      })
      const createRes = await root.post('/api/server/host-tools/ddns', {
        hostname, provider: 'local', server: '', username: '', secret: '', expectedRevision: revOf(initial.data?.revision),
      })
      if (typeof createRes.data?.id === 'string' && HOST_ID_RE.test(createRes.data.id)) createdId = createRes.data.id
      const after = await root.get('/api/server/host-tools/ddns')
      const found = Array.isArray(after.data?.rows) ? after.data.rows.find(r => r.hostname === hostname) : null
      check('LOCAL-DDNS-RECORD-ROUNDTRIP', createRes.status === 200 && after.status === 200 && Boolean(found) && found.provider === 'local', { status: createRes.status, found: Boolean(found) })
      refused('CLOUDFLARE-MISSING-CREDENTIAL-VALIDATION', await root.post('/api/server/host-tools/ddns', {
        hostname: `cf-${tag}.example.test`, provider: 'cloudflare', server: '', username: '', secret: '', expectedRevision: revOf(after.data?.revision),
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-subpanel-service', {
    prefix: 'S19T18', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\/(?:service|gate))?$/,
    unit: [{ id: 'S19T18-UNIT-1', file: 'apps/api/src/panel-access.http.test.ts', name: 'entrance and unauthenticated response hides the panel without the entrance and shows the sign-in after it' }],
    checks: ['SUBPANEL-ACCESS-GATE-OBSERVED', 'UNSUPPORTED-SERVICE-ACTION-VALIDATION', 'INVALID-STOPPED-LISTENER-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel-access')
      const rev = revOf(view.data?.revision)
      check('SUBPANEL-ACCESS-GATE-OBSERVED', view.status === 200 && ['default', 'saved', 'invalid'].includes(view.data?.state) && Array.isArray(view.data?.gate?.stopped), { status: view.status, state: view.data?.state ?? null, stopped: Array.isArray(view.data?.gate?.stopped) ? view.data.gate.stopped.length : null })
      refused('UNSUPPORTED-SERVICE-ACTION-VALIDATION', await root.post('/api/server/panel-access/service', { action: 'stop' }), 'VALIDATION')
      refused('INVALID-STOPPED-LISTENER-VALIDATION', await root.put('/api/server/panel-access/gate', {
        entrance: null, response: { kind: '404' }, basicAuth: null, stopped: ['xwhm'], expectedRevision: rev,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-web-terminal', {
    prefix: 'S19T19', as: 'root', probe: '/api/server/terminal',
    paths: /^\/api\/server\/terminal(?:\?host=remote)?$/,
    unit: [{ id: 'S19T19-UNIT-1', file: 'apps/web/src/ops-terminal-client.test.ts', name: 'root terminal client re-authenticates, opens the socket with the ticket and terminal size, relays commands and output, then closes' }],
    checks: ['TERMINAL-CAPABILITY-OBSERVED', 'REMOTE-SELECTOR-VALIDATION', 'EMPTY-CREDENTIAL-OPEN-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/terminal')
      check('TERMINAL-CAPABILITY-OBSERVED', view.status === 200 && view.data?.capability?.reauthentication === 'required' && ['available', 'unavailable'].includes(view.data?.execution?.state) && typeof view.data?.session?.open === 'boolean', { status: view.status, executionState: view.data?.execution?.state ?? null, sessionOpen: view.data?.session?.open ?? null })
      refused('REMOTE-SELECTOR-VALIDATION', await root.get('/api/server/terminal?host=remote'), 'VALIDATION')
      refused('EMPTY-CREDENTIAL-OPEN-VALIDATION', await root.post('/api/server/terminal', { password: '' }), 'VALIDATION')
    },
  }),

  tool('aapanel-saved-commands', {
    prefix: 'S19T20', as: 'root', probe: '/api/server/host-tools/saved-commands',
    restores: ['/api/server/host-tools/saved-commands'],
    paths: /^\/api\/server\/host-tools\/saved-commands(?:\/[a-z0-9]{12})?$/,
    unit: [{ id: 'S19T20-UNIT-1', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API saves saved commands without a host' }],
    checks: ['SAVED-COMMANDS-LISTED', 'SAVED-COMMAND-CRUD-ROUNDTRIP', 'EMPTY-COMMAND-CONTENT-VALIDATION'],
    async run({ root, tag, check, refused, undo }) {
      const initial = await root.get('/api/server/host-tools/saved-commands')
      check('SAVED-COMMANDS-LISTED', initial.status === 200 && typeof initial.data?.revision === 'string' && Array.isArray(initial.data?.rows), { status: initial.status, count: Array.isArray(initial.data?.rows) ? initial.data.rows.length : null })
      const cmdName = `xq-cmd-${tag}`
      let createdId = null
      undo('saved terminal command', async () => {
        if (!createdId) return true
        const cur = await root.get('/api/server/host-tools/saved-commands')
        if (cur.status !== 200) return false
        if (!Array.isArray(cur.data?.rows) || !cur.data.rows.some(r => r.id === createdId)) return true
        const del = await root.delete(`/api/server/host-tools/saved-commands/${createdId}`, { expectedRevision: revOf(cur.data?.revision) })
        return del.status === 200 || del.status === 404
      })
      const createRes = await root.post('/api/server/host-tools/saved-commands', {
        name: cmdName, content: 'uptime', expectedRevision: revOf(initial.data?.revision),
      })
      if (typeof createRes.data?.id === 'string' && HOST_ID_RE.test(createRes.data.id)) createdId = createRes.data.id
      const editId = hostIdOrZero(createdId)
      const editRes = createdId
        ? await root.put(`/api/server/host-tools/saved-commands/${editId}`, { name: cmdName, content: 'df -h', expectedRevision: revOf(createRes.data?.revision) })
        : createRes
      const after = await root.get('/api/server/host-tools/saved-commands')
      const found = Array.isArray(after.data?.rows) ? after.data.rows.find(r => r.name === cmdName) : null
      check('SAVED-COMMAND-CRUD-ROUNDTRIP', createRes.status === 200 && editRes.status === 200 && Boolean(found) && found.content === 'df -h', { createStatus: createRes.status, editStatus: editRes.status, updated: found?.content === 'df -h' })
      refused('EMPTY-COMMAND-CONTENT-VALIDATION', await root.post('/api/server/host-tools/saved-commands', {
        name: `empty-${tag}`, content: '   ', expectedRevision: revOf(after.data?.revision),
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-cron-tasks', {
    prefix: 'S19T21', as: 'root', probe: '/api/server/host-tools/tasks',
    paths: /^\/api\/server\/host-tools\/tasks(?:\/000000000000\/run)?$/,
    unit: [{ id: 'S19T21-UNIT-1', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API rejects a site backup every N seconds and a task with a shell line' }],
    checks: ['SCHEDULED-TASKS-OBSERVED', 'SITE-BACKUP-SECONDS-CYCLE-VALIDATION', 'SHELL-LINE-COMMAND-VALIDATION', 'UNKNOWN-TASK-RUN-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/host-tools/tasks')
      const rev = revOf(view.data?.revision)
      check('SCHEDULED-TASKS-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string' && Array.isArray(view.data?.rows) && Array.isArray(view.data?.scripts), { status: view.status, tasks: Array.isArray(view.data?.rows) ? view.data.rows.length : null })
      refused('SITE-BACKUP-SECONDS-CYCLE-VALIDATION', await root.post('/api/server/host-tools/tasks', {
        name: 'BadBackup', type: 'site-backup', cycle: 'seconds', every: 30, target: 'example.test', keep: 3, enabled: false, chained: false, expectedRevision: rev,
      }), 'VALIDATION')
      refused('SHELL-LINE-COMMAND-VALIDATION', await root.post('/api/server/host-tools/tasks', {
        name: 'BadShell', type: 'command', cycle: 'daily', hour: 3, minute: 5, command: 'echo hi && id', enabled: false, chained: false, expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNKNOWN-TASK-RUN-NOT-FOUND', await root.post('/api/server/host-tools/tasks/000000000000/run', {}), 'NOT_FOUND')
    },
  }),

  tool('aapanel-task-chaining', {
    prefix: 'S19T22', as: 'root', probe: '/api/server/host-tools/tasks',
    paths: /^\/api\/server\/host-tools\/tasks(?:\/000000000000\/log)?$/,
    unit: [{ id: 'S19T22-UNIT-1', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API adds, edits and deletes a task bound to its revision' }],
    checks: ['CHAINABLE-SCHEDULER-OBSERVED', 'NON-EXECUTABLE-CHAIN-VALIDATION', 'MISSING-SCRIPT-CHAIN-VALIDATION', 'UNKNOWN-CHAIN-LOG-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/host-tools/tasks')
      const rev = revOf(view.data?.revision)
      check('CHAINABLE-SCHEDULER-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string' && Array.isArray(view.data?.rows) && typeof view.data?.runs === 'object', { status: view.status, tasks: Array.isArray(view.data?.rows) ? view.data.rows.length : null })
      refused('NON-EXECUTABLE-CHAIN-VALIDATION', await root.post('/api/server/host-tools/tasks', {
        name: 'UrlChain', type: 'url', cycle: 'hourly', minute: 10, target: 'https://example.test/health', enabled: false, chained: true, expectedRevision: rev,
      }), 'VALIDATION')
      refused('MISSING-SCRIPT-CHAIN-VALIDATION', await root.post('/api/server/host-tools/tasks', {
        name: 'ScriptChain', type: 'script', cycle: 'hourly', minute: 15, scriptId: '000000000000', enabled: false, chained: true, expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNKNOWN-CHAIN-LOG-NOT-FOUND', await root.get('/api/server/host-tools/tasks/000000000000/log'), 'NOT_FOUND')
    },
  }),

  tool('aapanel-event-triggers', {
    prefix: 'S19T23', as: 'root', probe: '/api/server/host-tools/triggers',
    paths: /^\/api\/server\/host-tools\/triggers(?:\/000000000000)?$/,
    unit: [{ id: 'S19T23-UNIT-1', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API refuses a trigger loop, and deleting a task its trigger needs' }],
    checks: ['EVENT-TRIGGERS-OBSERVED', 'MISSING-TASK-TRIGGER-VALIDATION', 'UNSUPPORTED-MATCH-VALIDATION', 'UNKNOWN-TRIGGER-DELETE-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/host-tools/triggers')
      const rev = revOf(view.data?.revision)
      check('EVENT-TRIGGERS-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string' && Array.isArray(view.data?.rows) && Array.isArray(view.data?.tasks), { status: view.status, triggers: Array.isArray(view.data?.rows) ? view.data.rows.length : null })
      refused('MISSING-TASK-TRIGGER-VALIDATION', await root.post('/api/server/host-tools/triggers', {
        name: 'StoppedWatch', taskId: '000000000000', match: 'include', value: 'stopped', targetId: '000000000001', expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNSUPPORTED-MATCH-VALIDATION', await root.post('/api/server/host-tools/triggers', {
        name: 'RegexWatch', taskId: '000000000000', match: 'regex', value: 'stopped', targetId: '000000000001', expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNKNOWN-TRIGGER-DELETE-NOT-FOUND', await root.delete('/api/server/host-tools/triggers/000000000000', { expectedRevision: rev }), 'NOT_FOUND')
    },
  }),

  tool('aapanel-script-library', {
    prefix: 'S19T24', as: 'root', probe: '/api/server/host-tools/scripts',
    paths: /^\/api\/server\/host-tools\/scripts$/,
    unit: [{ id: 'S19T24-UNIT-1', file: 'apps/agent/src/cron-qualification.test.ts', name: 'trusted cron host qualification admits an enabled job when systemd timers are active and the schedule translates' }],
    checks: ['SCRIPT-LIBRARY-OBSERVED', 'UNSUPPORTED-LANGUAGE-VALIDATION', 'UNSUPPORTED-RETURN-TYPE-VALIDATION', 'EMPTY-SCRIPT-CONTENT-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/host-tools/scripts')
      const rev = revOf(view.data?.revision)
      check('SCRIPT-LIBRARY-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string' && Array.isArray(view.data?.rows), { status: view.status, scripts: Array.isArray(view.data?.rows) ? view.data.rows.length : null })
      refused('UNSUPPORTED-LANGUAGE-VALIDATION', await root.post('/api/server/host-tools/scripts', {
        name: 'BadLang', language: 'ruby', returns: 'integer', args: '', remark: '', content: 'puts 1\n', expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNSUPPORTED-RETURN-TYPE-VALIDATION', await root.post('/api/server/host-tools/scripts', {
        name: 'BadRet', language: 'bash', returns: 'boolean', args: '', remark: '', content: 'echo 1\n', expectedRevision: rev,
      }), 'VALIDATION')
      refused('EMPTY-SCRIPT-CONTENT-VALIDATION', await root.post('/api/server/host-tools/scripts', {
        name: 'EmptyBody', language: 'python', returns: 'integer', args: '', remark: '', content: '   ', expectedRevision: rev,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-app-catalog', {
    prefix: 'S19T25', as: 'root', probe: '/api/server/software-center?page=catalog',
    paths: /^\/api\/server\/software-center(?:\?page=(?:catalog|invalid)|\/preview)?$/,
    unit: [{ id: 'S19T25-UNIT-1', file: 'apps/agent/src/software-center-catalog.test.ts', name: 'shipped software center catalog has a modest set of uniquely identified components with resolvable relations' }],
    checks: ['CATALOG-COMPONENTS-LISTED', 'INVALID-CATALOG-PAGE-VALIDATION', 'INVALID-COMPONENT-ID-PREVIEW-VALIDATION'],
    async run({ root, check, refused }) {
      const catalog = await root.get('/api/server/software-center?page=catalog')
      const rev = revOf(catalog.data?.revision)
      check('CATALOG-COMPONENTS-LISTED', catalog.status === 200 && ['read', 'unavailable'].includes(catalog.data?.state) && catalog.data?.page === 'catalog' && Array.isArray(catalog.data?.components), { status: catalog.status, state: catalog.data?.state ?? null, components: Array.isArray(catalog.data?.components) ? catalog.data.components.length : null })
      refused('INVALID-CATALOG-PAGE-VALIDATION', await root.get('/api/server/software-center?page=invalid'), 'VALIDATION')
      refused('INVALID-COMPONENT-ID-PREVIEW-VALIDATION', await root.post('/api/server/software-center/preview', {
        action: 'install', componentIds: ['UPPERCASE_BAD'], expectedRevision: rev,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-third-party-plugin-import', {
    prefix: 'S19T26', as: 'root', probe: '/api/server/plugins',
    restores: ['/api/server/plugins'],
    paths: /^\/api\/server\/plugins(?:\/xq_[a-z0-9_]{1,24})?$/,
    unit: [{ id: 'S19T26-UNIT-1', file: 'apps/api/src/plugin-packages.test.ts', name: 'plugin packages adds a plugin: key to the Feature Manager, gates the item with it and audits a cPanel archive install' }],
    checks: ['PLUGIN-INVENTORY-OBSERVED', 'INVALID-MANIFEST-FORMAT-VALIDATION', 'VALID-PLUGIN-PACKAGE-ROUNDTRIP'],
    async run({ root, tag, check, refused, undo }) {
      const initial = await root.get('/api/server/plugins')
      check('PLUGIN-INVENTORY-OBSERVED', initial.status === 200 && Array.isArray(initial.data?.plugins) && initial.data?.limits?.iconPixels === 48, { status: initial.status, count: Array.isArray(initial.data?.plugins) ? initial.data.plugins.length : null })
      const badPkg = await root.post('/api/server/plugins', {
        package: { format: 'invalid-format', name: 'badpkg', items: [] },
        overwrite: false,
      })
      refused('INVALID-MANIFEST-FORMAT-VALIDATION', badPkg, 'VALIDATION')
      const pkgName = `xq_${tag}`
      undo('third-party plugin package', async () => {
        const cur = await root.get('/api/server/plugins')
        if (cur.status !== 200) return false
        if (!Array.isArray(cur.data?.plugins) || !cur.data.plugins.some(p => p.name === pkgName)) return true
        const del = await root.delete(`/api/server/plugins/${pkgName}`)
        return del.status === 200 || del.status === 404
      })
      const install = await root.post('/api/server/plugins', {
        package: {
          format: 'xpanel-plugin-package-v1',
          name: pkgName,
          items: [{ id: `item_${tag}`, name: `Link ${tag}`, group: 'Tools', priority: 10, uri: 'https://plugin.example.test/app', feature: `plugin:${pkgName}`, icon: { type: 'image/svg+xml', data: PLUGIN_ICON_B64 } }],
        },
        overwrite: true,
      })
      const installed = Array.isArray(install.data?.plugins) ? install.data.plugins.find(p => p.name === pkgName) : null
      check('VALID-PLUGIN-PACKAGE-ROUNDTRIP', install.status === 200 && Boolean(installed) && installed.state === 'installed', { status: install.status, installed: Boolean(installed) })
    },
  }),

  tool('aapanel-memcached-manager', {
    prefix: 'S19T27', as: 'root', probe: '/api/server/software/addon-services',
    paths: /^\/api\/server\/software\/addon-services(?:\/action|\?unknown=1)?$/,
    unit: [{ id: 'S19T27-UNIT-1', file: 'apps/agent/src/package-manager.test.ts', name: 'apt simulation observation parses Inst lines with security suites, kernels, new dependencies and holds' }],
    checks: ['MEMCACHED-UNIT-OBSERVED', 'ADDON-SELECTOR-VALIDATION', 'MEMCACHED-UNSUPPORTED-ACTION-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software/addon-services')
      const services = Array.isArray(view.data?.services) ? view.data.services : []
      const memcached = services.find(s => s.id === 'memcached')
      const rev = revOf(memcached?.revision)
      check('MEMCACHED-UNIT-OBSERVED', view.status === 200 && view.data?.scope === 'host-addon-services' && view.data?.actions?.configure === false && (view.data?.state === 'unavailable' || Boolean(memcached && memcached.unit === 'memcached.service')), { status: view.status, state: view.data?.state ?? null, active: memcached?.active ?? null })
      refused('ADDON-SELECTOR-VALIDATION', await root.get('/api/server/software/addon-services?unknown=1'), 'VALIDATION')
      refused('MEMCACHED-UNSUPPORTED-ACTION-VALIDATION', await root.post('/api/server/software/addon-services/action', {
        serviceId: 'memcached', action: 'configure', expectedRevision: rev,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-elasticsearch-manager', {
    prefix: 'S19T28', as: 'root', probe: '/api/server/software/addon-services',
    paths: /^\/api\/server\/software\/addon-services(?:\/action)?$/,
    unit: [{ id: 'S19T28-UNIT-1', file: 'apps/agent/src/package-manager.test.ts', name: 'apt simulation observation recognizes Debian security suites and empty release lists' }],
    checks: ['SEARCH-ADDON-UNITS-OBSERVED', 'ELASTICSEARCH-INVALID-REVISION-VALIDATION', 'UNKNOWN-SEARCH-SERVICE-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software/addon-services')
      const services = Array.isArray(view.data?.services) ? view.data.services : []
      const es = services.find(s => s.id === 'elasticsearch')
      const os = services.find(s => s.id === 'opensearch')
      check('SEARCH-ADDON-UNITS-OBSERVED', view.status === 200 && view.data?.scope === 'host-addon-services' && (view.data?.state === 'unavailable' || (Boolean(es) && Boolean(os))), { status: view.status, state: view.data?.state ?? null, esActive: es?.active ?? null, osActive: os?.active ?? null })
      refused('ELASTICSEARCH-INVALID-REVISION-VALIDATION', await root.post('/api/server/software/addon-services/action', {
        serviceId: 'elasticsearch', action: 'restart', expectedRevision: 'bad-rev',
      }), 'VALIDATION')
      refused('UNKNOWN-SEARCH-SERVICE-VALIDATION', await root.post('/api/server/software/addon-services/action', {
        serviceId: 'meilisearch', action: 'restart', expectedRevision: ZERO_REV,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-rabbitmq-manager', {
    prefix: 'S19T29', as: 'root', probe: '/api/server/software/addon-services',
    paths: /^\/api\/server\/software\/addon-services(?:\/action)?$/,
    unit: [{ id: 'S19T29-UNIT-1', file: 'apps/agent/src/package-manager.test.ts', name: 'apt simulation observation keeps the revision stable across order and observation time and changes it with the plan' }],
    checks: ['RABBITMQ-UNIT-OBSERVED', 'RABBITMQ-UNSUPPORTED-ACTION-VALIDATION', 'RABBITMQ-EXTRA-FIELD-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software/addon-services')
      const services = Array.isArray(view.data?.services) ? view.data.services : []
      const mq = services.find(s => s.id === 'rabbitmq')
      const rev = revOf(mq?.revision)
      check('RABBITMQ-UNIT-OBSERVED', view.status === 200 && view.data?.scope === 'host-addon-services' && (view.data?.state === 'unavailable' || Boolean(mq && mq.unit === 'rabbitmq-server.service')), { status: view.status, state: view.data?.state ?? null, active: mq?.active ?? null })
      refused('RABBITMQ-UNSUPPORTED-ACTION-VALIDATION', await root.post('/api/server/software/addon-services/action', {
        serviceId: 'rabbitmq', action: 'reload', expectedRevision: rev,
      }), 'VALIDATION')
      refused('RABBITMQ-EXTRA-FIELD-VALIDATION', await root.post('/api/server/software/addon-services/action', {
        serviceId: 'rabbitmq', action: 'restart', expectedRevision: rev, extra: true,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-mongodb-service', {
    prefix: 'S19T30', as: 'root', probe: '/api/server/databases/services/mongodb',
    page: { route: '/whm/databases/mongodb', read: '/api/server/databases/services/mongodb', shows: () => ['MongoDB'] },
    paths: /^\/api\/server\/databases\/services\/mongodb(?:\/(?:settings|config|control))?$/,
    unit: [{ id: 'S19T30-UNIT-1', file: 'apps/agent/src/db-services.test.ts', name: 'MongoDB tools refuses when MongoDB is not installed and never starts a daemon' }],
    checks: ['MONGODB-SERVICE-OBSERVED', 'NON-LOOPBACK-BIND-VALIDATION', 'EMPTY-MONGOD-CONFIG-VALIDATION', 'UNSUPPORTED-CONTROL-ACTION-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/databases/services/mongodb')
      check('MONGODB-SERVICE-OBSERVED', view.status === 200 && view.data?.engine === 'mongodb' && typeof view.data?.installed === 'boolean', { status: view.status, installed: view.data?.installed ?? null, runtimeState: view.data?.runtime?.state ?? null })
      refused('NON-LOOPBACK-BIND-VALIDATION', await root.post('/api/server/databases/services/mongodb/settings', {
        port: 27017, bindIp: '0.0.0.0',
      }), 'VALIDATION')
      refused('EMPTY-MONGOD-CONFIG-VALIDATION', await root.post('/api/server/databases/services/mongodb/config', {
        text: '', expectedRevision: ZERO_REV,
      }), 'VALIDATION')
      refused('UNSUPPORTED-CONTROL-ACTION-VALIDATION', await root.post('/api/server/databases/services/mongodb/control', {
        action: 'kill',
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-clamav', {
    prefix: 'S19T31', as: 'root', probe: '/api/server/security-tools/antivirus',
    paths: /^\/api\/server\/security-tools\/antivirus(?:\/(?:scan|update))?$/,
    unit: [{ id: 'S19T31-UNIT-1', file: 'apps/agent/src/security-tools-antivirus.test.ts', name: 'antivirus job plans scans exactly one account home as a reviewed non-mutating job' }],
    checks: ['CLAMAV-ENGINE-OBSERVED', 'SCAN-INVALID-ACCOUNT-VALIDATION', 'UPDATE-EXTRA-FIELD-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/security-tools/antivirus')
      check('CLAMAV-ENGINE-OBSERVED', view.status === 200 && ['read', 'not_installed', 'unavailable'].includes(view.data?.engine?.state) && Array.isArray(view.data?.scans) && Array.isArray(view.data?.updates), { status: view.status, engineState: view.data?.engine?.state ?? null, scans: Array.isArray(view.data?.scans) ? view.data.scans.length : null })
      refused('SCAN-INVALID-ACCOUNT-VALIDATION', await root.post('/api/server/security-tools/antivirus/scan', { account: '../etc' }), 'VALIDATION')
      refused('UPDATE-EXTRA-FIELD-VALIDATION', await root.post('/api/server/security-tools/antivirus/update', { force: true }), 'VALIDATION')
    },
  }),

  tool('aapanel-frp-manager', {
    prefix: 'S19T32', as: 'root', probe: '/api/server/host-tools/frp-server',
    paths: /^\/api\/server\/host-tools\/(?:frp-server|frp-client|frp-tunnels)$/,
    unit: [{ id: 'S19T32-UNIT-1', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API refuses frp until the binary is installed' }],
    checks: ['FRP-SERVER-AND-CLIENT-OBSERVED', 'FRP-TUNNELS-LISTED', 'OVERLAPPING-BIND-PORT-VALIDATION', 'INVALID-TUNNEL-NAME-VALIDATION'],
    async run({ root, check, refused }) {
      const server = await root.get('/api/server/host-tools/frp-server')
      const client = await root.get('/api/server/host-tools/frp-client')
      const sRev = revOf(server.data?.revision)
      check('FRP-SERVER-AND-CLIENT-OBSERVED', server.status === 200 && typeof server.data?.bindPort === 'number' && server.data?.token === '' && client.status === 200 && client.data?.token === '', { serverStatus: server.status, bindPort: server.data?.bindPort ?? null, installed: server.data?.installed ?? null })
      const tunnels = await root.get('/api/server/host-tools/frp-tunnels')
      const tRev = revOf(tunnels.data?.revision)
      check('FRP-TUNNELS-LISTED', tunnels.status === 200 && Array.isArray(tunnels.data?.rows), { status: tunnels.status, tunnels: Array.isArray(tunnels.data?.rows) ? tunnels.data.rows.length : null })
      refused('OVERLAPPING-BIND-PORT-VALIDATION', await root.put('/api/server/host-tools/frp-server', {
        enabled: false, bindPort: 7150, token: '', portMin: 7100, portMax: 7199, expectedRevision: sRev,
      }), 'VALIDATION')
      refused('INVALID-TUNNEL-NAME-VALIDATION', await root.post('/api/server/host-tools/frp-tunnels', {
        name: 'BAD_TUNNEL', localPort: 8080, remotePort: 7101, expectedRevision: tRev,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-boot-items', {
    prefix: 'S19T33', as: 'root', probe: '/api/server/service-manager',
    paths: /^\/api\/server\/service-manager(?:\/action)?$/,
    unit: [{ id: 'S19T33-UNIT-1', file: 'apps/api/src/service-manager-workspace.test.ts', name: 'service manager API routes refuses unknown fields and selectors without forwarding' }],
    checks: ['BOOT-ITEMS-OBSERVED', 'START-ACTION-VALIDATION', 'MALFORMED-UNIT-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/service-manager')
      const units = Array.isArray(view.data?.units) ? view.data.units : []
      const rev = revOf(view.data?.revision)
      const allowedBoot = ['atd.service', 'chrony.service', 'chronyd.service', 'memcached.service', 'rsyslog.service']
      const bootEditableValid = units.filter(u => u.bootEditable === true).every(u => allowedBoot.includes(u.unit))
      check('BOOT-ITEMS-OBSERVED', view.status === 200 && ['read', 'unavailable'].includes(view.data?.state) && bootEditableValid, { status: view.status, state: view.data?.state ?? null, units: units.length })
      refused('START-ACTION-VALIDATION', await root.post('/api/server/service-manager/action', {
        action: 'start', unit: 'rsyslog.service', expectedRevision: rev,
      }), 'VALIDATION')
      refused('MALFORMED-UNIT-VALIDATION', await root.post('/api/server/service-manager/action', {
        action: 'enable', unit: 'bad..unit', expectedRevision: rev,
      }), 'VALIDATION')
    },
  }),
]
