import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export const disposableVmAcknowledgement = 'I_ACCEPT_DESTRUCTIVE_TESTS_IN_THIS_DISPOSABLE_VM'

/** Executor proofs use only unique xpq resources; they do not depend on the legacy fixed-UID fixture. */
export function executorLinuxPreflight() {
  const reasons = []
  if (process.platform !== 'linux') reasons.push('Native Linux is required; no WSL or sudo is invoked.')
  if (process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) reasons.push('Explicit disposable-VM acknowledgement is required.')
  if (reasons.length) return { layer: 'linux-executor', status: 'blocked', reasons }
  if (process.getuid?.() !== 0) reasons.push('Root inside the disposable VM is required.')
  if (!existsSync('/run/systemd/system')) reasons.push('A booted systemd VM is required.')
  const path = '/sys/fs/cgroup/cgroup.controllers'
  const controllers = existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\s+/) : []
  for (const controller of ['memory', 'pids']) if (!controllers.includes(controller)) reasons.push(`cgroup v2 ${controller} is unavailable.`)
  for (const command of ['/usr/bin/systemctl', '/usr/bin/systemd-analyze', '/usr/bin/id', '/usr/bin/getent', '/usr/bin/chown', '/usr/bin/sleep', '/usr/bin/false', '/usr/bin/true', '/usr/sbin/groupadd', '/usr/sbin/groupdel', '/usr/sbin/useradd', '/usr/sbin/usermod', '/usr/sbin/userdel', '/usr/sbin/runuser', '/usr/sbin/mkfs.ext4', '/usr/sbin/losetup', '/usr/sbin/setquota', '/usr/sbin/quotaon', '/usr/bin/mount', '/usr/bin/umount', '/usr/bin/findmnt', '/usr/bin/dd']) {
    if (!existsSync(command)) reasons.push(`Required fixture command is unavailable: ${command}.`)
  }
  return { layer: 'linux-executor', status: reasons.length ? 'blocked' : 'available', reasons }
}

/** Read-only: never starts WSL, escalates privilege, installs tools, or changes the host. */
export function linuxProofPreflight() {
  const reasons = []
  if (process.platform !== 'linux') reasons.push('Native Linux is required; WSL is never started automatically.')
  if (process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) {
    reasons.push(`Set XPANEL_TEST_DISPOSABLE_VM=${disposableVmAcknowledgement} only inside a disposable VM.`)
  }
  if (reasons.length) return { layer: 'linux', status: 'blocked', reasons }
  if (process.getuid?.() !== 0) reasons.push('Root inside the disposable VM is required; no sudo is invoked.')
  if (!existsSync('/run/systemd/system')) reasons.push('A booted systemd VM is required.')
  const osRelease = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : ''
  if (!/^ID=["']?ubuntu["']?$/m.test(osRelease) || !/^VERSION_ID=["']?24\.04["']?$/m.test(osRelease)) {
    reasons.push('The current primitive fixture supports Ubuntu 24.04 only; other distro plans are not live proofs.')
  }
  const controllersPath = '/sys/fs/cgroup/cgroup.controllers'
  const controllers = existsSync(controllersPath) ? readFileSync(controllersPath, 'utf8').trim().split(/\s+/) : []
  const enabledPath = '/sys/fs/cgroup/cgroup.subtree_control'
  const enabled = existsSync(enabledPath) ? readFileSync(enabledPath, 'utf8').trim().split(/\s+/) : []
  for (const controller of ['memory', 'pids', 'io']) {
    if (!controllers.includes(controller)) reasons.push(`cgroup v2 ${controller} controller is unavailable.`)
    if (!enabled.includes(controller)) reasons.push(`The disposable VM must provision the enabled ${controller} controller.`)
  }
  for (const command of ['bash', 'getent', 'groupadd', 'groupdel', 'useradd', 'userdel', 'setpriv', 'sysctl', 'nft']) {
    try { execFileSync('/usr/bin/which', [command], { stdio: 'ignore', timeout: 5000 }) }
    catch { reasons.push(`Required command is unavailable: ${command}.`) }
  }
  for (const [kind, value] of [['passwd', 'xpalice'], ['passwd', 'xpbob'], ['passwd', '29101'], ['passwd', '29102'], ['group', 'xpalice'], ['group', 'xpbob'], ['group', '29101'], ['group', '29102']]) {
    try {
      execFileSync('getent', [kind, value], { stdio: 'ignore', timeout: 5000 })
      reasons.push(`Fixture identity already exists: ${kind}/${value}; it must never be deleted by this test.`)
    } catch (error) {
      if (error.status !== 2) reasons.push(`Could not establish fixture identity absence: ${kind}/${value}.`)
    }
  }
  for (const path of ['/tmp/xpanel-live-proof', '/sys/fs/cgroup/xpanel-29101.slice']) {
    if (existsSync(path)) reasons.push(`Fixture path already exists: ${path}; it must never be removed by preflight.`)
  }
  return { layer: 'linux', status: reasons.length ? 'blocked' : 'available', reasons }
}
