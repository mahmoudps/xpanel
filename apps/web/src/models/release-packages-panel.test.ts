import { describe, expect, it } from 'vitest'
import { profileFor, releaseFeatures } from '../../../../packages/os/src/index.ts'
import { SUPPORTED_FIXTURES } from '../../../../packages/os/src/fixtures.ts'
import { RELEASE_FEATURE_LABELS, releasePackages } from './release-packages-panel.ts'
import { SVC_PANELS } from './svc-panels.ts'

describe('release packages panel', { tags: ['unit'] }, () => {
  it.each(Object.entries(SUPPORTED_FIXTURES))('names every feature the agent reports on %s', (_name, release) => {
    expect(releaseFeatures(profileFor(release)).map(feature => feature.id).filter(id => !Object.hasOwn(RELEASE_FEATURE_LABELS, id))).toEqual([])
  })
  it('sits on the upgrade page and retries with the observed revision', () => {
    expect(SVC_PANELS['/whm/server/upgrade']).toContain(releasePackages)
    expect(releasePackages.tool).toBe('panel-upgrade')
    expect(releasePackages.sections[0]!.buttons![0]).toMatchObject({ op: 'post', url: '/api/server/upgrade/packages/retry', revision: true })
  })
})
