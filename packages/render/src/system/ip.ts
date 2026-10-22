// Small views over core's address model (packages/core/src/rules/firewall.ts), which is the only
// parser. Core maps `::ffff:a.b.c.d` to IPv4 while parsing, so every address here is canonical.

import { cidrContains, formatCidr, parseCidr } from '@xpanel/core'
import type { Cidr, IpAddress } from '@xpanel/core'

export type IpFamily = 4 | 6

const LOOPBACK: readonly Cidr[] = [parseCidr('127.0.0.0/8') as Cidr, parseCidr('::1') as Cidr]

export const ipBits = (ip: Pick<IpAddress, 'version'>): number => (ip.version === 4 ? 32 : 128)

/** Canonical text form (RFC 5952 for IPv6). */
export const formatIp = (ip: IpAddress): string => formatCidr({ version: ip.version, value: ip.value, prefix: ipBits(ip) })

export const isLoopback = (ip: IpAddress): boolean => LOOPBACK.some((c) => cidrContains(c, ip))

/** 127.0.0.0/8 or a subnet of it, or ::1. Such sources only ever arrive on lo. */
export const isLoopbackCidr = (c: Cidr): boolean =>
  c.version === 4 ? c.prefix >= 8 && cidrContains(LOOPBACK[0] as Cidr, c) : c.prefix === 128 && c.value === 1n
