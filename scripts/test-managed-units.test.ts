import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MANAGED_UNIT_NAMES, renderManagedUnits, renderManagedUnitPlan, runManagedUnitCli } from './managed-units.mjs'
import { renderRenewalUnits } from './management-tls.mjs'

const options = (programRoot = '/opt/xpanel/releases/0.1.1', lifecycleParticipants = true) => ({ nodePath: '/usr/bin/node', programRoot, lifecycleParticipants })
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

// Frozen from the pre-extraction installer heredocs and TLS template at fd60318,
// normalized to LF; they are independent of the shared renderer implementation.
const legacy = {
  flat: [
    { unitName: 'xpanel.slice', contentSha256: 'ae4f6f23c8446818e3b6192c2a6c96a3906fbe749adf160ee06fc879d1bf6414' },
    { unitName: 'xpanel-agent.service', contentSha256: 'c7a5d965169b0ae6a4eb31b960c43846e2ab6353208e69fae9ce444cc0fc4d96' },
    { unitName: 'xpanel-api.service', contentSha256: 'fc0b3edf7adf973db1ab50bd2c6a27275e4bb598b2aed735ae562b11cb4910b4' },
    { unitName: 'xpanel-management-tls.service', contentSha256: 'ac6f9a81099e8837ac41c6b7d73bf4ef6680636ed360d901eded7ad6dd5572f2' },
    { unitName: 'xpanel-management-tls.timer', contentSha256: 'db51768489a1636b96635c165727b9c64b0fc06d7029cb5fe47000711c856acc' },
  ],
  current: [
    { unitName: 'xpanel.slice', contentSha256: 'ae4f6f23c8446818e3b6192c2a6c96a3906fbe749adf160ee06fc879d1bf6414' },
    { unitName: 'xpanel-agent.service', contentSha256: '808aabb5036d0995d12de1f42c13b038d7d998740862509b4b7b14b31df2d8fd' },
    { unitName: 'xpanel-api.service', contentSha256: '602018f43c9ea575eb58f370c473b98feeb4425466e4866f14c3e4cf62e03575' },
    { unitName: 'xpanel-management-tls.service', contentSha256: '020d5b946294bf638dc5e63ef140dbc02ec973d3c4c67b766ae703db4a16b3f6' },
    { unitName: 'xpanel-management-tls.timer', contentSha256: 'db51768489a1636b96635c165727b9c64b0fc06d7029cb5fe47000711c856acc' },
  ],
} as const

