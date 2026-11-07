import { describe, expect, it } from 'vitest'
import { renderSourceBuildHook, SOURCE_BUILD_HOOK, SOURCE_BUILD_MARKER } from './source-builds.ts'

describe('renderSourceBuildHook', { tags: ['unit'] }, () => {
  it('only leaves a marker, in the three-field form of the dnf plugin, for what the builds depend on', () => {
    const file = renderSourceBuildHook()
    expect(file).toMatchObject({ path: SOURCE_BUILD_HOOK, mode: 0o644, owner: 'root', group: 'root' })
    const lines = file.content.split('\n').filter(line => line && !line.startsWith('#'))
    expect(lines.map(line => line.split(':')[0])).toEqual(['httpd*', 'dovecot*', 'gd*', 'libpng*', 'zlib*', 'perl*'])
    for (const line of lines) expect(line.split(':').slice(1).join(':')).toBe(`in:/usr/bin/touch ${SOURCE_BUILD_MARKER}`)
  })
})
