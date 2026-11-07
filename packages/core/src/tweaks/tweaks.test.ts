import { describe, expect, it } from 'vitest'
import { parseTweakValues, TWEAK_SETTINGS_STATE, TWEAKS, type TweakDefinition } from './index.ts'
import { assertPackageValues, packageDefaults } from './packages.ts'
import { redirectionValues } from './redirection.ts'
import { SETTINGS_INDEX } from './settings-index.ts'

const sample: TweakDefinition[] = [
  { key: 'logs.keepArchives', label: 'Keep archives', help: 'Help', consumer: '/whm/logs', kind: 'boolean', default: true },
  { key: 'logs.retentionDays', label: 'Retention', help: 'Help', consumer: '/whm/logs', kind: 'integer', default: null, min: 1, max: 365, nullable: true },
  { key: 'ssl.defaultKeyType', label: 'Key type', help: 'Help', consumer: '/whm/ssl', kind: 'choice', default: 'rsa-2048', choices: ['rsa-2048', 'ecdsa-p256'] },
]

describe('tweak settings registry', { tags: ['unit'] }, () => {
  it('gives every setting a section heading in the Advanced Settings Browser', () => {
    expect(SETTINGS_INDEX.filter(entry => !entry.groupLabel).map(entry => entry.key)).toEqual([])
  })
  it('registers unique keys, each with a section prefix and a consumer page', () => {
    expect(TWEAK_SETTINGS_STATE).toBe('extended/server/tweak-settings.json')
    const keys = TWEAKS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const d of TWEAKS) {
      expect(d.key).toMatch(/^(logs|server|compression|ssl|sql|domains|logging|security|status|support|software|packages|redirection)\.[A-Za-z0-9]+$/)
      expect(d.consumer).toMatch(/^\//)
    }
  })

  it('fills defaults and keeps saved values within each definition', () => {
    expect(parseTweakValues(null, sample)).toEqual({ 'logs.keepArchives': true, 'logs.retentionDays': null, 'ssl.defaultKeyType': 'rsa-2048' })
    expect(parseTweakValues({ 'logs.retentionDays': 30, 'ssl.defaultKeyType': 'ecdsa-p256' }, sample))
      .toEqual({ 'logs.keepArchives': true, 'logs.retentionDays': 30, 'ssl.defaultKeyType': 'ecdsa-p256' })
  })

  it('refuses unknown keys and out-of-definition values instead of dropping them', () => {
    for (const raw of [[], 'x', { 'logs.unknown': 1 }, { 'logs.keepArchives': 'yes' }, { 'logs.retentionDays': 0 }, { 'logs.retentionDays': 1.5 }, { 'ssl.defaultKeyType': 'dsa' }]) {
      expect(() => parseTweakValues(raw, sample)).toThrow()
    }
    expect(() => parseTweakValues({ 'logs.keepArchives': null }, sample)).toThrow()
  })

  it('takes only an https address or nothing for the sign-out address', () => {
    expect(redirectionValues(parseTweakValues({ 'redirection.logoutUrl': 'https://example.test/bye' })).logoutUrl).toBe('https://example.test/bye')
    expect(redirectionValues(parseTweakValues(null))).toEqual({ panelPaths: true, logoutUrl: null })
    for (const url of ['http://example.test/', 'javascript:alert(1)', 'https://exa mple.test/', 'https://' + 'a'.repeat(512)]) expect(() => parseTweakValues({ 'redirection.logoutUrl': url })).toThrow()
  })

  it('caps package values at the cPanel ceiling and leaves unlimited alone', () => {
    expect(packageDefaults(parseTweakValues(null))).toEqual({ mailboxQuotaMb: 1024, diskMb: 10240, bandwidthMbMonth: 1048576 })
    expect(() => assertPackageValues({ resources: { diskMb: 4294967296 }, defaultMailboxQuotaMb: 'unlimited' })).not.toThrow()
    expect(() => assertPackageValues({ resources: { diskMb: 4294967297 } })).toThrow()
    expect(() => assertPackageValues({ resources: { bandwidthMbMonth: 4294967297 } })).toThrow()
    expect(() => assertPackageValues({ defaultMailboxQuotaMb: 4294967297 })).toThrow()
  })
})
