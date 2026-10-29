import { describe, expect, it } from 'vitest'
import type { OsProfile } from '@xpanel/core'
import { planMailRouting, type MailRoutingRecords } from './mail-routing.ts'
import { renderDovecotSieveConf, renderPostfixMaps, renderSieveScript, sieveConfigTest } from './mail.ts'
import { AUTOREPLY_ADDRESS_RE, autoreplyAddress } from './mail-autoreply.ts'

const os = { paths: { postfixDir: '/etc/postfix', dovecotDir: '/etc/dovecot' }, services: { postfix: 'postfix', dovecot: 'dovecot' } } as unknown as OsProfile
const account = { username: 'alice', uid: 2001, gid: 2001, home: '/home/alice' }
const ctx = {
  domains: [{ name: 'alice-shop.com', accountId: 'acct-a' }, { name: 'bob.test', accountId: 'acct-b' }],
  mailboxes: [{ login: 'info@alice-shop.com', accountId: 'acct-a', id: 'u-info' }, { login: 'sales@alice-shop.com', accountId: 'acct-a', id: 'u-sales' }, { login: 'bob@bob.test', accountId: 'acct-b', id: 'u-bob' }],
}
const records = (patch: Partial<MailRoutingRecords>): MailRoutingRecords => ({ forwarders: [], domainForwarders: [], defaultAddresses: [], filters: [], vacations: [], ...patch })
const maps = (plan: ReturnType<typeof planMailRouting>, domain = 'alice-shop.com') => {
  const route = plan.domains.get(domain) ?? { forwarders: [], rejects: [] }
  const rendered = renderPostfixMaps(os, [{ domain, account, mailboxes: [{ local: 'info', passwordHash: '{BLF-CRYPT}$2y$10$' + 'a'.repeat(53), quotaMb: 100 }], ...route }])
  return Object.fromEntries(rendered.files.map(file => [file.path.split('/').pop(), file.content]))
}
const filter = (patch: Record<string, unknown>) => ({ id: 'f1', accountId: 'acct-a', scope: 'mailbox', mailbox: 'info@alice-shop.com', name: 'Suppliers', priority: 1, enabled: true, matchAll: true,
  conditions: [{ field: 'from', comparator: 'contains', value: '@atlas-pack.example' }], actions: [{ type: 'fileinto', target: 'Suppliers' }, { type: 'stop' }], ...patch })
const vacation = (patch: Record<string, unknown> = {}) => ({ mailbox: 'info@alice-shop.com', ownerAuthority: { accountId: 'acct-a', serviceUserId: 'u-info', mailbox: 'info@alice-shop.com' }, enabled: true, subject: 'Away until 2 January', body: 'Back soon.', htmlBody: '',
  startDate: '2026-10-24T00:00:00.000Z', endDate: '2026-10-25T06:00:00.000Z', replyIntervalHours: 8, ...patch })

