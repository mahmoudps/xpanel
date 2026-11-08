import { isIP } from 'node:net'
import { fail, isAccountHome } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { system } from '@xpanel/render'

/**
 * Reviewed rootless Podman grammar. Every command runs as one account, in its slice and its own storage,
 * through the same systemd-run shape as the image cleanup, so nothing here can reach another account's store.
 */
export type CtrAccount = Pick<Account, 'username' | 'uid' | 'gid' | 'home'>
export type CtrRead = 'containers' | 'images' | 'networks' | 'volumes' | 'info' | 'stats' | 'dangling'
export const CTR_READS: Readonly<Record<CtrRead, readonly string[]>> = {
  containers: ['ps', '--all', '--format', 'json'], images: ['images', '--format', 'json'], networks: ['network', 'ls', '--format', 'json'],
  volumes: ['volume', 'ls', '--format', 'json'], info: ['info', '--format', 'json'], stats: ['stats', '--all', '--no-stream', '--format', 'json'],
  dangling: ['volume', 'ls', '--filter', 'dangling=true', '--format', 'json'],
}
export const CTR_ID = /^[0-9a-f]{64}$/
export const CTR_NETWORK = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
export const CTR_VOLUME = /^[a-z0-9][a-z0-9_.-]{0,127}$/
export const CTR_REGISTRY = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::[0-9]{2,5})?$/
export const CTR_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/
export const CTR_COMMIT_TAG = /^localhost\/[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const LABEL = /^[a-z0-9][a-z0-9._-]{0,62}=[A-Za-z0-9 ._:/-]{0,128}$/
const VOLUME_OPTION = /^(?:type|device|o)=[A-Za-z0-9,._=:/-]{1,128}$/
const CTR_UNIT = /^xpanel-ctr-[a-z][a-z0-9]{0,15}-[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.service$/
const STDIN_FILE = /^\/[A-Za-z0-9/_.-]{1,200}\/extended\/containers\/(login|build)-[a-z][a-z0-9]{0,15}$/
/** A file inside the account home: plain segments, so nothing can climb out of it. */
const CTR_ARCHIVE = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}){0,7}\.tar$/
export const CTR_HOME_PATH = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._+-]{0,127}){0,7}$/
export const isCtrArchive = (value: unknown): value is string => typeof value === 'string' && CTR_ARCHIVE.test(value)
export const CTR_SEARCH_TERM = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const JOURNALCTL = '/usr/bin/journalctl'
const SYSTEMCTL = '/usr/bin/systemctl'
const JOURNAL_TAIL = ['--lines=400', '--no-pager', '--output=short-iso', '--utc', '--quiet']
const cidr = (value: unknown, family: 4 | 6): boolean => {
  if (typeof value !== 'string') return false
  const [ip, bits, ...rest] = value.split('/')
  return rest.length === 0 && isIP(ip ?? '') === family && /^[0-9]{1,3}$/.test(bits ?? '') && Number(bits) >= 8 && Number(bits) <= (family === 4 ? 30 : 126)
}
export const isCtrCidr = cidr
export const isCtrLabel = (value: unknown): value is string => typeof value === 'string' && LABEL.test(value)
export const isCtrVolumeOption = (value: unknown): value is string => typeof value === 'string' && VOLUME_OPTION.test(value)
const authFile = (home: string): string => home + '/.config/containers/auth.json'

