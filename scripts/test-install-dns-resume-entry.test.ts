import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const installer = readFileSync(new URL('./install.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const verifier = /^verify_resumed_dns\(\) \{[\s\S]*?^\}/m.exec(installer)?.[0]
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'

describe('prepared DNS admission at installer boundaries', () => {
  it('binds final quiescence to the inspected source and requires exact receipts and successful exits', () => {
    expect(verifier).toBeDefined()
    const program = `
set -eu
die() { exit 23; }
assert_root_file() { [[ "$1" == /fixture/scripts/install-dns-resume.mjs || "$1" == /fixture/scripts/lifecycle-ownership.mjs ]]; }
probe() {
  [[ "$1" == /fixture/scripts/install-dns-resume.mjs ]] || return 7
  case "$2" in
    inspect)
      [[ "$#" == 2 ]] || return 6
      printf '%s' "$first"
      return "$first_status"
      ;;
    quiesce)
      [[ "$#" == 3 && "$3" == "$digest" ]] || return 6
      printf '%s' "$last"
      return "$last_status"
      ;;
  esac
  return 6
}
SCRIPT_DIR=/fixture/scripts
NODE_BIN=probe
digest=${'a'.repeat(64)}
${verifier}
trial() {
  RESUME_DNS_BINDING=""
  first="xpanel-pdns-vendor-inspected-v2 $digest"; first_status=0
  last=xpanel-pdns-vendor-pristine-v1; last_status=0
  case "$1" in
    no_source) verify_resumed_dns quiesce; return;;
    short_digest) first=xpanel-pdns-vendor-inspected-v2;;
    altered) first="$first extra";;
    first_failed) first_status=1;;
    empty_last) last="";;
    last_failed) last_status=1;;
    duplicate) verify_resumed_dns inspect;;
  esac
  verify_resumed_dns inspect
  verify_resumed_dns quiesce
}
for n in ok no_source short_digest altered first_failed empty_last last_failed duplicate; do
  if (trial "$n"); then printf 'accept\\n'; else printf 'hold:%d\\n' "$?"; fi
done
`
    const observed = spawnSync(bash, ['-s'], { input: program, encoding: 'utf8', timeout: 5000 })
    expect(observed.status).toBe(0)
    expect(observed.stdout.trim().split(/\r?\n/)).toEqual(['accept', ...Array(7).fill('hold:23')])
  })

  it('inspects after source authentication before APT and quiesces immediately before recording or replacing the DNS configuration', () => {
    const inspect = 'if [[ "$RESUME_PREPARED" -eq 1 ]]; then verify_resumed_dns inspect; fi'
    const quiesce = 'if [[ "$RESUME_PREPARED" -eq 1 ]]; then verify_resumed_dns quiesce; fi'
    expect(installer.split(inspect)).toHaveLength(2)
    expect(installer.split(quiesce)).toHaveLength(2)
    const live = installer.slice(installer.indexOf('prepared_release=""'))
    const authorize = live.indexOf('"$SCRIPT_DIR/install-bootstrap.mjs" resume')
    const first = live.indexOf(inspect)
    expect(authorize).toBeGreaterThanOrEqual(0)
    expect(first).toBeGreaterThan(authorize)
    expect(first).toBeLessThan(live.indexOf('apt-get update'))
    const apply = /^provision_fresh_dns\(\) \{[\s\S]*?^\}/m.exec(installer)![0]
    const second = apply.indexOf(quiesce)
    expect(second).toBeGreaterThan(0)
    expect(second).toBeLessThan(apply.indexOf('verify_fresh_pdns_vendor "$config"'))
    expect(second).toBeLessThan(apply.indexOf('install -d'))
    expect(second).toBeLessThan(apply.indexOf('write_config'))
  })
})
