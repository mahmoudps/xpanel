import { describe, expect, it } from 'vitest'
import { dovecotPasswdFile, dovecotPasswdLine, renderPostfixMaps } from '../services/mail.ts'
import { movedTarget } from './account-edge.ts'
import { renderNginxSite } from './nginx.ts'
import { account, debianOs, domain, settings } from './testkit.ts'

const HASH = '{SHA512-CRYPT}$6$rounds=5000$abcdefgh$' + 'a'.repeat(86)
const moved = { deny: [], cacheEpoch: null, movedTo: '192.0.2.10' }
const mailbox = { local: 'info', passwordHash: HASH, quotaMb: 50 as const }

describe('a moved account on its old server', () => {
  it('answers through the destination under the requested name while suspended', () => {
    const site = renderNginxSite(account({ status: 'suspended' }), [domain()], settings(), undefined, { accountEdge: moved })
    expect(site).toContain('proxy_pass https://192.0.2.10;')
    expect(site).toContain('proxy_ssl_name $host;')
    expect(site).toContain('proxy_ssl_server_name on;')
    expect(site).toContain('proxy_set_header Host $host;')
    expect(site).not.toContain('/usr/share/xpanel/suspended')
    // ACME keeps working on the name until DNS has moved
    expect(site).toContain('.well-known/acme-challenge')
  })
  it('stops proxying once the account is active, and an ordinary suspension keeps its page', () => {
    expect(renderNginxSite(account(), [domain()], settings(), undefined, { accountEdge: moved })).not.toContain('192.0.2.10')
    const page = renderNginxSite(account({ status: 'suspended' }), [domain()], settings(), undefined, { accountEdge: { deny: [], cacheEpoch: null } })
    expect(page).toContain('/usr/share/xpanel/suspended')
    expect(page).not.toContain('proxy_pass')
  })
  it('accepts one IPv4 address only', () => {
    for (const bad of ['192.0.2.0/24', '2001:db8::1', 'example.com', '192.0.2.10;evil']) expect(() => movedTarget(bad)).toThrow()
  })
  it('passes mailbox logins through instead of refusing them', () => {
    const line = dovecotPasswdLine(account(), 'example.com', { ...mailbox, suspendLogin: true, proxyHost: '192.0.2.10' })
    expect(line).toContain('proxy=y host=192.0.2.10 starttls=any-cert')
    expect(line).not.toContain('nologin=y')
    const file = dovecotPasswdFile(debianOs, { domain: 'example.com', account: account(), login: 'denied', proxyHost: '192.0.2.10', mailboxes: [mailbox] })
    expect(file.content).toContain('proxy=y')
    expect(dovecotPasswdFile(debianOs, { domain: 'example.com', account: account(), login: 'denied', mailboxes: [mailbox] }).content).toContain('nologin=y')
    expect(() => dovecotPasswdLine(account(), 'example.com', { ...mailbox, proxyHost: 'a b' })).toThrow()
  })
  it('keeps recipient checks and sends accepted mail straight to the destination', () => {
    const { files } = renderPostfixMaps(debianOs, [{ domain: 'example.com', account: account(), proxyHost: '192.0.2.10', delivery: 'accept', mailboxes: [mailbox] }])
    expect(files.find(file => /transport$/.test(file.path))?.content).toContain('example.com')
    expect(files.find(file => /transport$/.test(file.path))?.content).toContain('smtp:[192.0.2.10]:25')
    expect(files.some(file => file.content.includes('info@example.com'))).toBe(true)
  })
})