export interface CtrNetworkInput { name: string; subnet: string | null; gateway: string | null; range: string | null; ipv6Subnet: string | null; labels: readonly string[] }
export const ctrTail = {
  inspect: (id: string): string[] => ['inspect', '--type', 'container', '--format', 'json', id],
  logs: (id: string): string[] => ['logs', '--tail', '200', '--timestamps', id],
  follow: (id: string): string[] => ['logs', '--follow', '--tail', '200', '--timestamps', id],
  search: (registry: string, term: string): string[] => ['search', '--limit', '25', '--format', 'json', registry + '/' + term],
  push: (id: string, destination: string): string[] => ['image', 'push', id, destination],
  load: (path: string, home: string): string[] => ['image', 'load', '--input', home + '/' + path],
  save: (id: string, path: string, home: string): string[] => ['image', 'save', '--output', home + '/' + path, id],
  // --pull=never: base images reach the store only through a pull the trust policy admitted.
  build: (tag: string, context: string, home: string, stdin: boolean): string[] => ['build', '--pull=never', '--tag', tag, ...(stdin ? ['--file', '-'] : []), home + '/' + context],
  pull: (image: string): string[] => ['image', 'pull', image],
  imageRemove: (id: string): string[] => ['image', 'rm', id],
  imagePrune: (): string[] => ['image', 'prune', '--all', '--force'],
  networkCreate: (n: CtrNetworkInput): string[] => ['network', 'create', '--driver', 'bridge', ...(n.subnet ? ['--subnet', n.subnet] : []), ...(n.gateway ? ['--gateway', n.gateway] : []), ...(n.range ? ['--ip-range', n.range] : []),
    ...(n.ipv6Subnet ? ['--ipv6', '--subnet', n.ipv6Subnet] : []), ...n.labels.flatMap(label => ['--label', label]), n.name],
  networkRemove: (name: string): string[] => ['network', 'rm', name],
  networkPrune: (): string[] => ['network', 'prune', '--force'],
  volumeCreate: (name: string, options: readonly string[], labels: readonly string[]): string[] => ['volume', 'create', ...options.flatMap(option => ['--opt', option]), ...labels.flatMap(label => ['--label', label]), name],
  volumeRemove: (name: string): string[] => ['volume', 'rm', name],
  migrate: (): string[] => ['system', 'migrate'],
  commit: (id: string, tag: string): string[] => ['commit', id, tag],
  login: (host: string, username: string, home: string): string[] => ['login', '--username', username, '--password-stdin', '--authfile', authFile(home), host],
  logout: (host: string, home: string): string[] => ['logout', '--authfile', authFile(home), host],
}

