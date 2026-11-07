import { describe, expect, it } from 'vitest'
import { parseTweakValues } from './index.ts'
import { assertDomainTweaks, zoneDefaultsFromTweaks } from './domains.ts'

const base = { values: parseTweakValues(null), privileged: false, name: 'shop.example.com', accountId: 'a', home: '/home/bob', defaultDocRoot: '/home/bob/domains/shop.example.com/public_html', hostname: 'srv.example.net', others: [] as { name: string; accountId: string }[] }
const reason = (over: Partial<typeof base> & { docRoot?: string }): unknown => { try { assertDomainTweaks({ ...base, ...over }) } catch (error) { return (error as { detail?: { reason?: unknown } }).detail?.reason } return 'accepted' }

describe('Tweak Settings: Domains', { tags: ['unit'] }, () => {
  it('keeps a chosen document root inside public_html', () => {
    const values = { ...base.values, 'domains.docrootPublicHtml': true }
    expect(reason({ docRoot: '/home/bob/shop', values })).toBe('DOCROOT_OUTSIDE_PUBLIC_HTML')
    expect(reason({ docRoot: '/home/bob/public_html/shop', values })).toBe('accepted')
    expect(reason({ docRoot: base.defaultDocRoot, values })).toBe('accepted')
    expect(reason({ docRoot: '/home/bob/shop' })).toBe('accepted')
  })

  it('refuses hostname subdomains, cross-account subdomains and common domains for users only', () => {
    expect(reason({ name: 'x.srv.example.net' })).toBe('hostname_subdomain')
    expect(reason({ name: 'x.srv.example.net', values: { ...base.values, 'domains.hostnameSubdomains': true } })).toBe('accepted')
    expect(reason({ name: 'a.other.test', others: [{ name: 'other.test', accountId: 'b' }] })).toBe('cross_account_subdomain')
    expect(reason({ name: 'a.other.test', others: [{ name: 'other.test', accountId: 'a' }] })).toBe('accepted')
    expect(reason({ name: 'mail.google.com' })).toBe('common_domain')
    expect(reason({ name: 'mail.google.com', privileged: true })).toBe('accepted')
  })
})

describe('resolution and zone tweaks', () => {
  const input = { privileged: false, name: 'new.example.test', accountId: 'a', home: '/home/a', defaultDocRoot: '/home/a/domains/x', hostname: null, others: [] }
  it('refuses a remote or unregistered domain only when its key is off, and never for root or an unknown answer', () => {
    expect(() => assertDomainTweaks({ ...input, values: { 'domains.allowRemote': false }, resolution: 'elsewhere' })).toThrow('another server')
    expect(() => assertDomainTweaks({ ...input, values: { 'domains.allowUnregistered': false }, resolution: 'unregistered' })).toThrow('does not resolve')
    expect(() => assertDomainTweaks({ ...input, values: { 'domains.allowRemote': false, 'domains.allowUnregistered': false }, resolution: 'unknown' })).not.toThrow()
    expect(() => assertDomainTweaks({ ...input, privileged: true, values: { 'domains.allowRemote': false }, resolution: 'elsewhere' })).not.toThrow()
  })
  it('turns the zone keys into default zone options', () => {
    expect(zoneDefaultsFromTweaks({})).toEqual({ serviceSubdomains: false, autodiscover: true, nameserverRecords: true })
    expect(zoneDefaultsFromTweaks({ 'domains.serviceSubdomains': true, 'domains.autodiscoverRecords': false, 'domains.nameserverRecords': false })).toEqual({ serviceSubdomains: true, autodiscover: false, nameserverRecords: false })
  })
})

