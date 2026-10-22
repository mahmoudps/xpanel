import { describe, expect, it } from 'vitest'
import { parseCidr, parseIp } from '@xpanel/core'
import type { Cidr, IpAddress } from '@xpanel/core'
import { formatIp, isLoopback, isLoopbackCidr } from './ip.ts'

const ip = (s: string): IpAddress => {
  const p = parseIp(s)
  if (!p) throw new Error(`bad ${s}`)
  return p
}

const cidr = (s: string): Cidr => {
  const c = parseCidr(s)
  if (!c) throw new Error(`bad ${s}`)
  return c
}

describe('formatIp', () => {
  it('prints canonical text for both families (RFC 5952), mapped IPv6 as IPv4', () => {
    expect(formatIp(ip('203.0.113.5'))).toBe('203.0.113.5')
    expect(formatIp(ip('0.0.0.0'))).toBe('0.0.0.0')
    expect(formatIp(ip('2001:0DB8:0000:0000:0000:0000:0000:0001'))).toBe('2001:db8::1')
    expect(formatIp(ip('::'))).toBe('::')
    expect(formatIp(ip('2001:db8:0:0:1:0:0:1'))).toBe('2001:db8::1:0:0:1')
    expect(formatIp(ip('::ffff:192.0.2.1'))).toBe('192.0.2.1')
  })
})

describe('isLoopback', () => {
  it('covers 127.0.0.0/8, ::1 and mapped loopback only', () => {
    for (const s of ['127.0.0.1', '127.255.255.254', '::1', '::ffff:127.0.0.1']) expect(isLoopback(ip(s)), s).toBe(true)
    for (const s of ['128.0.0.1', '126.255.255.255', '::2', '::', '0.0.0.0', 'fe80::1']) expect(isLoopback(ip(s)), s).toBe(false)
  })
})

describe('isLoopbackCidr', () => {
  it('is true only for subnets of 127.0.0.0/8 and for ::1/128', () => {
    for (const s of ['127.0.0.0/8', '127.0.0.1', '127.1.0.0/16', '::1']) expect(isLoopbackCidr(cidr(s)), s).toBe(true)
    for (const s of ['126.0.0.0/7', '0.0.0.0/0', '::/127', '::/0', '10.0.0.0/8']) expect(isLoopbackCidr(cidr(s)), s).toBe(false)
  })
})
