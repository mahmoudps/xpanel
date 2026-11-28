import { tool } from './kit.mjs'

const ZERO_REV = '0'.repeat(64)
const revOf = value => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : ZERO_REV)

export default [
  tool('reseller-acl-lists', {
    prefix: 'S21T01',
    probe: '/api/resellers/acl-lists',
    paths: /^\/api\/resellers\/acl-lists(?:\/[A-Za-z0-9_-]+)?$/,
    unit: [{
      id: 'S21T01-UNIT-1',
      file: 'apps/api/src/reseller-workspace.test.ts',
      name: 'reseller privilege lists and Email All Resellers saves a privilege list and resets many resellers to it',
    }],
    checks: ['ACL-LISTS-READ', 'ACL-LIST-SAVED-AND-DELETED', 'UNKNOWN-LIST-DELETE-404'],
    async run({ root, tag, check, refused, undo }) {
      const read = await root.get('/api/resellers/acl-lists')
      check('ACL-LISTS-READ', read.status === 200 && Array.isArray(read.data?.lists), {
        status: read.status,
        count: Array.isArray(read.data?.lists) ? read.data.lists.length : null,
      })
      const name = `xq-${tag}-acl`
      undo(`acl list ${name}`, async () => {
        const res = await root.delete(`/api/resellers/acl-lists/${name}`)
        return res.status === 200 || res.status === 404
      })
      const saved = await root.put(`/api/resellers/acl-lists/${name}`, { acl: ['list-accounts'] })
      const removed = await root.delete(`/api/resellers/acl-lists/${name}`)
      check('ACL-LIST-SAVED-AND-DELETED', saved.status === 200 && saved.data?.list?.name === name && removed.status === 200, {
        saveStatus: saved.status,
        deleteStatus: removed.status,
      })
      refused('UNKNOWN-LIST-DELETE-404', await root.delete(`/api/resellers/acl-lists/xq-${tag}-missing`), 'NOT_FOUND')
    },
  }),

  tool('remote-service-ips', {
    prefix: 'S21T02',
    probe: '/api/server/remote-service-ips',
    paths: /^\/api\/server\/remote-service-ips$/,
    unit: [{
      id: 'S21T02-UNIT-1',
      file: 'apps/api/src/remote-service-ips-workspace.test.ts',
      name: 'Remote Service IPs workspace saves the lists, reconciles mail, re-applies DNS, and the saved lists render into both configurations',
    }],
    checks: ['REMOTE-IPS-READ', 'INVALID-CIDR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/remote-service-ips')
      const lists = read.data?.lists
      check('REMOTE-IPS-READ', read.status === 200 && Array.isArray(lists?.smtp) && Array.isArray(lists?.nameservers), {
        status: read.status,
        smtp: Array.isArray(lists?.smtp) ? lists.smtp.length : null,
        nameservers: Array.isArray(lists?.nameservers) ? lists.nameservers.length : null,
      })
      refused('INVALID-CIDR-REFUSED', await root.put('/api/server/remote-service-ips', { smtp: ['not-an-ip'], nameservers: [] }), 'VALIDATION')
    },
  }),

  tool('nameserver-report', {
    prefix: 'S21T03',
    probe: '/api/server/dns/nameserver-report',
    page: { route: '/whm/dns/more', read: '/api/server/dns/nameserver-report', shows: data => (data?.rows ?? []).map(row => row.zone) },
    paths: /^\/api\/server\/dns\/nameserver-report(?:\?unknown=1)?$/,
    unit: [{
      id: 'S21T03-UNIT-1',
      file: 'apps/api/src/nameserver-report-workspace.test.ts',
      name: 'Cross-zone nameserver delegation report route computes per-zone apex NS targets, statuses, reseller/account attribution, and summary counts',
    }],
    checks: ['NAMESERVER-REPORT-READ', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/dns/nameserver-report')
      check(
        'NAMESERVER-REPORT-READ',
        read.status === 200
          && typeof read.data?.totalZones === 'number'
          && typeof read.data?.matchedZones === 'number'
          && typeof read.data?.customZones === 'number'
          && typeof read.data?.missingZones === 'number'
          && Array.isArray(read.data?.rows),
        { status: read.status, totalZones: read.data?.totalZones ?? null },
      )
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/dns/nameserver-report?unknown=1'), 'VALIDATION')
    },
  }),

  tool('connect-devices', {
    prefix: 'S21T04',
    as: 'owner',
    needs: ['account', 'mailbox'],
    probe: '/api/account/email/connect-devices',
    paths: /^\/api\/account\/email\/connect-devices(?:\/(?:autoconfig\.xml|apple\.mobileconfig|send-instructions))?(?:\?.*)?$/,
    unit: [{
      id: 'S21T04-UNIT-1',
      file: 'apps/api/src/mail/account-device-setup.test.ts',
      name: 'account-level connect devices bridge returns settings and download links for any selected owned mailbox and reuses device-setup renderers',
    }],
    checks: ['CONNECT-DEVICES-READ', 'FOREIGN-MAILBOX-NOT-FOUND', 'INVALID-SEND-EMAIL-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const mailbox = fixture.mailbox?.address ?? `xq@${fixture.domain}`
      const read = await owner.get(`/api/account/email/connect-devices?mailbox=${encodeURIComponent(mailbox)}`)
      check(
        'CONNECT-DEVICES-READ',
        read.status === 200
          && Array.isArray(read.data?.context?.mailboxes)
          && Array.isArray(read.data?.incoming)
          && Array.isArray(read.data?.outgoing),
        { status: read.status, mailbox: read.data?.mailbox ?? null },
      )
      refused('FOREIGN-MAILBOX-NOT-FOUND', await owner.get('/api/account/email/connect-devices?mailbox=missing@foreign.invalid'), 'NOT_FOUND')
      refused('INVALID-SEND-EMAIL-REFUSED', await owner.post('/api/account/email/connect-devices/send-instructions', {
        mailbox,
        email: 'not-an-address',
      }), 'VALIDATION')
    },
  }),

  tool('webmail-dav-collections', {
    prefix: 'S21T05',
    as: 'owner',
    also: ['mailbox'],
    needs: ['account', 'mailbox'],
    probe: '/api/account/mailx/collections',
    page: { route: '/mail/settings/calendars', read: '/api/webmail/calendars' },
    paths: /^\/api\/(?:account\/mailx\/collections|webmail\/calendars)(?:\?bad=1)?$/,
    unit: [{
      id: 'S21T05-UNIT-1',
      file: 'apps/api/src/mailx-collections.test.ts',
      name: 'mail collection settings saves defaults, descriptions, address books and task lists as the collections devices sync',
    }],
    checks: ['DAV-COLLECTIONS-READ', 'QUERY-SELECTOR-REFUSED'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/account/mailx/collections')
      check('DAV-COLLECTIONS-READ', read.status === 200 && Array.isArray(read.data?.mailboxes), {
        status: read.status,
        mailboxes: Array.isArray(read.data?.mailboxes) ? read.data.mailboxes.length : null,
      })
      refused('QUERY-SELECTOR-REFUSED', await owner.get('/api/account/mailx/collections?bad=1'), 'VALIDATION')
    },
  }),

  tool('webmail-dav-sharing', {
    prefix: 'S21T06',
    as: 'owner',
    also: ['mailbox'],
    needs: ['account', 'mailbox'],
    probe: '/api/account/collaboration',
    page: { route: '/mail/settings/calendars', read: '/api/webmail/calendars' },
    paths: /^\/api\/(?:account\/collaboration(?:\?bad=1)?|webmail\/calendars)$/,
    unit: [{
      id: 'S21T06-UNIT-1',
      file: 'apps/api/src/account-collaboration-workspace.test.ts',
      name: 'account collaboration using actual authority and existing calendar writer reflects read and read-write same-account sharing ACLs while hiding foreign grantees',
    }],
    checks: ['COLLABORATION-SHARING-READ', 'MAILBOX-CALENDARS-READ'],
    async run({ owner, mailbox, check }) {
      const ownerView = await owner.get('/api/account/collaboration')
      const mboxView = await mailbox.get('/api/webmail/calendars')
      check('COLLABORATION-SHARING-READ', ownerView.status === 200 && Array.isArray(ownerView.data?.mailboxes), {
        status: ownerView.status,
      })
      check('MAILBOX-CALENDARS-READ', mboxView.status === 200 && Array.isArray(mboxView.data?.calendars), {
        status: mboxView.status,
      })
    },
  }),

  tool('calendars-contacts-sharing', {
    prefix: 'S21T07',
    as: 'owner',
    needs: ['account', 'mailbox'],
    probe: '/api/account/collaboration',
    paths: /^\/api\/account\/collaboration(?:\?bad=1)?$/,
    unit: [{
      id: 'S21T07-UNIT-1',
      file: 'apps/api/src/account-collaboration-workspace.test.ts',
      name: 'account collaboration using actual authority and existing calendar writer returns only current owned metadata and effective same-account sharing, without content or internal identities',
    }],
    checks: ['CALENDARS-SHARING-READ', 'QUERY-SELECTOR-REFUSED'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/account/collaboration')
      check('CALENDARS-SHARING-READ', read.status === 200 && Array.isArray(read.data?.mailboxes), {
        status: read.status,
        mailboxes: Array.isArray(read.data?.mailboxes) ? read.data.mailboxes.length : null,
      })
      refused('QUERY-SELECTOR-REFUSED', await owner.get('/api/account/collaboration?bad=1'), 'VALIDATION')
    },
  }),

  tool('spam-quarantine', {
    prefix: 'S21T08',
    as: 'owner',
    needs: ['account', 'mailbox'],
    probe: '/api/mail/quarantine',
    paths: /^\/api\/mail\/quarantine(?:\/(?:release|delete|expire))?(?:\?.*)?$/,
    unit: [{
      id: 'S21T08-UNIT-1',
      file: 'apps/api/src/completion-quarantine-security.test.ts',
      name: 'quarantine authenticated loopback HTTP reads only the owned source through the native gateway with a pinned context',
    }],
    checks: ['QUARANTINE-STATE-READ', 'FOREIGN-MAILBOX-REFUSED'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/mail/quarantine')
      check('QUARANTINE-STATE-READ', read.status === 200 && typeof read.data?.quarantine?.state === 'string', {
        status: read.status,
        quarantineState: read.data?.quarantine?.state ?? null,
      })
      refused('FOREIGN-MAILBOX-REFUSED', await owner.get('/api/mail/quarantine?mailbox=missing@foreign.invalid'), 'NOT_FOUND')
    },
  }),

  tool('traffic-monitor-account', {
    prefix: 'S21T09',
    as: 'owner',
    needs: ['account'],
    probe: '/api/account/traffic-monitor',
    paths: /^\/api\/account\/traffic-monitor(?:\/block-ip)?(?:\?.*)?$/,
    unit: [{
      id: 'S21T09-UNIT-1',
      file: 'apps/api/src/account-traffic-workspace.test.ts',
      name: 'account traffic monitor workspace projects bounded telemetry without internal IDs or control characters and allows owned domain selection',
    }],
    checks: ['ACCOUNT-TRAFFIC-READ', 'INVALID-BLOCK-IP-REFUSED'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/account/traffic-monitor')
      check(
        'ACCOUNT-TRAFFIC-READ',
        read.status === 200
          && ['read', 'no_domains'].includes(read.data?.state)
          && Array.isArray(read.data?.recentRequests)
          && Array.isArray(read.data?.topClientIps),
        { status: read.status, state: read.data?.state ?? null },
      )
      refused('INVALID-BLOCK-IP-REFUSED', await owner.post('/api/account/traffic-monitor/block-ip', {
        expectedRevision: revOf(read.data?.ipBlocker?.revision),
        ip: '127.0.0.1',
      }), 'VALIDATION')
    },
  }),

  tool('git-deployments', {
    prefix: 'S21T10',
    as: 'owner',
    needs: ['account'],
    probe: '/api/account/git',
    paths: /^\/api\/account\/git(?:\?.*)?$/,
    unit: [{
      id: 'S21T10-UNIT-1',
      file: 'apps/agent/src/account-git.test.ts',
      name: 'deployment tasks of a repository supports deployment release history, rollback to a recorded commit and webhook rotation',
    }],
    checks: ['GIT-DEPLOYMENTS-READ', 'INVALID-ROLLBACK-TARGET-REFUSED'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/account/git')
      check('GIT-DEPLOYMENTS-READ', read.status === 200 && Array.isArray(read.data?.repositories) && typeof read.data?.revision === 'string', {
        status: read.status,
        repositories: Array.isArray(read.data?.repositories) ? read.data.repositories.length : null,
      })
      refused('INVALID-ROLLBACK-TARGET-REFUSED', await owner.post('/api/account/git', {
        op: 'rollback',
        path: 'repo',
        targetCommit: 'not-a-commit',
        expectedRevision: revOf(read.data?.revision),
      }), 'VALIDATION')
    },
  }),
]