describe('managed unit rendering; no host, ownership or activation proof', () => {
  it.each(['flat', 'current'] as const)('preserves every prior %s unit byte', layout => {
    const units = renderManagedUnitPlan(options(layout === 'flat' ? '/opt/xpanel' : '/opt/xpanel/current', layout === 'current'))
    expect(Object.keys(units)).toEqual(MANAGED_UNIT_NAMES)
    expect(Object.isFrozen(units)).toBe(true)
    // Each record identifies a unit and its frozen content checksum.
    const expected = new Map<string, string>(legacy[layout].map(entry => [entry.unitName, entry.contentSha256] as const))
    expect([...expected.keys()]).toEqual(MANAGED_UNIT_NAMES)
    for (const name of MANAGED_UNIT_NAMES) expect(sha(units[name]), name).toBe(expected.get(name))
  })

  it('keeps the shipped flat service contracts exactly aligned', () => {
    const units = renderManagedUnits(options('/opt/xpanel', false))
    for (const name of ['xpanel-agent.service', 'xpanel-api.service'] as const) {
      expect(units[name]).toBe(readFileSync(new URL(`../deploy/systemd/${name}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
    }
  })

  it('changes all actual entrypaths together while preserving privileges and timer semantics', () => {
    const before = renderManagedUnits(options('/opt/xpanel/releases/0.1.0'))
    const after = renderManagedUnits(options('/opt/xpanel/releases/0.1.1'))
    for (const name of MANAGED_UNIT_NAMES) {
      expect(after[name], name).toBe(before[name].replaceAll('/opt/xpanel/releases/0.1.0', '/opt/xpanel/releases/0.1.1'))
      expect(after[name]).not.toContain('/opt/xpanel/current')
    }
    for (const role of ['agent', 'api'] as const) {
      expect(after[`xpanel-${role}.service`]).toContain('WorkingDirectory=/opt/xpanel/releases/0.1.1\n')
      expect(after[`xpanel-${role}.service`]).toContain(`/opt/xpanel/releases/0.1.1/apps/${role}/src/main.ts`)
    }
    expect(after['xpanel-management-tls.service']).toContain('ExecStart=/usr/bin/node /opt/xpanel/releases/0.1.1/scripts/management-tls.mjs renew\n')
    expect(after['xpanel-api.service']).toContain('ReadWritePaths=/var/lib/xpanel /var/log/xpanel /run/xpanel/lifecycle-api\n')
    expect(after['xpanel-agent.service']).toContain('Group=xpanel-agent\nSupplementaryGroups=xpanel\n')
  })

  it.each(['/opt/xpanel/current', '/opt/xpanel/releases/01.1.0', '/opt/xpanel/releases/0.1.1-rc.1', '/opt/xpanel/releases/0.1.1/', '/opt/xpanel/releases/0.1.0/../0.1.1', '/tmp/release', '/opt/xpanel\nUser=root', '/opt/xpanel/releases/%i'])('refuses ambiguous or movable live program root %j', programRoot => {
    expect(() => renderManagedUnits(options(programRoot))).toThrow('PROGRAM_ROOT_INVALID')
  })

  it.each(['node', '/usr/bin/node\nExecStart=/bin/sh', '/usr/bin/node --eval=x', '/opt/%i/node', '/opt/$RUNTIME/node', '/opt/../bin/node', '/opt//node', '/opt/./node', '/opt/node;', '/opt/node\0', 'C:/node.exe'])('refuses executable expansion or unit injection %j', nodePath => {
    expect(() => renderManagedUnits({ ...options(), nodePath })).toThrow('NODE_PATH_INVALID')
  })

  it('requires an explicit participant choice and rejects silent option misspellings', () => {
    expect(() => renderManagedUnits({ ...options(), lifecycleParticipants: 1 } as never)).toThrow('UNIT_PARTICIPANTS_INVALID')
    expect(() => renderManagedUnits({ nodePath: '/usr/bin/node', programRoot: '/opt/xpanel' } as never)).toThrow('UNIT_OPTIONS_INVALID')
    expect(() => renderManagedUnits({ ...options(), unitPath: '/etc/systemd/system/ssh.service' } as never)).toThrow('UNIT_OPTIONS_INVALID')
    expect(() => renderManagedUnits({ ...options(), get nodePath() { throw new Error('must not evaluate accessor') } })).toThrow('UNIT_OPTIONS_INVALID')
  })

  it('keeps TLS compatibility previews and renders native TLS against the resolved release', () => {
    for (const layout of ['flat', 'current'] as const) {
      const units = renderRenewalUnits('/usr/bin/node', layout)
      const expected = new Map<string, string>(legacy[layout].map(entry => [entry.unitName, entry.contentSha256] as const))
      expect(sha(units.service)).toBe(expected.get('xpanel-management-tls.service'))
      expect(sha(units.timer)).toBe(expected.get('xpanel-management-tls.timer'))
    }
    const units = renderRenewalUnits('/usr/bin/node', '/opt/xpanel/releases/0.1.1')
    expect(units.service).toBe(renderManagedUnits(options())['xpanel-management-tls.service'])
    expect(units.service).not.toContain('/current/')
  })

  it('prints only the requested unit and has no writer or activation parameters', () => {
    const output: string[] = [], errors: string[] = []
    const io = { stdout: { write: (value: string) => output.push(value) }, stderr: { write: (value: string) => errors.push(value) } }
    expect(runManagedUnitCli(['render', 'xpanel-api.service', '--node-path=/usr/bin/node', '--program-root=/opt/xpanel/releases/0.1.1', '--participants=1'], io)).toBe(0)
    expect(output).toEqual([renderManagedUnits(options())['xpanel-api.service']])
    expect(errors).toEqual([])
  })

  it.each([
    ['render', 'ssh.service', '--node-path=/usr/bin/node', '--program-root=/opt/xpanel', '--participants=0'],
    ['render', 'xpanel-api.service', '--node-path=/usr/bin/node', '--program-root=/opt/xpanel/current', '--participants=1'],
    ['render', 'xpanel-api.service', '--node-path=/usr/bin/node', '--node-path=/private-input', '--participants=0'],
    ['render', 'xpanel-api.service', '--node-path=/usr/bin/node', '--program-root=/opt/xpanel', '--participants=2'],
    ['render', 'xpanel-api.service', '--node-path=/usr/bin/node', '--program-root=/opt/xpanel', '--participants=0', '--write=/private-input'],
  ])('refuses CLI ambiguity without echoing caller data (%j)', (...args) => {
    const output: string[] = [], errors: string[] = []
    const code = runManagedUnitCli(args, { stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) } })
    expect(code).toBe(1)
    expect(output).toEqual([])
    expect(errors).toEqual(['Managed unit rendering failed.\n'])
  })
})
