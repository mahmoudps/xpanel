import { describe, expect, it } from 'vitest'
import {
  defaultServerRoles, defaultSpf, effectiveServerRoles, nextForwarderIp, roleDisabledFeatures, heldByMajorDelay, runsMoreThanDaily, selectAutomaticUpdate, serverRoleChanges, spfWithAddress,
  validateDomainForwards, validateForwardUrl, validateMaintenanceSchedule, validatePanelTlsPolicy, validateServerHostname, validateServerResolvers, validateServerRoles, validateSystemMailForwards, validateUpdatePreferences,
} from './server-operations.ts'

const reason = (run: () => unknown): unknown => { try { run() } catch (error) { return (error as { detail?: { reason?: unknown } }).detail?.reason } return 'accepted' }

describe('server operation rules', { tags: ['unit'] }, () => {
  it('applies the cPanel host name rules', () => {
    for (const name of ['www.example.com', '1host.example.com', 'host-', 'a'.repeat(52) + '.example.com', 'Host.Example.com', 'host', 'webmail.example.com']) expect(reason(() => validateServerHostname(name))).toBe('INVALID_HOSTNAME')
    expect(reason(() => validateServerHostname('shop.example.com', ['shop.example.com']))).toBe('INVALID_HOSTNAME')
    expect(validateServerHostname('server1.example.com')).toBe('server1.example.com')
  })

  it('takes two or three distinct resolvers in order', () => {
    expect(reason(() => validateServerResolvers(['192.0.2.1']))).toBe('resolver_count')
    expect(reason(() => validateServerResolvers(['192.0.2.1', '192.0.2.1']))).toBe('resolver_duplicate')
    expect(reason(() => validateServerResolvers(['192.0.2.1', 'dns.example.com']))).toBe('resolver_invalid')
    expect(validateServerResolvers(['192.0.2.2', '192.0.2.1', '2001:db8::1'])).toEqual(['192.0.2.2', '192.0.2.1', '2001:db8::1'])
  })

  it('keeps forward targets out of nginx syntax and takes the next free address', () => {
    for (const url of ['ftp://example.org/', 'https://example.org/$host', 'https://example.org/"x', 'https://a b/', 'https://user:pw@example.org/']) expect(reason(() => validateForwardUrl(url))).toBe('forward_url_invalid')
    expect(validateForwardUrl('https://example.net/landing?a=1')).toBe('https://example.net/landing?a=1')
    const pool = [{ address: '192.0.2.1', version: 4, isPrimary: true }, { address: '192.0.2.2', version: 4, isPrimary: false, reserved: true }, { address: '2001:db8::1', version: 6, isPrimary: false }, { address: '192.0.2.3', version: 4, isPrimary: false }, { address: '192.0.2.4', version: 4, isPrimary: false }] as const
    expect(nextForwarderIp(pool, new Set(['192.0.2.3']))).toBe('192.0.2.4')
    expect(reason(() => nextForwarderIp(pool, new Set(['192.0.2.3', '192.0.2.4'])))).toBe('NO_FREE_IP')
    const row = { domain: 'example.org', url: 'https://example.net/', ip: '192.0.2.3', createdAt: '2026-11-07T00:00:00.000Z' }
    expect(validateDomainForwards([row])).toEqual([row])
    expect(() => validateDomainForwards([row, row])).toThrow(/once/)
  })

  it('appends the main address to SPF and keeps every other term', () => {
    expect(spfWithAddress('v=spf1 include:x ~all', '192.0.2.1')).toBe('v=spf1 include:x +ip4:192.0.2.1 ~all')
    expect(spfWithAddress('v=spf1 +ip4:192.0.2.1 ~all', '192.0.2.1')).toBeNull()
    expect(spfWithAddress('v=spf1 redirect=_spf.example.net', '192.0.2.1')).toBe('v=spf1 +ip4:192.0.2.1 redirect=_spf.example.net')
    expect(defaultSpf('192.0.2.1')).toBe('v=spf1 +a +mx +ip4:192.0.2.1 ~all')
  })

  it('resolves profiles and daemon choices to one role set', () => {
    const full = defaultServerRoles(), dnsOnly = validateServerRoles({ profile: 'dns-only', optional: [], dnsServer: 'powerdns', ftpServer: 'pure-ftpd' })
    expect([...effectiveServerRoles(dnsOnly)]).toEqual(['dns'])
    expect(serverRoleChanges(full, dnsOnly)).toEqual(['web', 'mail', 'spam', 'ftp', 'mysql'].map(role => ({ role, change: 'disable' })))
    expect(roleDisabledFeatures(dnsOnly)).toContain('ftpaccts')
    expect(roleDisabledFeatures(full)).toEqual([])
    expect(serverRoleChanges(full, { ...full, ftpServer: 'disabled' })).toEqual([{ role: 'ftp', change: 'disable' }])
    expect(reason(() => validateServerRoles({ ...full, optional: ['web'] }))).toBe('optional_role_invalid')
    expect(reason(() => validateServerRoles({ ...full, profile: 'bind' }))).toBe('profile_unknown')
    expect(reason(() => validateServerRoles({ ...full, dnsServer: 'bind' }))).toBe('daemon_choice_invalid')
  })

  it('validates system mail forwards', () => {
    expect(validateSystemMailForwards({ root: 'admin@example.net', nobody: 'root', xpanel: null })).toEqual({ root: 'admin@example.net', nobody: 'root', xpanel: null })
    expect(reason(() => validateSystemMailForwards({ root: 'root', nobody: null, xpanel: null }))).toBe('forward_target_invalid')
    expect(reason(() => validateSystemMailForwards({ root: 'a b@example.net', nobody: null, xpanel: null }))).toBe('forward_target_invalid')
  })

  it('validates the panel TLS policy', () => {
    expect(validatePanelTlsPolicy({ protocols: ['TLSv1.3', 'TLSv1.2'], ciphers: 'HIGH:!aNULL' })).toEqual({ protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'HIGH:!aNULL' })
    expect(reason(() => validatePanelTlsPolicy({ protocols: ['TLSv1.1'], ciphers: 'HIGH' }))).toBe('tls_protocols_invalid')
    expect(reason(() => validatePanelTlsPolicy({ protocols: ['TLSv1.2'], ciphers: 'HIGH; include x' }))).toBe('tls_ciphers_invalid')
  })

  it('validates schedules and warns about more than one run a day', () => {
    expect(validateMaintenanceSchedule({ updater: '0 2 * * *' })).toEqual({ updater: '0 2 * * *' })
    for (const updater of ['60 2 * * *', '0 2 * * 7', '0 2 * *']) expect(() => validateMaintenanceSchedule({ updater })).toThrow()
    expect(runsMoreThanDaily('0 2 * * *')).toBe(false)
    expect(runsMoreThanDaily('*/5 2 * * *')).toBe(true)
    expect(runsMoreThanDaily('0 * * * *')).toBe(true)
  })

  it('bounds automatic updates by tier and never moves security patches across a minor', () => {
    const prefs = { tier: 'release', updates: 'manual', securityPatches: true } as const
    expect(selectAutomaticUpdate('1.2.3', ['1.2.4', '1.2.9', '1.3.0', '2.0.0'], prefs)).toBe('1.2.9')
    expect(selectAutomaticUpdate('1.2.3', ['1.3.0', '2.0.0'], prefs)).toBeNull()
    expect(selectAutomaticUpdate('1.2.3', ['1.2.4'], { ...prefs, securityPatches: false })).toBeNull()
    expect(selectAutomaticUpdate('1.2.3', ['1.3.0', '2.0.0'], { ...prefs, updates: 'automatic' })).toBe('1.3.0')
    expect(selectAutomaticUpdate('1.2.3', ['1.3.0', '2.0.0'], { ...prefs, updates: 'automatic', tier: 'long-term' })).toBeNull()
    expect(selectAutomaticUpdate('1.2.3', ['1.3.0', '2.0.0'], { ...prefs, updates: 'automatic', tier: 'edge' })).toBe('2.0.0')
    expect(selectAutomaticUpdate('1.2.3', ['1.2.3', '1.2.1'], prefs)).toBeNull()
    expect(reason(() => validateUpdatePreferences({ tier: 'nightly', updates: 'manual', securityPatches: true, owner: null }))).toBe('update_tier_unknown')
  })
})

describe('major upgrade delay', () => {
  const now = new Date('2026-11-07T00:00:00.000Z')
  it('holds only another major version, until the delay has passed', () => {
    const seen = { '2.0.0': '2026-11-01T00:00:00.000Z', '3.0.0': '2026-10-01T00:00:00.000Z' }
    expect(heldByMajorDelay('1.2.3', ['1.3.0', '2.0.0', '3.0.0', '4.0.0'], seen, 10, now)).toEqual(['2.0.0', '4.0.0'])
    expect(heldByMajorDelay('1.2.3', ['2.0.0'], seen, 0, now)).toEqual([])
  })
  it('reads a saved file from before the field as no delay', () => {
    expect(validateUpdatePreferences({ tier: 'release', updates: 'manual', securityPatches: true, owner: null }).majorDelayDays).toBe(0)
    expect(() => validateUpdatePreferences({ tier: 'release', updates: 'manual', securityPatches: true, majorDelayDays: 999, owner: null })).toThrow()
  })
})

