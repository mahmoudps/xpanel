import { tool } from './kit.mjs'

const INDEX = '/api/server/default-index', SITE = '/api/server/default-site'
const UNBOUND = 'xq-unbound.invalid'
const SSH = '/api/server/ssh', FIREWALL = '/api/firewall'
const FIREWALL_PAGE = { route: '/whm/security/firewall', read: FIREWALL, shows: data => (data?.rules ?? []).filter(rule => ['port', 'ip', 'forward'].includes(rule.kind)).map(rule => rule.comment).filter(Boolean) }

/** An unbound name may be refused outright, which a visitor sees as a dropped connection. */
const visit = (site, name) => site.get(name, '/').catch(() => ({ status: null, headers: {}, text: '' }))

export default [
  // A driver never changes SSH or the firewall: a wrong write could end every path to the host. It reads them and proves the refusals.
  tool('aapanel-ssh-settings', {
    prefix: 'SSHCFG', probe: SSH, paths: /^\/api\/server\/ssh$/, requests: 4,
    unit: [{ id: 'SSHCFG-UNIT-LOCKOUT', file: 'apps/api/src/ssh-workspace.test.ts', name: 'SSH settings refuses a policy that leaves no way in, before anything is saved' }, { id: 'SSHCFG-UNIT-PORT', file: 'apps/api/src/ssh-workspace.test.ts', name: 'SSH port change opens the new port, proves it, then closes the old one' }],
    checks: ['POLICY-OBSERVED', 'NO-AUTH-METHOD-REFUSED', 'STALE-REVISION-CONFLICT'],
    async run({ root, check, refused }) {
      const view = await root.get(SSH), saved = view.data?.settings
      check('POLICY-OBSERVED', view.status === 200 && Number.isInteger(saved?.port) && typeof saved?.revision === 'string', { status: view.status })
      refused('NO-AUTH-METHOD-REFUSED', await root.put(SSH, { port: saved?.port, passwordAuth: false, pubkeyAuth: false, rootLogin: 'prohibit-password', expectedRevision: saved?.revision }), 'NO_AUTH_METHOD')
      refused('STALE-REVISION-CONFLICT', await root.put(SSH, { port: saved?.port ?? 22, passwordAuth: saved?.passwordAuth ?? true, pubkeyAuth: saved?.pubkeyAuth ?? true, rootLogin: saved?.rootLogin ?? 'prohibit-password', expectedRevision: '0'.repeat(64) }), 'CONFLICT')
    },
  }),

  tool('aapanel-ssh-service', {
    prefix: 'SSHSVC', probe: SSH, paths: /^\/api\/server\/ssh(?:\/service)?$/, requests: 3,
    unit: [{ id: 'SSHSVC-UNIT-STOP', file: 'apps/agent/src/ssh-host.test.ts', name: 'SSH host routes stops the socket and the service, then proves the port refuses' }],
    checks: ['DAEMON-AND-COUNTS-OBSERVED', 'INVALID-SERVICE-ACTION-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get(SSH), host = view.data?.host
      check('DAEMON-AND-COUNTS-OBSERVED', view.status === 200 && typeof host?.service?.active === 'string' && Number.isInteger(host?.today?.accepted) && Number.isInteger(host?.total?.failed), { status: view.status, active: host?.service?.active ?? null })
      refused('INVALID-SERVICE-ACTION-REFUSED', await root.post('/api/server/ssh/service', { action: 'reload' }), 'VALIDATION')
    },
  }),

  tool('aapanel-ssh-login-alarm', {
    prefix: 'SSHALM', probe: SSH, paths: /^\/api\/server\/ssh(?:\/login-alarm)?$/, requests: 3,
    unit: [{ id: 'SSHALM-UNIT-ONE', file: 'apps/api/src/ssh-login-alarm.test.ts', name: 'SSH login alarm sends one webhook per login with the address, and moves the cursor past it' }, { id: 'SSHALM-UNIT-TWICE', file: 'apps/api/src/ssh-login-alarm.test.ts', name: 'SSH login alarm never reports one journal entry twice, even when the cursor write was lost' }],
    checks: ['SWITCH-OBSERVED', 'INVALID-ALARM-PAYLOAD-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get(SSH)
      check('SWITCH-OBSERVED', view.status === 200 && typeof view.data?.settings?.loginAlarm === 'boolean' && Array.isArray(view.data?.alarmChannels), { status: view.status })
      refused('INVALID-ALARM-PAYLOAD-REFUSED', await root.put('/api/server/ssh/login-alarm', { enabled: 'yes' }), 'VALIDATION')
    },
  }),

  tool('aapanel-firewall-switch', {
    prefix: 'FWSW', probe: FIREWALL, page: FIREWALL_PAGE, paths: /^\/api\/firewall(?:\/policy)?$/, requests: 3,
    unit: [{ id: 'FWSW-UNIT-SEED', file: 'apps/api/src/firewall-workspace.test.ts', name: 'firewall switch and ping block writes the safe rules on a first switch-on, hosted services included' }, { id: 'FWSW-UNIT-RENDER', file: 'packages/render/src/system/nftables.test.ts', name: 'firewall switch and ping block leaves the list out with the switch off and keeps the guards' }],
    checks: ['SWITCH-OBSERVED', 'INVALID-POLICY-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get(FIREWALL)
      check('SWITCH-OBSERVED', view.status === 200 && typeof view.data?.enabled === 'boolean', { status: view.status, enabled: view.data?.enabled ?? null })
      refused('INVALID-POLICY-REFUSED', await root.put('/api/firewall/policy', { enabled: 'yes', blockPing: false, expectedRevision: view.data?.revision ?? '0'.repeat(64) }), 'VALIDATION')
    },
  }),

  tool('aapanel-icmp-block', {
    prefix: 'ICMP', probe: FIREWALL, page: FIREWALL_PAGE, paths: /^\/api\/firewall(?:\/confirm)?$/, requests: 3,
    unit: [{ id: 'ICMP-UNIT-RENDER', file: 'packages/render/src/system/nftables.test.ts', name: 'firewall switch and ping block drops ping ahead of the list on both families, with the switch on or off, and keeps the ICMP errors' }],
    checks: ['SWITCH-OBSERVED', 'UNKNOWN-CONFIRM-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get(FIREWALL)
      check('SWITCH-OBSERVED', view.status === 200 && typeof view.data?.blockPing === 'boolean', { status: view.status, blockPing: view.data?.blockPing ?? null })
      refused('UNKNOWN-CONFIRM-NOT-FOUND', await root.post('/api/firewall/confirm', { id: '00000000-0000-4000-8000-000000000000' }), 'NOT_FOUND')
    },
  }),

  tool('aapanel-default-index', {
    prefix: 'AADI', as: 'root', also: ['owner'], needs: ['account'], probe: INDEX, requests: 40, requires_qualification_admission: true,
    paths: /^\/api\/(?:server\/default-index(?:\/[a-z0-9.-]{1,253}(?:\/(?:preview|reset))?)?|accounts\/[a-z][a-z0-9]{0,15}\/files)$/,
    unit: [
      { id: 'AADI-UNIT-SAVE', file: 'apps/api/src/default-index-workspace.test.ts', name: 'bounded root index workspace with real journaled desired state saves and resets canonical order with exact persisted readback and retained full domain/settings' },
      { id: 'AADI-UNIT-STALE', file: 'apps/api/src/default-index-workspace.test.ts', name: 'bounded root index workspace with real journaled desired state refuses stale concurrent index changes using the existing domain workspace CAS' },
    ],
    checks: ['HOME-SERVED-FIRST'],
    async run({ root, owner, fixture, tag, site, check, undo, until }) {
      const path = `${INDEX}/${fixture.domain}`, files = `/api/accounts/${fixture.username}/files`, marker = `xq-home-${tag}`
      const read = async () => (await root.get(path)).data?.configuration?.revision
      undo('index order', async () => (await root.post(`${path}/reset`, { expectedRevision: await read(), confirmation: fixture.domain })).status === 200)
      await owner.post(files, { op: 'write', path: 'public_html/home.html', content: marker })
      await owner.post(files, { op: 'write', path: 'public_html/index.php', content: '<?php echo "xq-index";' })
      const saved = await root.put(path, { expectedRevision: await read(), indexFiles: 'home.html,index.php', confirmation: fixture.domain })
      const served = saved.status === 200 ? await until(() => visit(site, fixture.domain), item => item.text.includes(marker), { attempts: 15 }) : { settled: false, last: null }
      check('HOME-SERVED-FIRST', served.settled, { save: saved.status, status: served.last?.status ?? null })
    },
  }),

  tool('aapanel-default-site', {
    prefix: 'AADS', as: 'root', also: ['owner'], needs: ['account'], probe: SITE, restores: [SITE], requests: 40, requires_qualification_admission: true,
    paths: /^\/api\/server\/default-site$/,
    unit: [
      { id: 'AADS-UNIT-SAVE', file: 'apps/api/src/default-site-workspace.test.ts', name: 'root default-site leaf with real settings authority and synthetic auth/apply ports saves only policy over the existing full settings, verifies persisted readback and makes no serving claim' },
      { id: 'AADS-UNIT-GATE', file: 'apps/api/src/default-site-workspace.test.ts', name: 'root default-site leaf with real settings authority and synthetic auth/apply ports enforces the actual qualification port without creating a saved success' },
    ],
    checks: ['UNKNOWN-HOST-SERVED-BY-SITE', 'NONE-UNBOUND-REFUSED'],
    async run({ root, fixture, site, check, undo, until }) {
      const current = await root.get(SITE), original = current.data?.configuration?.policy
      const save = async policy => root.put(SITE, { expectedRevision: (await root.get(SITE)).data?.configuration?.revision, policy })
      undo('default site policy', async () => (await save(original)).status === 200)
      const chosen = await save({ response: 'site', site: fixture.domain, refuseHttps: false })
      const served = chosen.status === 200 ? await until(() => visit(site, UNBOUND), item => item.status === 200, { attempts: 10 }) : { settled: false, last: null }
      check('UNKNOWN-HOST-SERVED-BY-SITE', served.settled, { save: chosen.status, status: served.last?.status ?? null })
      const refused = await save({ response: 'reject', redirectTo: null, refuseHttps: false })
      const unbound = refused.status === 200 ? await until(() => visit(site, UNBOUND), item => item.status === null || item.status >= 400, { attempts: 10 }) : { settled: false, last: null }
      check('NONE-UNBOUND-REFUSED', unbound.settled, { save: refused.status, status: unbound.last?.status ?? null })
    },
  }),
]
