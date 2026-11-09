import { describe, expect, it } from 'vitest'
import { createProductionHostTargetMatcher, type HostTargetOperation } from './executor.ts'
import { buildGenerationManifest } from './reconciler-journal.ts'
import { renderAccountProbeAsset } from '../../../packages/render/src/system/account-probe.ts'
import { debianOs } from '../../../packages/render/src/system/testkit.ts'
const fileOperations: HostTargetOperation[] = ['read', 'write', 'remove']
const allOperations: HostTargetOperation[] = [...fileOperations, 'ensure-directory']
describe('finite managed account probe targets', { tags: ['unit'] }, () => {
  const permits = createProductionHostTargetMatcher()
  it('permits only the static canary file and directory preparation', () => {
    for (const operation of fileOperations) expect(permits('/etc/xpanel/account-probe/probe.php', operation)).toBe(true)
    expect(permits('/etc/xpanel/account-probe/probe.php', 'ensure-directory')).toBe(false)
    for (const path of ['/etc/xpanel/account-probe', '/etc/xpanel/account-probe/runtime', '/run/xpanel-account-probe', '/run/xpanel-account-probe/1000', '/run/xpanel-account-probe/60000']) {
      expect(permits(path, 'ensure-directory')).toBe(true)
      for (const operation of fileOperations) expect(permits(path, operation)).toBe(false)
    }
  })
  it('does not grant arbitrary files, socket replacement, wider IDs or tenant source writes', () => {
    for (const path of ['/etc/xpanel/account-probe/foreign.php', '/run/xpanel-account-probe/999', '/run/xpanel-account-probe/60001', '/run/xpanel-account-probe/1000/callback.sock', '/run/xpanel-account-probe/1000/ingress.sock', '/home/alice/.xpanel-probe/probe.php']) {
      for (const operation of allOperations) expect(permits(path, operation)).toBe(false)
    }
  })
  it('links a replaced readonly bind source to the actual managed FPM units', () => {
    const unit = 'xpanel-php-fpm-alice-8.3.service'
    const manifest = buildGenerationManifest({ generationId: 1, stateChecksum: 'a'.repeat(64), filesChecksum: 'b'.repeat(64), actor: 'root',
      // As the reconciler emits them for an active account: the FPM unit is enabled and restarted, nginx only restarted.
      files: [renderAccountProbeAsset()], postActions: [{ kind: 'systemd', verb: 'enable', unit }, { kind: 'systemd', verb: 'restart', unit }, { kind: 'systemd', verb: 'restart', unit: 'nginx.service' }], os: debianOs })
    const asset = manifest.files.find(file => file.path === '/etc/xpanel/account-probe/probe.php')
    expect(asset?.service).toBe('php-fpm')
    expect(asset?.dependentUnits).toEqual([unit])
  })
})
