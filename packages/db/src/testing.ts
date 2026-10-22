import type { PhpSettings } from '@xpanel/core'

/** Syntactically valid argon2id PHC string (not a real password). */
export const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'

export const sha = (c: string): string => c.repeat(64).slice(0, 64)

export const php = (over: Partial<PhpSettings> = {}): PhpSettings => ({
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 5,
    startServers: 1,
    minSpareServers: 1,
    maxSpareServers: 3,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: { memory_limit: '256M' },
  ...over,
})
