import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderWhmcsModule, WHMCS_PROVISION_PATH } from './whmcs-module.ts'

const php = (): string | null => {
  for (const candidate of ['php', 'php.exe']) {
    try { execFileSync(candidate, ['-v'], { stdio: 'ignore' }); return candidate } catch { /* not on PATH */ }
  }
  return null
}

describe('WHMCS server module source', () => {
  const source = renderWhmcsModule()
  it('defines every WHMCS entry point and calls only the provisioning endpoint over verified TLS', () => {
    expect(source.startsWith('<?php\n')).toBe(true)
    for (const name of ['MetaData', 'ConfigOptions', 'TestConnection', 'CreateAccount', 'SuspendAccount', 'UnsuspendAccount', 'TerminateAccount', 'ChangePackage'])
      expect(source).toContain(`function xpanel_${name}(`)
    expect(source).toContain(`'https://' . $host . ':' . $port . '${WHMCS_PROVISION_PATH}'`)
    expect(source).toContain('CURLOPT_SSL_VERIFYPEER => true')
    expect(source).toContain('CURLOPT_SSL_VERIFYHOST => 2')
    expect(source).toContain("'Authorization: Bearer ' . $token")
    for (const action of ['test', 'create', 'suspend', 'unsuspend', 'terminate', 'change_package']) expect(source).toContain(`'action' => '${action}'`)
  })
  it('embeds no secret and masks the token and password in the WHMCS module log', () => {
    expect(source).not.toMatch(/xpw_[A-Za-z0-9_-]{8,}/)
    expect(source).not.toMatch(/CURLOPT_SSL_VERIFYPEER => false|CURLOPT_SSL_VERIFYHOST => 0/)
    expect(source).toContain("$logged['password'] = '********'")
    expect(source).toContain('logModuleCall(')
    expect((source.match(/\{/g) ?? []).length).toBe((source.match(/\}/g) ?? []).length)
  })
  it('passes php -l when PHP is installed', async () => {
    const binary = php()
    if (!binary) return
    const dir = await mkdtemp(join(tmpdir(), 'xp-whmcs-module-'))
    try {
      await writeFile(join(dir, 'xpanel.php'), source)
      expect(execFileSync(binary, ['-l', join(dir, 'xpanel.php')], { encoding: 'utf8' })).toContain('No syntax errors')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
