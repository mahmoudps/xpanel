import { describe, expect, it } from 'vitest'
import type { Account } from '@xpanel/core'
import { parseMailAuthOptions, preparedAccountZone } from './account-provisioning-prepared.ts'
import type { PreparedAccountRecord } from './account-provisioning-prepared.ts'

describe('email authentication options at account creation', () => {
  it('refuses DMARC without SPF and DKIM, and values other than 0 or 1', () => {
    expect(() => parseMailAuthOptions({ dmarc: 1, spf: 0 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseMailAuthOptions({ dkim: 0 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(() => parseMailAuthOptions({ spf: 'off' })).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(parseMailAuthOptions({})).toEqual([])
    expect(parseMailAuthOptions({ dmarc: 0, spf: 0, dkim: 0 })).toEqual(['spf', 'dmarc'])
  })
  it('leaves the switched-off records out of the new zone', () => {
    const account = { id: '11111111-1111-4111-8111-111111111111', primaryDomain: 'alpha.example.test', ipv4: '192.0.2.10', ipv6: null, contactEmail: 'owner@alpha.example.test' } as unknown as Account
    const zone = (omitMailAuth?: readonly ('spf' | 'dmarc')[]) => preparedAccountZone({ reference: 'r', desiredState: { template: null, nameservers: ['ns1.example.test', 'ns2.example.test'], serial: 2026110701, omitMailAuth } } as unknown as PreparedAccountRecord, account).records
    const has = (records: ReturnType<typeof zone>, text: string) => records.some(record => record.type === 'TXT' && (record.name + ' ' + record.content).includes(text))
    expect(has(zone(), 'v=spf1')).toBe(true); expect(has(zone(), '_dmarc')).toBe(true)
    expect(has(zone(['spf', 'dmarc']), 'v=spf1')).toBe(false); expect(has(zone(['spf', 'dmarc']), '_dmarc')).toBe(false)
  })
})
