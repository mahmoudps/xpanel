import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..', '..', '..')

async function requireDisposableVm(): Promise<void> {
  const { linuxProofPreflight } = await import('../../../scripts/test-linux-preflight.mjs')
  const state = linuxProofPreflight()
  if (state.status !== 'available') throw new Error(`BLOCKED: ${state.reasons.join(' ')}`)
}

describe('Disposable Ubuntu VM: kernel primitives and installer dry-run', () => {
  it('checks UID access rejection and cgroup files; no Apache/PHP workload or live firewall proof', async () => {
    await requireDisposableVm()
    const stdout = execFileSync('bash', [resolve(repoRoot, 'scripts/verify-isolation-linux.sh')], {
      encoding: 'utf8', timeout: 60_000,
    })
    const jsonLine = stdout.split(/\r?\n/).find(line => line.startsWith('XPANEL_PROOF_JSON='))
    expect(jsonLine).toBeDefined()
    const proof = JSON.parse(jsonLine!.slice('XPANEL_PROOF_JSON='.length))
    expect(proof.ok).toBe(true)
    expect(proof.scope).toBe('kernel-primitives-and-firewall-syntax')
    expect(proof.homeBaseMode).toBe('711')
    expect(proof.aliceHomeMode).toBe('750')
    expect(proof.bobHomeMode).toBe('750')
    expect(proof.secretMode).toBe('640')
    expect(proof.bobSecretReadError).toContain('Permission denied')
    expect(proof.protectedSymlinks).toBe(1)
    expect(proof.protectedHardlinks).toBe(1)
    expect(proof.workerUid).toBe(29101)
    expect(proof.workerGid).toBe(29101)
    expect(proof.cgroupMemoryMax).toBe(1024 * 1024 * 1024)
    expect(proof.cgroupPidsMax).toBe(64)
    expect(proof.cgroupIoMax).toContain('rbps=50000000')
    expect(proof.cgroupIoMax).toContain('wbps=50000000')
    expect(proof.cgroupIoMax).toContain('riops=2000')
    expect(proof.cgroupIoMax).toContain('wiops=2000')
    expect(proof.firewallSyntaxChecked).toBe(true)
    expect(proof.workloadIsolation).toBe('not_run')
    expect(proof.backendTrafficIsolation).toBe('not_run')
  }, 90_000)

  it('runs the installer dry-run for Ubuntu and RHEL profiles without certifying a live install', async () => {
    await requireDisposableVm()
    const installer = resolve(repoRoot, 'scripts/install.sh')
    const ubuntu = execFileSync('bash', [installer, '--dry-run'], { encoding: 'utf8', timeout: 30_000 })
    expect(ubuntu).toContain('id=ubuntu, version=24.04, family=debian')
    expect(ubuntu).toContain('=== Dry-Run Complete (no host files mutated) ===')
    const fixtureDir = mkdtempSync(join(tmpdir(), 'xpanel-os-release-'))
    try {
      for (const [id, version] of [['centos', '9'], ['centos', '10'], ['almalinux', '9'], ['rocky', '9']]) {
        const path = join(fixtureDir, 'os-release')
        writeFileSync(path, `ID="${id}"\nVERSION_ID="${version}"\n`)
        const out = execFileSync('bash', [installer, '--dry-run', `--os-release=${path}`], {
          encoding: 'utf8', timeout: 30_000,
        })
        expect(out).toContain(`id=${id}, version=${version}, family=rhel`)
        expect(out).toContain('=== Dry-Run Complete (no host files mutated) ===')
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  }, 90_000)
})
