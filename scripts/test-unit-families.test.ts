import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { UNIT_FAMILIES, unitFamily } from '../packages/core/src/unit-families.ts'
import { system } from '../packages/render/src/index.ts'
import { UPGRADE_UNIT } from '../packages/lifecycle/src/upgrade/machine.ts'
import { depsUnitName, podmanCleanupUnitName, pythonEnvUnitName } from '../apps/agent/src/account-runtime.ts'
import { pearUnitName } from '../apps/agent/src/account-packages.ts'
import { ctrLoginUnit } from '../apps/agent/src/ctr-command.ts'
import { FTP_ANONYMOUS_UNIT } from '../apps/agent/src/ftp-server.ts'
import { IP_ALIASES_UNIT } from '../apps/agent/src/ip-aliases.ts'
import { NATIVE_UPGRADE_UNIT } from '../apps/agent/src/ops-upgrade-native-observation.ts'
import { perlUnitName } from '../apps/agent/src/owner-tools.ts'
import { RESTART_API } from '../apps/agent/src/panel-access.ts'
import { PMA_UNIT } from '../apps/agent/src/phpmyadmin-access.ts'
import { deployUnitName, stageUnitName } from '../apps/agent/src/web-apps.ts'
import { OWNED_PANEL_UNITS } from './lifecycle-ownership.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const matching = (unit: string) => UNIT_FAMILIES.filter(entry => entry.pattern.test(unit))

describe('unit family registry', () => {
  it('matches every example to its own family only', () => {
    for (const entry of UNIT_FAMILIES) {
      expect(entry.examples.length).toBeGreaterThan(0)
      for (const example of entry.examples) {
        expect(unitFamily(example)?.id, example).toBe(entry.id)
        expect(matching(example).map(other => other.id), example).toEqual([entry.id])
      }
    }
    expect(new Set(UNIT_FAMILIES.map(entry => entry.id)).size).toBe(UNIT_FAMILIES.length)
  })

  it('names the receipt-owned control plane and the two coordinators exactly', () => {
    expect([...UNIT_FAMILIES.find(entry => entry.scope === 'control-plane')!.examples].sort()).toEqual([...OWNED_PANEL_UNITS].sort())
    expect(UNIT_FAMILIES.filter(entry => entry.scope === 'control-plane')).toHaveLength(1)
    expect([...UNIT_FAMILIES.find(entry => entry.scope === 'coordinator')!.examples].sort()).toEqual([NATIVE_UPGRADE_UNIT, UPGRADE_UNIT].sort())
  })

  it.each([
    'xpanel-metrics.service', 'xpanel-metrics.timer', 'xpanel-caldav-Qa1.service', 'xpanel-caldav-1qa.service', 'xpanel-caldav-qa1.timer',
    'xpanel-php-fpm-alice-10.1.service', 'xpanel-php-fpm-alice-8.3.socket', 'xpanel-cron-alice-.service', 'xpanel-cron-alice--x.timer',
    'xpanel-999.slice', 'xpanel-01000.slice', 'xpanel-65534.slice', 'xpanel-files-65534-' + 'a'.repeat(32) + '.service', 'xpanel-files-20003-aa.service',
    'xpanel-task-abc.service', 'xpanel-terminal-0B6F2B4E-6A59-4C1E-9D0E-3C7F2A9B1D24.service', 'xpanel-webdisk-alice-0123456789a.socket',
    'xpanel-redis-a2345678901234567.service', 'xpanel-daemon-1abc.service', 'xpanel-ctr-alice.service', 'xpanel-app-alice-blog.socket',
    'xpanel-api.socket', 'xpanel-lifecycle.timer', 'xpanel-container-alice-web.service', 'xpanel-cron-alice-' + 'a'.repeat(33) + '.timer', 'xpanel', 7,
  ])('treats %j as unknown', unit => expect(unitFamily(unit)).toBeNull())

  it('covers every name the renderers and agent builders emit, at the grammar bounds', () => {
    const user = 'a234567890123456', short = 'b' + 'x-'.repeat(15) + 'z', account = { username: user, home: `/home/${user}` }
    const app = system.appPaths(user, short), disk = system.webDiskPaths(user, '0123456789ab'), cron = system.cronUnitNames(user, short), dav = system.calDavPaths(account)
    const emitted: [string, string][] = [
      [system.accountSliceName(1000), 'account-slice'], [system.accountSliceName(60000), 'account-slice'],
      [system.fpmUnitName(user, '8.3'), 'php-fpm'], [system.fpmUnitName(user, '5.6'), 'php-fpm'],
      [app.service, 'web-app'], [app.proxySocketUnit, 'web-app-proxy'], [app.proxyService, 'web-app-proxy'],
      [cron.service, 'cron'], [cron.timer, 'cron'],
      [system.cachePaths(account, 'redis').unit, 'cache'], [system.cachePaths(account, 'memcached').unit, 'cache'],
      [system.containerUnitName(user, short), 'container'],
      [dav.service, 'caldav'], [dav.socketUnit, 'caldav'],
      [disk.frontSocketUnit, 'webdisk'], [disk.proxyService, 'webdisk'], [disk.backendSocketUnit, 'webdisk'], [disk.service, 'webdisk'],
      [depsUnitName(user, short), 'app-job'], [pythonEnvUnitName(user, short), 'app-job'], [stageUnitName(user, short), 'app-job'], [deployUnitName(user, short), 'app-job'],
      [podmanCleanupUnitName(user), 'account-job'], [ctrLoginUnit(user), 'account-job'], [pearUnitName(user), 'account-job'], [perlUnitName(user), 'account-job'],
      [`xpanel-terminal-${randomUUID()}.service`, 'terminal'],
      [system.hostTaskUnit('a1b2c3d4e5f6'), 'host-task'], [system.hostTaskTimer('a1b2c3d4e5f6'), 'host-task'],
      [system.hostDaemonUnit('w'), 'host-daemon'], [system.hostDaemonUnit('a' + 'b-'.repeat(15)), 'host-daemon'],
      [system.FRP_UNITS.server, 'host-service'], [system.FRP_UNITS.client, 'host-service'], [system.CONTAINER_GUARD_UNIT, 'host-service'],
      [IP_ALIASES_UNIT, 'host-service'], [FTP_ANONYMOUS_UNIT, 'host-service'], [PMA_UNIT, 'host-service'],
      [RESTART_API.find(arg => arg.startsWith('--unit='))!.slice(7) + '.timer', 'panel-restart'],
    ]
    for (const [unit, id] of emitted) expect(unitFamily(unit)?.id, unit).toBe(id)
  })
})

