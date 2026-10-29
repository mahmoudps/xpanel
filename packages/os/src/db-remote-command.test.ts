import { describe, expect, it } from 'vitest'
import { DB_REMOTE_MAX_ELEMENTS, canonicalDbRemoteSources, dbRemoteListArgv, dbRemoteReplaceArgv, isDatabaseRemoteCommand } from './db-remote-command.ts'

describe('remote database nft grammar', () => {
  it('admits the exact list commands and the canonical atomic replacement only', () => {
    expect(isDatabaseRemoteCommand(dbRemoteListArgv(4))).toBe(true)
    expect(isDatabaseRemoteCommand(['/usr/sbin/nft', '-j', 'list', 'set', 'inet', 'xpanel', 'xpanel_banned'])).toBe(false)
    const argv = dbRemoteReplaceArgv(['198.51.100.7', '192.0.2.0/24', '2001:db8::7'])
    expect(argv).toEqual(['/usr/sbin/nft', 'flush set inet xpanel xpanel_dbremote4; flush set inet xpanel xpanel_dbremote6; add element inet xpanel xpanel_dbremote4 { 192.0.2.0/24, 198.51.100.7 }; add element inet xpanel xpanel_dbremote6 { 2001:db8::7 }'])
    expect(isDatabaseRemoteCommand(argv)).toBe(true)
    expect(isDatabaseRemoteCommand(dbRemoteReplaceArgv([]))).toBe(true)
    for (const bad of [
      ['/usr/sbin/nft', 'flush set inet xpanel xpanel_dbremote4; flush set inet xpanel xpanel_dbremote6; add element inet xpanel xpanel_dbremote4 { 198.51.100.7, 192.0.2.0/24 }'],
      ['/usr/sbin/nft', 'flush set inet xpanel xpanel_dbremote4; flush set inet xpanel xpanel_dbremote6; add element inet xpanel xpanel_dbremote4 { 2001:db8::7 }'],
      ['/usr/sbin/nft', 'flush set inet xpanel xpanel_dbremote4; flush set inet xpanel xpanel_dbremote6; add element inet xpanel xpanel_dbremote4 { 0.0.0.0/0 }'],
      ['/usr/sbin/nft', 'flush set inet xpanel xpanel_dbremote4; flush set inet xpanel xpanel_dbremote6; flush ruleset'],
      ['/usr/sbin/nft', '-f', '-'], ['/usr/bin/nft', argv[1]!], [...argv, 'extra'],
    ]) expect(isDatabaseRemoteCommand(bad)).toBe(false)
  })
  it('canonicalizes, de-duplicates and drops contained networks; refuses wide or non-canonical sources and capacity', () => {
    expect(canonicalDbRemoteSources(['192.0.2.7', '192.0.2.0/24', '192.0.2.0/24', '10.0.0.0/8', '10.1.0.0/16'])).toEqual({ v4: ['10.0.0.0/8', '192.0.2.0/24'], v6: [] })
    for (const bad of ['192.0.2.1/24', '0.0.0.0/0', '2001:db8::/64', '192.0.2.07', 'example.test', 7]) expect(() => canonicalDbRemoteSources([bad])).toThrow()
    const many = Array.from({ length: DB_REMOTE_MAX_ELEMENTS + 1 }, (_, index) => '10.' + Math.floor(index / 256) + '.' + (index % 256) + '.1')
    expect(() => canonicalDbRemoteSources(many)).toThrow('remote_database_source_capacity')
  })
})