const flagsAreReviewed = (args: readonly string[]): boolean => {
  let ipv6 = false, ipv4 = 0
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[i + 1] ?? ''
    if (flag === '--ipv6') { if (ipv6) return false; ipv6 = true; continue }
    const ok = flag === '--driver' ? value === 'bridge' : flag === '--subnet' ? cidr(value, 4) || ipv6 && cidr(value, 6) : flag === '--gateway' ? isIP(value) === 4 : flag === '--ip-range' ? cidr(value, 4) : flag === '--label' ? LABEL.test(value) : false
    if (!ok) return false
    if (flag === '--subnet' && cidr(value, 4) && ++ipv4 > 1) return false
    i++
  }
  return true
}
/** The finite Podman argument grammar; `home` pins the auth file to the account the command runs as. */
export function isCtrTail(t: readonly string[], home: string): boolean {
  const same = (expected: readonly string[]): boolean => expected.length === t.length && expected.every((value, index) => value === t[index])
  if ([...Object.values(CTR_READS), ctrTail.imagePrune(), ctrTail.networkPrune(), ctrTail.migrate()].some(same)) return true
  const [a, b, c] = t
  const last = t.at(-1) ?? ''
  if (a === 'inspect') return CTR_ID.test(last) && same(ctrTail.inspect(last))
  if (a === 'logs') return CTR_ID.test(last) && (same(ctrTail.logs(last)) || same(ctrTail.follow(last)))
  if (a === 'search') { const at = last.indexOf('/'); return at > 0 && CTR_REGISTRY.test(last.slice(0, at)) && CTR_SEARCH_TERM.test(last.slice(at + 1)) && same(ctrTail.search(last.slice(0, at), last.slice(at + 1))) }
  if (a === 'image' && b === 'push') return t.length === 4 && CTR_ID.test(c ?? '') && system.containerImageHost(last) !== null
  if (a === 'image' && b === 'load') return last.startsWith(home + '/') && isCtrArchive(last.slice(home.length + 1)) && same(ctrTail.load(last.slice(home.length + 1), home))
  if (a === 'image' && b === 'save') { const path = t[3] ?? ''; return CTR_ID.test(last) && path.startsWith(home + '/') && isCtrArchive(path.slice(home.length + 1)) && same(ctrTail.save(last, path.slice(home.length + 1), home)) }
  if (a === 'build') { const context = last.slice(home.length + 1), tag = t[3] ?? ''; return last.startsWith(home + '/') && CTR_HOME_PATH.test(context) && CTR_COMMIT_TAG.test(tag) && (same(ctrTail.build(tag, context, home, false)) || same(ctrTail.build(tag, context, home, true))) }
  if (a === 'image' && b === 'pull') return t.length === 3 && system.containerImageHost(c) !== null
  if (a === 'image' && b === 'rm') return t.length === 3 && CTR_ID.test(c ?? '')
  if (a === 'network' && b === 'rm') return t.length === 3 && CTR_NETWORK.test(c ?? '')
  if (a === 'volume' && b === 'rm') return t.length === 3 && CTR_VOLUME.test(c ?? '')
  if (a === 'network' && b === 'create') return t.length >= 5 && CTR_NETWORK.test(last) && flagsAreReviewed(t.slice(2, -1))
  if (a === 'volume' && b === 'create') {
    const args = t.slice(2, -1)
    return t.length >= 3 && CTR_VOLUME.test(last) && args.length % 2 === 0 && args.every((value, index) => index % 2 === 0 ? value === '--opt' || value === '--label' : args[index - 1] === '--opt' ? VOLUME_OPTION.test(value) : LABEL.test(value))
  }
  if (a === 'commit') return t.length === 3 && CTR_ID.test(b ?? '') && CTR_COMMIT_TAG.test(c ?? '')
  if (a === 'login') return CTR_LOGIN.test(c ?? '') && CTR_REGISTRY.test(last) && same(ctrTail.login(last, c!, home))
  if (a === 'logout') return CTR_REGISTRY.test(last) && same(ctrTail.logout(last, home))
  return false
}

