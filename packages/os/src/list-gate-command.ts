import { services } from '@xpanel/render'

const { LIST_GATE_PROGRAM } = services

export const LIST_GATE_ACTIONS = ['approve', 'reject', 'discard'] as const
export type ListGateAction = (typeof LIST_GATE_ACTIONS)[number]
export const LIST_GATE_ID = /^\d{8}-[0-9a-f]{32}$/
export const LIST_GATE_MAX_IDS = 100
const USER = /^[a-z_][a-z0-9_-]{0,31}$/
const STORE = /^\/home[0-9]{0,3}\/([a-z_][a-z0-9_-]{0,31})\/mail\/[a-z0-9.-]{1,253}\/[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\/listgate$/
const MAILDIR = /^\/home[0-9]{0,3}\/([a-z_][a-z0-9_-]{0,31})\/mail\/a[0-9a-f]{16}\.autoreply\.xpanel\.invalid\/r[0-9a-f]{20}$/
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@[a-z0-9.-]{1,253}$/
const REASON = /^(?:-|[A-Za-z0-9+/]{1,2800}={0,2})$/

export type ListGateCall =
  | { op: 'queue' | 'purge'; maildir: string }
  | { op: 'message'; id: string }
  | { op: 'act'; address: string; action: ListGateAction; reason: string; ids: readonly string[] }

const callArgs = (call: ListGateCall): string[] => {
  switch (call.op) {
    case 'queue': case 'purge': return [call.maildir]
    case 'message': return [call.id]
    case 'act': return [call.address, call.action, call.reason, ...call.ids]
  }
}
export const listGateArgv = (account: string, store: string, call: ListGateCall): string[] =>
  ['/usr/sbin/runuser', '-u', account, '--', LIST_GATE_PROGRAM, call.op, store, ...callArgs(call)]

/** Reviewed grammar of the list gate program calls the agent makes as the list's account. */
export const isListGateCommand = (argv: readonly string[]): boolean => {
  if (argv.length < 8 || argv[0] !== '/usr/sbin/runuser' || argv[1] !== '-u' || !USER.test(argv[2] ?? '') || argv[3] !== '--' || argv[4] !== LIST_GATE_PROGRAM || STORE.exec(argv[6] ?? '')?.[1] !== argv[2]) return false
  const op = argv[5], args = argv.slice(7)
  if (op === 'queue' || op === 'purge') return args.length === 1 && MAILDIR.exec(args[0]!)?.[1] === argv[2]
  if (op === 'message') return args.length === 1 && LIST_GATE_ID.test(args[0]!)
  if (op === 'act') return args.length >= 4 && args.length <= LIST_GATE_MAX_IDS + 3 && ADDRESS.test(args[0]!) && (LIST_GATE_ACTIONS as readonly string[]).includes(args[1]!) && REASON.test(args[2]!) && args.slice(3).every(id => LIST_GATE_ID.test(id))
  return false
}
