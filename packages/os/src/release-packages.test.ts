import { describe, expect, it } from 'vitest'
import { installFiles, installPlan, profileFor } from './index.ts'
import { ALMA_9, SUPPORTED_FIXTURES, UBUNTU_2404 } from './fixtures.ts'
import { EL_SOURCE_BUILDS, releaseFeatures } from './release-packages.ts'
import type { InstallAction } from './index.ts'

const everything = { engine: 'apache' as const, apacheMpm: 'itk' as const, phpVersions: ['8.3'], withMail: true, withDns: true, withFtp: true, withMariaDb: true, withModSecurity: true }
const hosts = Object.values(SUPPORTED_FIXTURES).map(release => { const os = profileFor(release); return { id: os.id, versionId: os.versionId, os } })
const installed = (actions: readonly InstallAction[]): string[] => actions.flatMap(action => {
  if (action.kind !== 'exec' || !action.argv.includes('install')) return []
  return action.argv.slice(action.argv.indexOf('install') + 1).filter(value => !value.startsWith('-') && !value.startsWith('https://') && value !== 'epel-release')
})

describe('release package features', { tags: ['unit'] }, () => {
  it.each(hosts)('declare exactly what the installer installs on $id $versionId', ({ os }) => {
    const features = releaseFeatures(os).filter(feature => !feature.id.startsWith('php-') || feature.id === 'php-8.3')
    expect([...new Set(features.flatMap(feature => feature.packages))].sort()).toEqual([...new Set(installed(installPlan(os, everything)))].sort())
  })

  it.each(hosts)('name only source builds install.sh can run on $id $versionId', ({ os }) => {
    const builds = releaseFeatures(os).flatMap(feature => feature.builds.map(build => build.id))
    if (os.family === 'debian') expect(builds).toEqual([])
    else expect(builds).toEqual(os.major >= 10 ? [...EL_SOURCE_BUILDS] : ['webalizer', 'fts-xapian'])
  })

  it('selects optional features by their own main package, never by a package images ship', () => {
    const ubuntu = releaseFeatures(profileFor(UBUNTU_2404)), mail = ubuntu.find(feature => feature.id === 'mail')!
    expect(mail.selectedBy).toEqual(['dovecot-core'])
    expect(mail.packages).toContain('dovecot-fts-xapian')
    expect(ubuntu.find(feature => feature.id === 'php-8.3')!.selectedBy).toEqual(['php8.3-fpm'])
    expect(ubuntu.find(feature => feature.id === 'web-stats')!.selectedBy).toEqual([])
    expect(ubuntu.find(feature => feature.id === 'web-disk')!.daemonsOff).toEqual(['lighttpd'])
  })

  it('keeps the awstats stock site closed through the same managed file the installer writes', () => {
    expect(installFiles(profileFor(ALMA_9), everything).map(file => file.path)).toContain('/etc/httpd/conf.d/awstats.conf')
  })
})
