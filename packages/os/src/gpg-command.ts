import { fail } from '@xpanel/core'

export const GPG_FINGERPRINT = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/
export const GPG_REVISION = /^[a-f0-9]{64}$/
export const GPG_MAX_KEYS = 100
export const GPG_MAX_ARMOR_BYTES = 256 * 1024
export const GPG_MAX_OUTPUT_BYTES = 1024 * 1024
export type GpgAlgorithm = 'ed25519' | 'rsa3072'
export type GpgCommand = { op: 'version' }
  | { op: 'public' }
  | { op: 'secret' }
  | { op: 'inspect' }
  | { op: 'import' }
  | { op: 'generate'; uid: string; algorithm: GpgAlgorithm; days: number }
  | { op: 'subkey'; fingerprint: string; algorithm: GpgAlgorithm; days: number }
  | { op: 'export'; fingerprint: string }
  | { op: 'delete'; fingerprint: string }
export interface GpgIdentity { username: string; uid: number; gid: number; home: string }
const bad = (): never => fail('VALIDATION', 'invalid OpenPGP command', { stateChanged: false })
export const isGpgUid = (value: unknown): value is string => typeof value === 'string' && value.length <= 320 && !/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(value) && /^[^<>\r\n\x00-\x1f]{1,100} <[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{1,253}>$/.test(value)
export function gpgIdentity(value: GpgIdentity): GpgIdentity {
  if (!/^[a-z][a-z0-9]{1,15}$/.test(value.username) || value.home !== '/home/' + value.username || !Number.isSafeInteger(value.uid) || value.uid < 1000 || value.uid > 65533 || !Number.isSafeInteger(value.gid) || value.gid < 1000 || value.gid > 65533) return bad()
  return value
}
/** gpg(1): --no-options must be first; batch + loopback passphrase-fd reads one secret line from stdin. */
export function gpgArgv(identity: GpgIdentity, command: GpgCommand): string[] {
  const account = gpgIdentity(identity)
  if (!command || typeof command !== 'object' || !['version', 'public', 'secret', 'inspect', 'import', 'generate', 'subkey', 'export', 'delete'].includes(command.op)) return bad()
  const fields = command.op === 'generate' ? ['op', 'uid', 'algorithm', 'days'] : command.op === 'subkey' ? ['op', 'fingerprint', 'algorithm', 'days'] : command.op === 'export' || command.op === 'delete' ? ['op', 'fingerprint'] : ['op']
  if (Object.keys(command).length !== fields.length || fields.some(field => !Object.hasOwn(command, field))) return bad()
  const base = ['/usr/bin/gpg', '--no-options', '--homedir', account.home + '/.gnupg', '--batch', '--no-tty', '--no-auto-key-retrieve', '--no-auto-check-trustdb']
  if (command.op === 'version') return [...base, '--version']
  if (command.op === 'public' || command.op === 'secret') return [...base, '--with-colons', '--fixed-list-mode', '--with-fingerprint', '--with-fingerprint', command.op === 'public' ? '--list-keys' : '--list-secret-keys']
  if (command.op === 'inspect') return [...base, '--with-colons', '--with-fingerprint', '--with-fingerprint', '--import-options', 'show-only', '--dry-run', '--import']
  if (command.op === 'import') return [...base, '--status-fd', '2', '--import']
  if (command.op === 'delete' || command.op === 'export') {
    if (!GPG_FINGERPRINT.test(command.fingerprint)) return bad()
    return command.op === 'export' ? [...base, '--armor', '--export', command.fingerprint] : [...base, '--status-fd', '2', '--yes', '--delete-secret-and-public-key', command.fingerprint]
  }
  if (!['ed25519', 'rsa3072'].includes(command.algorithm) || !Number.isInteger(command.days) || command.days < 1 || command.days > 3650) return bad()
  const secret = [...base, '--status-fd', '2', '--pinentry-mode', 'loopback', '--passphrase-fd', '0']
  if (command.op === 'generate') {
    if (!isGpgUid(command.uid)) return bad()
    return [...secret, '--quick-generate-key', command.uid, command.algorithm, 'cert,sign', String(command.days) + 'd']
  }
  if (!GPG_FINGERPRINT.test(command.fingerprint)) return bad()
  return [...secret, '--quick-add-key', command.fingerprint, command.algorithm === 'ed25519' ? 'cv25519' : 'rsa3072', 'encr', String(command.days) + 'd']
}
/** setpriv(1): clear inherited supplementary groups and prevent privilege gains before executing GnuPG. */
export function gpgAccountArgv(identity: GpgIdentity, command: GpgCommand): string[] {
  gpgIdentity(identity)
  return ['/usr/bin/setpriv', '--reuid', String(identity.uid), '--regid', String(identity.gid), '--clear-groups', '--no-new-privs', '--', ...gpgArgv(identity, command)]
}
export function isGpgCommand(argv: readonly unknown[]): boolean {
  if (argv.length === 3 && argv[0] === '/usr/bin/gpg' && argv[1] === '--no-options' && argv[2] === '--version') return true
  if (argv.some(value => typeof value !== 'string') || argv.length < 17 || argv[0] !== '/usr/bin/setpriv' || argv[1] !== '--reuid' || argv[3] !== '--regid' || argv[5] !== '--clear-groups' || argv[6] !== '--no-new-privs' || argv[7] !== '--') return false
  const args = argv as string[], match = /^\/home\/([a-z][a-z0-9]{1,15})\/\.gnupg$/.exec(args[11] ?? '')
  if (!match) return false
  const identity = { username: match[1]!, uid: Number(args[2]), gid: Number(args[4]), home: '/home/' + match[1] }
  const tail = args.slice(17), commands: GpgCommand[] = [{ op: 'version' }, { op: 'public' }, { op: 'secret' }, { op: 'inspect' }, { op: 'import' }]
  if (tail.length >= 1) for (const op of ['export', 'delete'] as const) commands.push({ op, fingerprint: args.at(-1)! })
  for (const algorithm of ['ed25519', 'rsa3072'] as const) {
    const days = Number(args.at(-1)?.replace(/d$/, ''))
    commands.push({ op: 'generate', uid: args.at(-4)!, algorithm, days }, { op: 'subkey', fingerprint: args.at(-4)!, algorithm, days })
  }
  return commands.some(command => { try { return JSON.stringify(gpgAccountArgv(identity, command)) === JSON.stringify(args) } catch { return false } })
}
export function validateGpgArmor(input: unknown, publicOnly = false): { armor: string; secret: boolean } {
  if (typeof input !== 'string' || input.length > GPG_MAX_ARMOR_BYTES || /[^\x09\x0a\x0d\x20-\x7e]/.test(input)) return bad()
  const armor = input.replace(/\r\n/g, '\n').trim() + '\n'
  const match = /^-----BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK-----\n(?:(?:Version|Comment): [^\n]{0,200}\n)*\n(?:[A-Za-z0-9+/]{1,76}={0,2}\n)+(?:=[A-Za-z0-9+/]{4}\n)?-----END PGP \1 KEY BLOCK-----\n$/.exec(armor)
  if (!match || publicOnly && match[1] !== 'PUBLIC') return bad()
  return { armor, secret: match[1] === 'PRIVATE' }
}