export const ctrLoginUnit = (username: string): string => `xpanel-ctrlogin-${system.assertUsername(username)}.service`
const stdinUnit = (username: string, file: string): string => file.includes('/login-') ? ctrLoginUnit(username) : `xpanel-ctrbuild-${system.assertUsername(username)}.service`
/** The same account sandbox a container unit has, for one session or one command. */
const accountSandbox = (account: CtrAccount): string[] => {
  const runtime = system.containerRuntimeDir(system.assertUsername(account.username))
  return [...['User=' + account.uid, 'Group=' + account.gid, 'Slice=' + system.accountSliceName(account.uid), 'RuntimeDirectory=' + runtime.slice('/run/'.length), 'RuntimeDirectoryMode=0700', 'RuntimeDirectoryPreserve=yes', 'PrivateTmp=yes', 'ProtectHome=tmpfs', 'BindPaths=' + account.home].flatMap(value => ['--property', value]),
    '--setenv=HOME=' + account.home, '--setenv=XDG_RUNTIME_DIR=' + runtime, '--setenv=TMPDIR=' + account.home + '/tmp']
}
/** Runs one reviewed Podman command as the account. A password or a pasted build file arrives through a root-only file that systemd opens. */
export function ctrPodmanArgv(account: CtrAccount, tail: readonly string[], stdinFile?: string): string[] {
  const user = system.assertUsername(account.username), home = account.home
  if (!isAccountHome(home, user) || !Number.isSafeInteger(account.uid) || !Number.isSafeInteger(account.gid) || !isCtrTail(tail, home) || stdinFile !== undefined && !STDIN_FILE.test(stdinFile)) return fail('VALIDATION', 'invalid container command', { stateChanged: false })
  // A dropped follower or a hung pull cannot outlive this bound.
  const runtimeMax = tail[1] === '--follow' ? CTR_FOLLOW_SECONDS + 30 : 3600
  return [system.SYSTEMD_RUN_BINARY, ...(stdinFile ? ['--unit=' + stdinUnit(user, stdinFile)] : ['--pipe']), '--wait', '--collect', '--quiet', '--working-directory=' + home,
    '--property', `RuntimeMaxSec=${runtimeMax}s`, ...(stdinFile ? ['--property', 'StandardInput=file:' + stdinFile] : []), ...accountSandbox(account), '--', system.PODMAN_BINARY, '--cgroup-manager=cgroupfs', ...tail]
}
export const CTR_FOLLOW_SECONDS = 600
/** The argv prefix of a PTY session inside one container, as the account; `podman exec` needs a terminal, the helper supplies it. */
export function ctrExecArgv(account: CtrAccount, id: string, shell: 'sh' | 'bash', asRoot: boolean): { sandbox: string[]; command: string[] } {
  if (!isAccountHome(account.home, system.assertUsername(account.username)) || !CTR_ID.test(id) || shell !== 'sh' && shell !== 'bash') return fail('VALIDATION', 'invalid container terminal', { stateChanged: false })
  return { sandbox: ['--working-directory=' + account.home, ...accountSandbox(account)], command: [system.PODMAN_BINARY, '--cgroup-manager=cgroupfs', 'exec', '--interactive', '--tty', ...(asRoot ? ['--user', '0'] : []), id, '/bin/' + shell] }
}
export const ctrRestartArgv = (unit: string): string[] => [SYSTEMCTL, 'restart', '--', unit]
export const ctrJournalArgv = (units: readonly string[], follow = false): string[] => [JOURNALCTL, ...units.map(unit => '--unit=' + unit), ...(follow ? ['--follow'] : []), ...JOURNAL_TAIL]

/** Exact outer admission: rebuilt from the argv itself, so no other unit, user, path or Podman command passes. */
export function isCtrCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.length < 2 || argv.some(value => typeof value !== 'string')) return false
  const list = argv as readonly string[]
  if (list[0] === SYSTEMCTL) return list.length === 4 && list[1] === 'restart' && list[2] === '--' && CTR_UNIT.test(list[3]!)
  if (list[0] === JOURNALCTL) {
    const units = list.slice(1, -JOURNAL_TAIL.length).filter((value, index, all) => !(value === '--follow' && index === all.length - 1))
    const login = units.length === 1 && /^--unit=xpanel-ctrlogin-[a-z][a-z0-9]{0,15}\.service$/.test(units[0]!)
    return units.length >= 1 && units.length <= 16 && (login || units.every(unit => unit.startsWith('--unit=') && CTR_UNIT.test(unit.slice(7)))) && JOURNAL_TAIL.every((value, index) => list[list.length - JOURNAL_TAIL.length + index] === value)
  }
  if (list[0] !== system.SYSTEMD_RUN_BINARY) return false
  const home = list.find(value => value.startsWith('--working-directory='))?.slice(20) ?? ''
  const uid = list.find(value => /^User=[0-9]+$/.test(value))?.slice(5), gid = list.find(value => /^Group=[0-9]+$/.test(value))?.slice(6)
  const split = list.indexOf('--'), tail = list.slice(split + 1)
  const stdinFile = list.find(value => value.startsWith('StandardInput=file:'))?.slice(19)
  if (split < 0 || !uid || !gid || tail[0] !== system.PODMAN_BINARY || tail[1] !== '--cgroup-manager=cgroupfs') return false
  try { return JSON.stringify(list) === JSON.stringify(ctrPodmanArgv({ username: home.split('/')[2] ?? '', uid: Number(uid), gid: Number(gid), home }, tail.slice(2), stdinFile)) } catch { return false }
}