describe('account mail routing plan', () => {
  it('renders forwarders, rejecting addresses and a forwarding default address into the Postfix maps', () => {
    const plan = planMailRouting(ctx, records({
      forwarders: [
        { id: 'a', accountId: 'acct-a', sourceAddress: 'orders@alice-shop.com', destinations: ['sales@alice-shop.com', 'Warehouse@Partner.example'] },
        { id: 'b', accountId: 'acct-a', sourceAddress: 'old@alice-shop.com', action: 'reject', destinations: [], rejectMessage: 'This address is no longer used' },
      ],
      defaultAddresses: [{ accountId: 'acct-a', domain: 'alice-shop.com', kind: 'forward', destination: 'info@alice-shop.com' }],
    }))
    expect(plan.issues).toEqual([])
    const files = maps(plan)
    expect(files.virtual_aliases).toContain('orders@alice-shop.com\tsales@alice-shop.com,warehouse@partner.example\n')
    expect(files.virtual_aliases).toContain('@alice-shop.com\tinfo@alice-shop.com\n')
    // identity entry so the catch-all does not swallow the real mailbox
    expect(files.virtual_aliases).toContain('info@alice-shop.com\tinfo@alice-shop.com\n')
    expect(files.recipient_access).toContain('old@alice-shop.com\tREJECT 5.1.1 This address is no longer used\n')
  })

  it('routes an address autoresponder to a hidden user and refuses one on a mailbox, a rejected address or a foreign domain', () => {
    const responder = (address: string, patch: Record<string, unknown> = {}) => ({ accountId: 'acct-a', address, enabled: true, subject: 'Thanks', body: 'Soon.', htmlBody: '', startDate: null, endDate: null, replyIntervalHours: 48, ...patch })
    const plan = planMailRouting(ctx, records({
      forwarders: [{ id: 'b', accountId: 'acct-a', sourceAddress: 'old@alice-shop.com', action: 'reject', destinations: [], rejectMessage: 'Gone' }],
      autoresponders: [responder('Orders@alice-shop.com'), responder('info@alice-shop.com'), responder('old@alice-shop.com'), responder('x@bob.example'), responder('off@alice-shop.com', { enabled: false })],
    }))
    const target = autoreplyAddress('acct-a', 'orders@alice-shop.com')
    expect(target).toMatch(AUTOREPLY_ADDRESS_RE)
    expect(plan.autoreplies).toEqual([{ accountId: 'acct-a', domain: 'alice-shop.com', local: 'orders', address: 'orders@alice-shop.com', target }])
    expect(plan.domains.get('alice-shop.com')?.autoreplies).toEqual(['orders'])
    const script = plan.scripts.find(item => item.address === target)!.script
    expect(script).toContain('vacation :days 2 :subject "Thanks" :from "orders@alice-shop.com" :addresses ["orders@alice-shop.com"] "Soon.";\n\ndiscard;')
    expect(plan.issues.map(issue => [issue.kind, issue.id])).toEqual([['autoresponder', 'info@alice-shop.com'], ['autoresponder', 'old@alice-shop.com'], ['autoresponder', 'x@bob.example']])
  })

  it('rejects unknown addresses of a reject-default domain with 550 No such user here and passes known ones on', () => {
    const files = maps(planMailRouting(ctx, records({
      forwarders: [{ id: 'a', accountId: 'acct-a', sourceAddress: 'orders@alice-shop.com', destinations: ['sales@alice-shop.com'] },
        { id: 'b', accountId: 'acct-a', sourceAddress: 'old@alice-shop.com', action: 'reject', destinations: [], rejectMessage: 'Gone' }],
    })))
    expect(files.recipient_access).toContain('alice-shop.com\t550 5.1.1 No such user here\n')
    expect(files.recipient_access).toContain('info@alice-shop.com\tDUNNO\n')
    expect(files.recipient_access).toContain('orders@alice-shop.com\tDUNNO\n')
    // an address's own rejection stays ahead of the domain key
    expect(files.recipient_access).toContain('old@alice-shop.com\tREJECT 5.1.1 Gone\n')
    const forwarding = maps(planMailRouting(ctx, records({ defaultAddresses: [{ accountId: 'acct-a', domain: 'alice-shop.com', kind: 'forward', destination: 'info@alice-shop.com' }] })))
    expect(forwarding.recipient_access).not.toContain('No such user here')
  })

  it('discards through the discard transport and rewrites a domain forwarder to the target domain', () => {
    const discard = maps(planMailRouting(ctx, records({ defaultAddresses: [{ accountId: 'acct-a', domain: 'alice-shop.com', kind: 'discard', destination: null }] })))
    expect(discard.virtual_aliases).toContain('@alice-shop.com\tdiscard@xpanel-discard.invalid\n')
    expect(discard.transport).toContain('xpanel-discard.invalid\tdiscard:default-address\n')
    const plan = planMailRouting(ctx, records({
      domainForwarders: [{ id: 'd', accountId: 'acct-a', sourceDomain: 'alice-shop.com', targetDomain: 'alice.example' }],
      defaultAddresses: [{ accountId: 'acct-a', domain: 'alice-shop.com', kind: 'discard', destination: null }],
    }))
    expect(maps(plan).virtual_aliases).toContain('@alice-shop.com\t@alice.example\n')
    expect(plan.issues).toEqual([{ kind: 'default-address', id: 'alice-shop.com', reason: expect.stringContaining('domain forwarder') }])
  })

  it('reports a record for a domain of another account instead of rendering it', () => {
    const plan = planMailRouting(ctx, records({
      forwarders: [{ id: 'x', accountId: 'acct-a', sourceAddress: 'bob@bob.test', destinations: ['thief@evil.example'] }],
      domainForwarders: [{ id: 'y', accountId: 'acct-a', sourceDomain: 'bob.test', targetDomain: 'evil.example' }],
      defaultAddresses: [{ accountId: 'acct-a', domain: 'bob.test', kind: 'forward', destination: 'thief@evil.example' }],
      filters: [filter({ id: 'z', mailbox: 'bob@bob.test' })],
      vacations: [vacation({ mailbox: 'nobody@alice-shop.com' })],
    }))
    expect(plan.domains.get('bob.test')).toBeUndefined()
    expect(plan.scripts).toEqual([])
    expect(plan.issues.map(issue => [issue.kind, issue.id])).toEqual([
      ['domain-forwarder', 'y'], ['forwarder', 'x'], ['default-address', 'bob.test'], ['filter', 'z'], ['autoresponder', 'nobody@alice-shop.com'],
    ])
  })

  it('leaves out only the invalid record and keeps the rest of the domain', () => {
    const plan = planMailRouting(ctx, records({ forwarders: [
      { id: 'ok', accountId: 'acct-a', sourceAddress: 'team@alice-shop.com', destinations: ['out@example.test'] },
      { id: 'bad', accountId: 'acct-a', sourceAddress: 'pipe@alice-shop.com', destinations: ['|/bin/sh'] },
      { id: 'mailbox', accountId: 'acct-a', sourceAddress: 'info@alice-shop.com', action: 'reject', destinations: [], rejectMessage: 'gone' },
    ] }))
    expect(plan.domains.get('alice-shop.com')!.forwarders).toEqual([{ local: 'team', to: ['out@example.test'] }])
    expect(plan.issues.map(issue => issue.id)).toEqual(['bad', 'mailbox'])
  })

  it('builds one Sieve script per mailbox: account rules, then mailbox rules, then the autoresponder', () => {
    const plan = planMailRouting(ctx, records({
      filters: [
        filter({ id: 'm', priority: 1 }),
        filter({ id: 'g', scope: 'global', mailbox: null, name: 'Invoices', priority: 5, conditions: [{ field: 'subject', comparator: 'contains', value: 'Invoice' }], actions: [{ type: 'fileinto', target: 'Invoices 2026' }, { type: 'mark-read' }] }),
        filter({ id: 'off', enabled: false, name: 'Paused', actions: [{ type: 'discard' }] }),
      ],
      vacations: [vacation(), vacation({ mailbox: 'sales@alice-shop.com', enabled: false })],
    }))
    expect(plan.issues).toEqual([])
    expect(plan.scripts.map(script => script.address)).toEqual(['info@alice-shop.com', 'sales@alice-shop.com'])
    const info = plan.scripts[0]!.script
    expect(info.indexOf('# rule: Invoices')).toBeLessThan(info.indexOf('# rule: Suppliers'))
    expect(info).not.toContain('Paused')
    // several actions in order; without stop the mailbox's own rules still run
    expect(info).toContain('fileinto :create "Invoices 2026";\n  addflag "\\\\Seen";\n}')
    expect(info).toContain('vacation :seconds 28800 :subject "Away until 2 January" :from "info@alice-shop.com" :addresses ["info@alice-shop.com"] "Back soon.";')
    expect(info).toContain('currentdate :zone "+0000" :comparator "i;octet" :value "ge" "iso8601" "2026-10-24T00:00:00"')
    expect(info).toContain('currentdate :zone "+0000" :comparator "i;octet" :value "lt" "iso8601" "2026-10-25T06:00:00"')
    expect(info).toMatch(/^# managed by xPanel\nrequire \["date", "fileinto", "imap4flags", "mailbox", "relational", "vacation", "vacation-seconds"\];/)
    expect(plan.scripts[1]!.script).not.toContain('vacation')
  })

  it('does not let a responder saved for an earlier mailbox answer for a recreated one', () => {
    const plan = planMailRouting(ctx, records({ vacations: [vacation({ ownerAuthority: { accountId: 'acct-a', serviceUserId: 'u-old', mailbox: 'info@alice-shop.com' } }), vacation({ mailbox: 'sales@alice-shop.com', ownerAuthority: undefined })] }))
    expect(plan.scripts).toEqual([])
    expect(plan.issues.map(issue => issue.reason)).toEqual([expect.stringContaining('ownership review'), expect.stringContaining('ownership review')])
  })

  it('keeps an unconditional rule and refuses a filter the renderer cannot express safely', () => {
    const plan = planMailRouting(ctx, records({ filters: [
      filter({ id: 'all', conditions: [], actions: [{ type: 'redirect', target: 'archive@example.test' }, { type: 'stop' }] }),
      filter({ id: 'folder', actions: [{ type: 'fileinto', target: '../../etc' }] }),
      filter({ id: 'field', conditions: [{ field: 'x-spam', comparator: 'is', value: 'yes' }] }),
    ] }))
    expect(plan.scripts[0]!.script).toContain('if true {\n  redirect "archive@example.test";\n  stop;\n}')
    expect(plan.issues.map(issue => issue.id)).toEqual(['folder', 'field'])
  })

  it('uses whole days when the interval is a multiple of 24 hours and sends HTML as multipart', () => {
    const script = renderSieveScript({ vacation: { subject: 'Away', body: 'Plain', htmlBody: '<p>Plain</p>', hours: 48 } })
    expect(script).toContain('vacation :days 2 :subject "Away" :mime "MIME-Version: 1.0\nContent-Type: multipart/alternative;')
    expect(script).not.toContain('vacation-seconds')
    expect(() => renderSieveScript({ vacation: { subject: 'Away', body: 'x', start: '2026-10-25T00:00:00Z', end: '2026-10-24T00:00:00Z' } })).toThrow(/start is after end/)
    expect(() => renderSieveScript({ vacation: { subject: 'Away', body: 'x', start: '2026-10-25', end: '2026-10-26T00:00:00Z' } })).toThrow(/both/)
  })

  it('loads per-mailbox Sieve after the distribution file and checks staged scripts with sievec', () => {
    const conf = renderDovecotSieveConf(os)
    expect(conf.path).toBe('/etc/dovecot/conf.d/95-xpanel-sieve.conf')
    expect(conf.content).toContain('sieve = file:~/mail/%Ld/%Ln/sieve;active=~/mail/%Ld/%Ln/.dovecot.sieve')
    expect(conf.content).toContain('sieve_extensions = +vacation-seconds')
    expect(conf.content).toContain('mail_plugins = $mail_plugins sieve')
    expect(sieveConfigTest().argv).toEqual(['/usr/bin/sievec', '-x', '+vacation-seconds', '/tmp/xpanel-sieve-check'])
  })
})
