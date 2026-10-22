import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const installer = readFileSync(join(root, 'scripts/install.sh'), 'utf8')
const pinnedNode = readFileSync(join(root, '.node-version'), 'utf8').trim()
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'

const render = async () => {
  if (!existsSync(bash)) throw new Error('Bash is required for the installer dry-run rendering test; no WSL fallback is allowed')
  const temporaryRoot = resolve(tmpdir())
  const dir = await mkdtemp(join(temporaryRoot, 'xpanel-unit-plan-'))
  try {
    const release = join(dir, 'os-release').replaceAll('\\', '/')
    await writeFile(release, 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu fixture"\n')
    const result = spawnSync(bash, ['scripts/install.sh', '--dry-run', `--os-release=${release}`], { cwd: root, encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  } finally {
    const target = resolve(dir)
    if (dirname(target) !== temporaryRoot || !basename(target).startsWith('xpanel-unit-plan-')) {
      throw new Error('Refusing cleanup outside the installer test fixture directory')
    }
    await rm(target, { recursive: true, force: true })
  }
}

describe('S03 installer service boundary (rendering only, no host proof)', () => {
  it('runs the API as its service user and keeps the privileged daemon separate', async () => {
    const output = await render()
    const api = output.split('Description=xPanel Control Plane API')[1]!
    const agent = output.split('Description=xPanel Privileged Host Reconciler')[1]!.split('Description=xPanel Control Plane API')[0]!
    expect(api).toContain('User=xpanel')
    expect(api).toMatch(/^Group=xpanel$/m)
    expect(api).toMatch(/^SupplementaryGroups=xpanel-agent$/m)
    expect(api).toContain('NoNewPrivileges=yes')
    expect(agent).toContain('User=root')
    expect(agent).toMatch(/^Group=xpanel-agent$/m)
    expect(agent).toMatch(/^SupplementaryGroups=xpanel$/m)
    expect(agent).toContain('UMask=0007')
    expect(agent).toContain('RuntimeDirectory=xpanel')
    expect(agent).toContain('RuntimeDirectoryMode=0750')
    expect(agent).toContain('RuntimeDirectoryPreserve=no')
    expect(agent).not.toMatch(/^ExecStartPre=.*\bchown\b/m)
    expect(api).not.toContain('User=root')
  })

  it('uses the pinned Node runtime and entrypoints that are actually present', async () => {
    const output = await render()
    expect(output).toContain(`Required Node     : ${pinnedNode}`)
    expect(output).toContain('/opt/xpanel/apps/api/src/main.ts')
    expect(output).toContain('/opt/xpanel/apps/agent/src/main.ts')
    expect(output).not.toContain('/dist/index.js')
    expect(installer).toContain('assert_pinned_runtime')
    expect(installer).toContain('(8#$mode & 06022)')
    expect(installer).not.toContain('curl |')
  })

  it('provisions protected credential files and a numeric dedicated socket group', async () => {
    const output = await render()
    expect(output).toContain('XPANEL_AGENT_TOKEN_FILE=/etc/xpanel/agent.token')
    expect(output).toContain('XPANEL_SERVER_SECRET_FILE=/etc/xpanel/server.secret')
    expect(output).toContain('EnvironmentFile=/etc/xpanel/runtime.env')
    expect(output).toContain('EnvironmentFile=/etc/xpanel/api.env')
    expect(output).toContain('root:xpanel-agent 0750 /run/xpanel')
    expect(installer).toContain('XPANEL_AGENT_GID=$AGENT_GID')
    expect(installer).toContain('randomBytes(32)')
    expect(installer).not.toMatch(/Environment=XPANEL_AGENT_TOKEN=/)
    expect(installer).toContain('provision_credential')
  })

  it('backs up managed files and never masks sysctl failures', () => {
    expect(installer).toContain('write_config "$SYSCTL_CONF" render_sysctl_conf')
    expect(installer).toContain('write_config "$AGENT_UNIT" render_agent_service')
    expect(installer).toContain('write_config "$API_UNIT" render_api_service')
    expect(installer).toContain('backup_config /etc/shells')
    expect(installer).not.toMatch(/sysctl[^\n]*\|\|\s*true/)
    expect(installer).toContain('cp -a -- "$target" "$target.bak.$BACKUP_STAMP"')
    expect(installer).toContain('mv -fT -- "$temporary" "$target"')
    expect(installer).toContain('ln -sfnT "$JAILSHELL_BIN" "$JAILSHELL_LINK"')
  })

  it('initializes SQLite as the API identity before the root daemon can create WAL sidecars', () => {
    expect(installer).toContain('runuser -u xpanel --')
    expect(installer).toContain('chmod 0660 /var/lib/xpanel/control.db')
    expect(installer).toContain('install -d -o xpanel -g xpanel -m 2770 /var/lib/xpanel')
    expect(installer).toContain('assert_service_groups')
    expect(installer).toContain('Unexpected member in private service group')
    expect(installer.indexOf('assert_pinned_runtime\n')).toBeLessThan(installer.indexOf('apt-get update -y'))
  })
})
