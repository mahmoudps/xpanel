import { describe, expect, it } from 'vitest'
import { defaultServerWebSettings, effectiveServerWebSettings, validateServerWebSettings } from './server-web-settings.ts'

const web = () => ({
  timeoutSec: 60,
  clientMaxBodyMb: 128,
  tlsProtocols: ['TLSv1.3', 'TLSv1.2'],
  tlsCiphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:@SECLEVEL=2',
  gzip: { enabled: true, level: 5 },
  directoryIndex: ['index.php', 'index.html'],
  rlimitMemMb: null,
  rlimitCpuSec: 240,
  includes: { apachePreMain: '', apachePreVhost: '', apachePostVhost: '', nginxHttp: 'server_tokens off;' },
})

describe('server web settings', { tags: ['unit'] }, () => {
  it('keeps valid settings in canonical protocol order', () => {
    expect(validateServerWebSettings(web())).toEqual({ ...web(), tlsProtocols: ['TLSv1.2', 'TLSv1.3'] })
  })

  it('applies valid defaults while nothing is saved', () => {
    expect(validateServerWebSettings(defaultServerWebSettings())).toEqual(defaultServerWebSettings())
    expect(effectiveServerWebSettings({})).toEqual(defaultServerWebSettings())
    expect(effectiveServerWebSettings({ web: web() as never })).toEqual(web())
  })

  it('refuses missing, unknown and out-of-range fields', () => {
    const missing: Record<string, unknown> = web()
    delete missing.timeoutSec
    for (const bad of [null, missing, { ...web(), extra: 1 }, { ...web(), timeoutSec: 0 }, { ...web(), clientMaxBodyMb: 10241 },
      { ...web(), tlsProtocols: ['TLSv1.1'] }, { ...web(), tlsProtocols: [] }, { ...web(), tlsCiphers: 'AES128; include /etc/passwd' },
      { ...web(), gzip: { enabled: true, level: 10 } }, { ...web(), directoryIndex: ['../x'] }, { ...web(), rlimitMemMb: 0 },
      { ...web(), includes: { ...web().includes, nginxHttp: 'a\0b' } }, { ...web(), includes: { nginxHttp: '' } }]) {
      expect(() => validateServerWebSettings(bad)).toThrow()
    }
  })
})
