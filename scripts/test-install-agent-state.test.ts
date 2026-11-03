import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Real GNU install/stat on isolated Linux fixture paths. Non-root CI substitutes
// only root ownership requests; mode, inode and direct-path link checks remain real.
// The unchanged full ancestor helper is replaced by a direct-path fixture guard.
// This is installer regression evidence, never installed-host authority.
const fixture = String.raw`
from pathlib import Path
import base64,json,os,shlex,shutil,subprocess,sys,tempfile
source=base64.b64decode(sys.argv[1]).decode()
name='prepare_agent_state_directories() {'
start=source.find(name)
if start>=0:
 end=source.index('\n}\n',start)+3
 body=source[start:end]+'\nprepare_agent_state_directories\n'
 assert '\nprepare_agent_state_directories\n' in source
else:
 body=next(x for x in source.splitlines() if x.startswith('install -d -o root -g root -m 0700 /var/lib/xpanel-agent/file-worker-incidents'))+'\n'
root=Path(tempfile.mkdtemp(prefix='xpanel-agent-state-test-'))
assert root.parent==Path(tempfile.gettempdir()) and root.name.startswith('xpanel-agent-state-test-')
results={}
try:
 for case in ('fresh','legacy','private','symlink','writable','foreign_uid','foreign_gid'):
  scope=root/case;scope.mkdir(mode=0o700)
  parent=scope/'xpanel-agent'
  if case!='fresh':parent.mkdir(mode=0o700)
  if case=='legacy':parent.chmod(0o755)
  if case=='writable':parent.chmod(0o777)
  if case in ('foreign_uid','foreign_gid') and os.getuid()!=0:
   results[case]='ownership_port_only';continue
  if case=='foreign_uid':os.chown(parent,12345,0)
  if case=='foreign_gid':os.chown(parent,0,12345)
  if case=='symlink':
   parent.rmdir();target=scope/'outside';target.mkdir(mode=0o700);parent.symlink_to(target,target_is_directory=True)
  before=parent.stat().st_ino if parent.exists() else None
  current=body.replace('/var/lib/xpanel-agent',str(parent)).replace('/var/lib/xpanel-lifecycle/backups',str(scope/'backups'))
  prefix=r'''
die() { exit 17; }
assert_root_owned_path() {
 [[ -d "$1" && ! -L "$1" ]] || die
 [[ "$(stat -c %u -- "$1")" == 0 ]] || die
 local mode
 mode="$(stat -c %a -- "$1")"
 (( (8#$mode & 0022) == 0 )) || die
}
'''
  if os.getuid()!=0:
   prefix+=r'''
stat() { case "$2" in %u|%g) echo 0;; *) command stat "$@";; esac; }
install() {
 local -a kept=()
 while [[ $# -gt 0 ]]; do case "$1" in -o|-g) [[ "$2" == root ]] || die; shift 2;; *) kept+=("$1"); shift;; esac; done
 command install "\u0024{kept[@]}"
}
'''.replace(r'\u0024','$')
  run=subprocess.run(['/bin/bash','-euo','pipefail','-c',prefix+current],capture_output=True,timeout=5)
  if case in ('symlink','writable','foreign_uid','foreign_gid'):
   assert run.returncode!=0,(case,'unsafe source accepted')
   if case=='symlink':assert not (scope/'outside/host-operations').exists()
   if case=='writable':assert parent.stat().st_mode&0o7777==0o777
   if case=='foreign_uid':assert parent.stat().st_uid==12345
   if case=='foreign_gid':assert parent.stat().st_gid==12345
   results[case]='refused_preserved'
  else:
   assert run.returncode==0,(case,run.returncode,run.stderr.decode())
   for p in (parent,parent/'host-operations',parent/'operation-audit',parent/'file-worker-incidents'):
    assert p.is_dir() and not p.is_symlink() and p.stat().st_mode&0o7777==0o700,(case,str(p),'private mode mismatch')
   if before is not None:assert parent.stat().st_ino==before
   results[case]='private_modes_verified'
 print(json.dumps({'cases':results,'nativeHostAcceptance':False}))
finally:shutil.rmtree(root)
`

describe('GNU/Linux installer private agent state hierarchy', () => {
  it.skipIf(process.platform !== 'linux')('creates explicit private parents and preserves unsafe existing paths', { tags: ['feature'] }, () => {
    const original = readFileSync(process.env.XPANEL_INSTALL_AGENT_TEST_SOURCE ?? new URL('./install.sh', import.meta.url), 'utf8')
    const start = original.indexOf('prepare_agent_state_directories() {')
    if (start >= 0) expect(original).toContain('\nprepare_agent_state_directories\n')
    const selected = start >= 0
      ? original.slice(start, original.indexOf('\n}\n', start) + 3) + '\nprepare_agent_state_directories\n'
      : original.split('\n').find(line => line.startsWith('install -d -o root -g root -m 0700 /var/lib/xpanel-agent/file-worker-incidents'))
    expect(selected).toBeTruthy()
    const source = Buffer.from(selected!)
    const result = spawnSync('python3', ['-', source.toString('base64')], { input: fixture, encoding: 'utf8', timeout: 10_000 })
    expect(result.status, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt.cases.fresh).toBe('private_modes_verified')
    expect(receipt.cases.legacy).toBe('private_modes_verified')
    expect(receipt.cases.private).toBe('private_modes_verified')
    expect(receipt.cases.symlink).toBe('refused_preserved')
    expect(receipt.cases.writable).toBe('refused_preserved')
    expect(receipt.nativeHostAcceptance).toBe(false)
  })
})
