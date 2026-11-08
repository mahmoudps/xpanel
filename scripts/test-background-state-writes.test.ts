import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A live host operation (an account provisioning) is bound to the desired-state revision it read. Every write that a
// timer, a minute tick or a peer starts must therefore run in backgroundStateWrite, whose writer lease waits for it.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

/** StateStore methods that take the writer lock to change state, and the direct revision commit. */
const mutations = (): string[] => {
  const names = new Set<string>()
  let current: string | null = null
  for (const line of read('packages/state/src/store.ts').split('\n')) {
    const method = /^ {2}(?:async )?([a-zA-Z]\w*)(?:<[^>]*>)?\(/.exec(line)
    if (method) current = method[1]!
    if (current && /this\.with(?:Mutation|Journaled)\w*\(/.test(line) && !/^(?:get|read|list|with)/.test(current)) names.add(current)
  }
  return [...names]
}
const WRITE = new RegExp(`[.](?:${mutations().join('|')})[(]|commitAuthority[(]`)
const unwrapped = (text: string): string[] => text.split('\n').filter(line => WRITE.test(line) && !line.includes('backgroundStateWrite('))

/** Modules a timer or a peer drives: every desired-state write in them is a background write. */
const BACKGROUND_MODULES = ['apps/api/src/autossl.ts', 'apps/api/src/host-ddns.ts', 'apps/agent/src/dns-cluster-model.ts']
/** Background write sites inside modules that also serve requests. */
const BACKGROUND_SITES: [file: string, line: string][] = [
  ['apps/api/src/forward-certificate.ts', 'recordForwardCertificate(store, issued)'],
  ['apps/agent/src/main.ts', 'store.setBandwidthLimits('],
  ['apps/api/src/node-link.ts', 'state.secrets.announced = own.fingerprint'],
  ['apps/agent/src/reconciler.ts', 'clearIpReleasing(holds)'],
]
/** Timer-bearing modules whose writes an operator request starts. */
const REQUEST_WRITERS: Record<string, string> = {
  'apps/api/src/server.ts': 'request router',
  'apps/agent/src/server.ts': 'request router',
  'apps/api/src/firewall-workspace.ts': 'reverts an unconfirmed firewall change at its deadline; a lockout guard never waits',
  'apps/api/src/transfer-workspace.ts': 'continues an operator transfer after a restart',
  'apps/api/src/lifecycle-transfer-execution.ts': 'runs an operator transfer',
}
const TIMER = /setInterval\(|setTimeout\(|async tick\(|tick: async|function \w+(?:Tick|Cycle)\(/
const sources = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap(name => {
  const path = join(dir, name)
  if (statSync(join(ROOT, path)).isDirectory()) return name === 'testing' ? [] : sources(path)
  return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.includes('fixture') ? [path.split(sep).join('/')] : []
})

describe('background desired-state writes', () => {
  it('knows the desired-state mutations of the store', () => {
    expect(mutations()).toEqual(expect.arrayContaining(['saveDnsZone', 'deleteDnsZone', 'createCertificate', 'saveCertificateBinding', 'setBandwidthLimits', 'clearIpReleasing']))
  })
  it.each(BACKGROUND_MODULES)('%s writes desired state only in backgroundStateWrite', file => {
    expect(WRITE.test(read(file)), file).toBe(true)
    expect(unwrapped(read(file))).toEqual([])
  })
  it.each(BACKGROUND_SITES)('%s writes in backgroundStateWrite at %s', (file, marker) => {
    const lines = read(file).split('\n').filter(line => line.includes(marker))
    expect(lines.length, marker).toBeGreaterThan(0)
    for (const line of lines) expect(line).toContain('backgroundStateWrite(')
  })
  it('finds no other timer-driven module writing desired state outside the helper', () => {
    const known = new Set([...BACKGROUND_MODULES, ...BACKGROUND_SITES.map(([file]) => file), ...Object.keys(REQUEST_WRITERS)])
    const found = [...sources('apps/api/src'), ...sources('apps/agent/src')].filter(file => !known.has(file))
      .filter(file => { const text = read(file); return TIMER.test(text) && unwrapped(text).length > 0 })
    expect(found).toEqual([])
  })
})
