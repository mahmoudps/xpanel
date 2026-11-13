import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { EL_SOURCE_BUILDS, profileFor, releaseFeatures } from '../packages/os/src/index.ts'
import { ALMA_10, UBUNTU_2404 } from '../packages/os/src/fixtures.ts'

const installer = resolve(import.meta.dirname, 'install.sh'), source = readFileSync(installer, 'utf8')
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const start = source.indexOf('# An upgraded EL host gets a component')
const block = source.slice(start, source.indexOf('if [[ "$DRY_RUN" -eq 1 ]]; then', start))
const stubs = EL_SOURCE_BUILDS.map(build => `install_el_${build.replace('-', '_')}() { echo "BUILT ${build}"; }`).join('\n')
const NEGATIVE_CASES = [['debian', 0, 'webalizer'], ['rhel', 1000, 'webalizer'], ['rhel', 0, 'mpm-itk']] as const
const runResults = new Map<string, { status: number; stdout: string }>()
let releaseHostRefusal: SpawnSyncReturns<string>

beforeAll(() => {
  if (!existsSync(bash)) throw new Error('Bash is required for the installer contract')
  const allCases: Array<readonly [string, number, string]> = [
    ...EL_SOURCE_BUILDS.map(build => ['rhel', 0, build] as const),
    ...NEGATIVE_CASES,
    ['rhel', 0, ''] as const,
  ]
  const script = allCases.map(([family, uid, build], idx) => `set +e
out_${idx}=$(set -euo pipefail
die() { echo "ERROR: $*"; exit 1; }
id() { echo ${uid}; }
${stubs}
OS_FAMILY=${family}; EL_SOURCE_BUILD=${JSON.stringify(build)}
${block}
echo CONTINUED)
rc_${idx}=$?
printf '===%d:%d===\\n%s\\n===END===\\n' "${idx}" "$rc_${idx}" "$out_${idx}"`).join('\n')
  const batch = spawnSync(bash, ['--norc', '--noprofile', '-c', script], { encoding: 'utf8', timeout: 15_000 })
  if (batch.status !== 0) throw new Error(`Batch shell failed: ${batch.stderr}`)
  const re = /===(\d+):(\d+)===\r?\n([\s\S]*?)\r?\n===END===/g
  let m: RegExpExecArray | null
  while ((m = re.exec(batch.stdout)) !== null) {
    const [family, uid, build] = allCases[Number(m[1])]!
    runResults.set(`${family}:${uid}:${build}`, { status: Number(m[2]), stdout: m[3]! })
  }
  const parent = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
  const dir = mkdtempSync(join(parent, 'xpanel-el-source-build-')), release = join(dir, 'os-release')
  try {
    writeFileSync(release, UBUNTU_2404)
    releaseHostRefusal = spawnSync(bash, ['--norc', '--noprofile', installer.replaceAll('\\', '/'), `--os-release=${release.replaceAll('\\', '/')}`, '--el-source-build=webalizer'], { encoding: 'utf8', timeout: 30_000 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

describe('installer mode for a component an upgrade adds', { tags: ['unit'] }, () => {
  it.each([...EL_SOURCE_BUILDS])('builds %s and stops there', build => {
    const result = runResults.get(`rhel:0:${build}`)!
    expect(result.stdout.trim()).toBe(`BUILT ${build}`)
    expect(result.status).toBe(0)
  })
  it('exits 1 for a host or a name it does not serve: the job counts that as a failed try, not a crash', () => {
    for (const [family, uid, build] of NEGATIVE_CASES) {
      const result = runResults.get(`${family}:${uid}:${build}`)!
      expect(result.status).toBe(1)
      expect(result.stdout).toMatch(/^ERROR: /)
      expect(result.stdout).not.toContain('CONTINUED')
    }
  })
  it('leaves the installer untouched without the option', () => {
    expect(runResults.get('rhel:0:')!.stdout.trim()).toBe('CONTINUED')
  })
  it('reaches the block before anything that needs root, a new install or node', () => {
    for (const later of ['xPanel installer must be run as root', 'Live provisioning requires --new-install', 'assert_cgroup_and_quota_preflight\n']) expect(source.indexOf(later)).toBeGreaterThan(start)
  })
  it('runs on a release host: the real script parses the option and refuses a non-EL host', () => {
    expect(releaseHostRefusal.status).toBe(1)
    expect(releaseHostRefusal.stderr).toContain('Source builds run as root on EL only.')
  })
  it('observes the files the builds really install', () => {
    const paths = Object.fromEntries(releaseFeatures(profileFor(ALMA_10)).flatMap(feature => feature.builds.map(build => [build.id, build.path])))
    const builds = readFileSync(resolve(import.meta.dirname, 'el-source-builds.sh'), 'utf8')
    expect(builds).toContain(`EL_WEBALIZER_BINARY="${paths.webalizer}"`)
    expect(paths.awstats).toBe(/EL_AWSTATS_DIR="([^"]+)"/.exec(builds)![1] + '/awstats.pl')
    expect(builds).toContain(`EL_FTS_MODULE="${paths['fts-xapian']}"`)
  })
})
