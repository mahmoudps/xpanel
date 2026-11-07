import { spawn } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { assertTrustedDirectory, readTrustedFile, requireLinuxRoot, withTrustedFile } from '../../../scripts/lifecycle-ownership.mjs'
import { assertCoordinatorOwnershipCurrent, coordinatorOwnershipInfo, type CoordinatorOwnershipCapability } from '../../../scripts/coordinator-ownership.mjs'
import { assertValidKernelPeerCredentials, type KernelPeerCredentials } from './peer-identity.ts'
import { parseLauncherPublicKey } from './ops-upgrade-ipc.ts'
export const NATIVE_UPGRADE_UNIT = 'xpanel-lifecycle.service'
export const NATIVE_UPGRADE_SOCKET = '/run/xpanel-lifecycle/upgrade.sock'
const PUBLIC_KEY = '/etc/xpanel/lifecycle-launcher.pub'
const refuse = (): never => { throw new Error('UPGRADE_LAUNCHER_UNAVAILABLE') }
export async function unitProperties(unit: 'xpanel-lifecycle.service' | 'xpanel-agent.service'): Promise<Record<string, string>> {
  return withTrustedFile('/usr/bin/systemctl', { maxBytes: 16 * 1024 * 1024 }, async tool => {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('/proc/self/fd/3', ['show', unit, '--property=Id,LoadState,ActiveState,MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,User'],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', tool.fd] })
      let output = '', bytes = 0, failure: Error | undefined
      const timer = setTimeout(() => { failure = new Error('UPGRADE_UNIT_TIMEOUT'); child.kill('SIGKILL') }, 3000)
      const collect = (chunk: Buffer, stdout: boolean) => { bytes += chunk.length; if (bytes > 16384) { failure = new Error('UPGRADE_UNIT_OUTPUT_LIMIT'); child.kill('SIGKILL') } else if (stdout) output += chunk.toString('utf8') }
      child.stdout?.on('data', (chunk: Buffer) => collect(chunk, true)); child.stderr?.on('data', (chunk: Buffer) => collect(chunk, false))
      child.once('error', error => { failure = error })
      child.once('close', (code, signal) => { clearTimeout(timer); if (failure || signal || code !== 0) reject(failure ?? new Error('UPGRADE_UNIT_FAILED')); else resolve(output) })
    })
    await tool.verify()
    const rows: Record<string, string> = {}
    for (const line of output.trim().split('\n')) { const at = line.indexOf('='); if (at < 1 || Object.hasOwn(rows, line.slice(0, at))) return refuse(); rows[line.slice(0, at)] = line.slice(at + 1) }
    return rows
  })
}
export async function processFacts(pid: number, unit?: string) {
  if (!Number.isSafeInteger(pid) || pid < 1) return refuse()
  const [status, stat, cgroup, exe, args, bootId] = await Promise.all([
    readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/cgroup`, 'utf8'),
    readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  ])
  const at = stat.lastIndexOf(')'), start = stat.slice(at + 2).trim().split(/\s+/)[19]
  if (!/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status) || !/^Gid:\s+0\s+0\s+0\s+0\s*$/m.test(status) || at < 0 || !start || !/^[0-9]+$/.test(start)
    || (unit !== undefined && cgroup.trim() !== `0::/system.slice/${unit}`)) return refuse()
  return { pid, start, bootId: bootId.trim(), exe, argv: args.toString('utf8').split('\0').filter(Boolean) }
}
export async function observeLauncher(ownership: CoordinatorOwnershipCapability) {
  requireLinuxRoot()
  if (process.version !== 'v26.12.1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) return refuse()
  await assertCoordinatorOwnershipCurrent(ownership)
  const receipt = coordinatorOwnershipInfo(ownership), state = await unitProperties(NATIVE_UPGRADE_UNIT)
  if (state.Id !== NATIVE_UPGRADE_UNIT || state.LoadState !== 'loaded' || state.ActiveState !== 'active' || state.ControlPID !== '0'
    || state.ControlGroup !== `/system.slice/${NATIVE_UPGRADE_UNIT}` || state.FragmentPath !== `/etc/systemd/system/${NATIVE_UPGRADE_UNIT}`
    || state.DropInPaths || !['', 'root', '0'].includes(state.User ?? '')) return refuse()
  const actual = await processFacts(Number(state.MainPID), NATIVE_UPGRADE_UNIT)
  if (actual.exe !== await realpath(receipt.nodePath) || JSON.stringify(actual.argv) !== JSON.stringify([receipt.nodePath, receipt.sourcePath])) return refuse()
  const key = await readTrustedFile(PUBLIC_KEY, { sha256: receipt.publicKeySha256, maxBytes: 4096 })
  await assertCoordinatorOwnershipCurrent(ownership)
  return { receipt, publicKey: parseLauncherPublicKey(key.bytes), publicBytes: key.bytes,
    identity: { pid: actual.pid, start: actual.start, bootId: actual.bootId, receiptSha256: receipt.receiptSha256 } }
}
export function kernelPeer(socket: Socket, addon: { getSocketPeerCred(fd: number): KernelPeerCredentials }): KernelPeerCredentials {
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd
  if (!Number.isSafeInteger(fd) || (fd ?? -1) < 0) return refuse()
  return assertValidKernelPeerCredentials(addon.getSocketPeerCred(fd!))
}
export async function socketIdentity(socketPath: string = NATIVE_UPGRADE_SOCKET) {
  await assertTrustedDirectory('/run/xpanel-lifecycle')
  if (![NATIVE_UPGRADE_SOCKET, '/run/xpanel-lifecycle/operator.sock'].includes(socketPath)) return refuse()
  const directory = await lstat('/run/xpanel-lifecycle'), info = await lstat(socketPath)
  if ((directory.mode & 0o7777) !== 0o700 || !info.isSocket() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o600) return refuse()
  return `${directory.dev}:${directory.ino}:${info.dev}:${info.ino}`
}
