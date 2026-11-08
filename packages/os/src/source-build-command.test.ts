import { describe, expect, it } from 'vitest'
import { isSourceBuildCommand, SOURCE_BUILD_MODULES, SOURCE_BUILD_PACKAGES_ARGV, sourceBuildArgv } from './source-build-command.ts'

const script = '/opt/xpanel/releases/0.1.30/scripts/el-source-builds.sh'

describe('source build grammar', { tags: ['unit'] }, () => {
  it('admits exactly the argv it builds', () => {
    expect(isSourceBuildCommand(SOURCE_BUILD_PACKAGES_ARGV)).toBe(true)
    for (const module of SOURCE_BUILD_MODULES) expect(isSourceBuildCommand(sourceBuildArgv(script, module))).toBe(true)
  })

  it('bounds every build by priority, CPU, memory, the OOM order and time', () => {
    expect(sourceBuildArgv(script, 'fts-xapian').slice(0, -3)).toEqual(expect.arrayContaining(['--property=Nice=19', '--property=IOSchedulingClass=idle', '--property=CPUQuota=50%', '--property=MemoryMax=512M', '--property=OOMScoreAdjust=1000', '--property=RuntimeMaxSec=1800']))
  })

  it('refuses another script, module, package or unit setting', () => {
    expect(isSourceBuildCommand(sourceBuildArgv('/tmp/el-source-builds.sh', 'awstats'))).toBe(false)
    expect(isSourceBuildCommand(sourceBuildArgv('/opt/xpanel/../tmp/scripts/el-source-builds.sh', 'awstats'))).toBe(false)
    expect(isSourceBuildCommand(sourceBuildArgv(script, 'kernel' as never))).toBe(false)
    expect(isSourceBuildCommand([...SOURCE_BUILD_PACKAGES_ARGV, 'kernel'])).toBe(false)
    const widened = sourceBuildArgv(script, 'awstats'); widened[widened.indexOf('--property=MemoryMax=512M')] = '--property=MemoryMax=infinity'
    expect(isSourceBuildCommand(widened)).toBe(false)
    expect(isSourceBuildCommand(sourceBuildArgv(script, 'awstats').slice(0, -1))).toBe(false)
  })
})
