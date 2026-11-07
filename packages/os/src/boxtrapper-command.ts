import { services } from '@xpanel/render'

const { BOXTRAPPER_PROGRAM } = services
/** Pigeonhole's sieve_extprograms module, shipped by dovecot-sieve (Debian family) and dovecot-pigeonhole (EL). */
export const BOXTRAPPER_PLUGIN = { debian: '/usr/lib/dovecot/modules/sieve/lib90_sieve_extprograms_plugin.so', rhel: '/usr/lib64/dovecot/sieve/lib90_sieve_extprograms_plugin.so' } as const

export const BOXTRAPPER_ACTIONS = ['deliver', 'allow', 'delete', 'ignore', 'deny'] as const
export type BoxTrapperAction = (typeof BOXTRAPPER_ACTIONS)[number]
export const BOXTRAPPER_ID = /^\d{8}-[0-9a-f]{32}$/
export const BOXTRAPPER_MAX_IDS = 100
const USER = /^[a-z_][a-z0-9_-]{0,31}$/
const STORE = /^\/home[0-9]{0,3}\/([a-z_][a-z0-9_-]{0,31})\/mail\/[a-z0-9.-]{1,253}\/[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\/boxtrapper$/
const MAILBOX = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@[a-z0-9.-]{1,253}$/
const DAY = /^(?:latest|\d{8})$/
const REVISION = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]{1,120000}={0,2}$/

export type BoxTrapperCall =
  | { op: 'queue' | 'log'; day: string }
  | { op: 'message'; id: string }
  | { op: 'lists' }
  | { op: 'lists-set'; revision: string; encoded: string }
  | { op: 'act'; mailbox: string; action: BoxTrapperAction; ids: readonly string[] }

const callArgs = (call: BoxTrapperCall): string[] => {
  switch (call.op) {
    case 'queue': case 'log': return [call.day]
    case 'message': return [call.id]
    case 'lists': return []
    case 'lists-set': return [call.revision, call.encoded]
    case 'act': return [call.mailbox, call.action, ...call.ids]
  }
}
export const boxTrapperArgv = (account: string, store: string, call: BoxTrapperCall): string[] =>
  ['/usr/sbin/runuser', '-u', account, '--', BOXTRAPPER_PROGRAM, call.op, store, ...callArgs(call)]

/** Reviewed grammar of the BoxTrapper program calls the agent makes as the mailbox's account. */
export const isBoxTrapperCommand = (argv: readonly string[]): boolean => {
  if (argv.length < 7 || argv[0] !== '/usr/sbin/runuser' || argv[1] !== '-u' || !USER.test(argv[2] ?? '') || argv[3] !== '--' || argv[4] !== BOXTRAPPER_PROGRAM || STORE.exec(argv[6] ?? '')?.[1] !== argv[2]) return false
  const op = argv[5], args = argv.slice(7)
  if (op === 'queue' || op === 'log') return args.length === 1 && DAY.test(args[0]!)
  if (op === 'message') return args.length === 1 && BOXTRAPPER_ID.test(args[0]!)
  if (op === 'lists') return args.length === 0
  if (op === 'lists-set') return args.length === 2 && REVISION.test(args[0]!) && BASE64.test(args[1]!)
  if (op === 'act') return args.length >= 3 && args.length <= BOXTRAPPER_MAX_IDS + 2 && MAILBOX.test(args[0]!) && (BOXTRAPPER_ACTIONS as readonly string[]).includes(args[1]!) && args.slice(2).every(id => BOXTRAPPER_ID.test(id))
  return false
}