// Standing guard: any unit name literal, template or systemd-run --unit= value in the agent, the shared
// packages or the root lifecycle scripts must belong to a registered family before it can reach a host.
const NAME = String.raw`xpanel(?:[A-Za-z0-9_.@:-]|\$\{[^}\n]{1,120}\})*?`
const SUFFIX = String.raw`\.(?:service|socket|timer|slice|path|target|scope|mount|swap|automount|device)`
const WHOLE = new RegExp(String.raw`(?<=[\x60'"/=\s])${NAME}${SUFFIX}(?![A-Za-z0-9_-])`, 'g')
const RUN = new RegExp(String.raw`--unit=(${NAME})(?=[\x60'"\s])`, 'g')
const JOINED = new RegExp(String.raw`['"\x60](xpanel[-.][A-Za-z0-9_.@:-]*)['"\x60]\s*\+[^;\n]{0,200}?\+\s*['"\x60]([A-Za-z0-9_.@:-]*${SUFFIX})['"\x60]`, 'g')
const SOURCE = /\.(?:ts|mjs|sh)$/
const SKIP = /\.test\.ts$|testkit\.ts$|fixtures?\.ts$|[-.]fixture\.ts$|\.d\.mts$/

interface Finding { file: string; text: string; kind: 'name' | 'run' | 'joined' }

const scan = (file: string, text: string): Finding[] => [
  ...[...text.matchAll(WHOLE)].map(match => ({ file, text: match[0], kind: 'name' as const })),
  // systemd-run names a .service (and a .timer with --on-active) after the value: it is a prefix.
  ...[...text.matchAll(RUN)].map(match => ({ file, text: match[1]!, kind: 'run' as const })),
  ...[...text.matchAll(JOINED)].map(match => ({ file, text: `${match[1]}\${}${match[2]}`, kind: 'joined' as const })),
]

const EXAMPLES = UNIT_FAMILIES.flatMap(entry => entry.examples)
/** A literal must match a family; a template, with each placeholder standing for any text, must match an example. */
const registered = (finding: Finding): boolean => {
  if (finding.kind === 'name' && !finding.text.includes('${')) return unitFamily(finding.text) !== null
  const parts = finding.text.split(/\$\{[^}]*\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`^${parts.join('.+')}${finding.kind === 'run' ? '' : '$'}`)
  return EXAMPLES.some(example => pattern.test(example))
}

const sourceFiles = (): string[] => {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path) } else if (SOURCE.test(entry.name) && !SKIP.test(entry.name)) files.push(path)
    }
  }
  walk(join(ROOT, 'apps/agent/src'))
  for (const entry of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) if (entry.isDirectory()) walk(join(ROOT, 'packages', entry.name, 'src'))
  for (const entry of readdirSync(join(ROOT, 'scripts'), { withFileTypes: true })) if (entry.isFile() && SOURCE.test(entry.name) && !SKIP.test(entry.name)) files.push(join(ROOT, 'scripts', entry.name))
  return files
}

describe('unit names in the sources', () => {
  it('belong to a registered family', () => {
    const findings = sourceFiles().flatMap(path => scan(relative(ROOT, path).split('\\').join('/'), readFileSync(path, 'utf8')))
    expect(findings.length).toBeGreaterThan(100)
    expect(findings.filter(finding => !registered(finding)).map(finding => `${finding.file}: ${finding.text}`)).toEqual([])
  })

  it('flags a new family in each written form', () => {
    const source = [
      'const a = `xpanel-metrics-${id}.timer`', "const b = 'xpanel-metrics.service'", "run(['--unit=xpanel-newjob', cmd])",
      "const c = 'xpanel-new-' + id + '.service'", 'const d = `/etc/systemd/system/xpanel-backup-${user}.service`',
    ].join('\n')
    const findings = scan('sample.ts', source)
    expect(findings.map(finding => finding.kind).sort()).toEqual(['joined', 'name', 'name', 'name', 'run'])
    expect(findings.filter(registered)).toEqual([])
    expect(scan('sample.ts', "const e = 'xpanel-' + uid + '.slice'; run(['--unit=xpanel-panel-restart'])").every(registered)).toBe(true)
  })
})
