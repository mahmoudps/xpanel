import type { HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import { BOXTRAPPER_BIN_DIR, mailboxPolicySieveDir, sieveQuote } from './mail.ts'
import { AUTOREPLY_ADDRESS_RE, autoreplyAddress } from './mail-autoreply.ts'
import { assertAccount, invalid, normalizeHostedEmail } from './validate.ts'
import type { AccountRef } from './validate.ts'

export const LIST_GATE_PROGRAM_NAME = 'xpanel-list-gate'
export const LIST_GATE_PROGRAM = `${BOXTRAPPER_BIN_DIR}/${LIST_GATE_PROGRAM_NAME}`
export const LIST_POSTING_ACTIONS = ['hold', 'reject', 'discard'] as const
/** The hidden Maildir only fills when the check fails; a full one answers senders with a bounce. */
export const LIST_GATE_QUOTA_MB = 256
export type ListPostingAction = (typeof LIST_POSTING_ACTIONS)[number]

/** Everything the delivery program reads for one list. */
export interface ListGateRules {
  address: string
  /** account-owned directory beside the Maildirs: held messages, release marks, notice limiter */
  store: string
  members: string[]
  moderators: string[]
  moderatedMembers: string[]
  posting: 'open' | 'members' | 'moderated'
  nonMemberAction: ListPostingAction
  memberAction: ListPostingAction
  acceptSenders: string[]
  holdSenders: string[]
  rejectSenders: string[]
  discardSenders: string[]
  /** 0 is no limit */
  maxMessageKb: number
  notifyModerators: boolean
  notifySender: boolean
  /** 0 keeps held messages until a moderator decides */
  retentionDays: number
}
export interface ListGateList { gate: string; account: AccountRef; rules: ListGateRules }
export interface ListGateRenderInput { program: string; lists: ListGateList[] }

/** The hidden user of a list that checks posts; the prefix keeps it apart from an autoresponder of the same address. */
export const listGateAddress = (accountId: string, address: string): string => autoreplyAddress(accountId, `list:${address}`)
/** Maildir++ ignores a directory without a leading dot, so this travels with the account's mail in backups and moves. */
export const listGateStore = (home: string, address: string): string => {
  const { local, domain } = normalizeHostedEmail(address, 'mailing list')
  return `${home}/mail/${domain}/${local}/listgate`
}
const gateParts = (gate: string): { local: string; domain: string } => {
  if (!AUTOREPLY_ADDRESS_RE.test(gate)) invalid('list gate user', gate, 'is not a hidden user')
  return { local: gate.slice(0, gate.indexOf('@')), domain: gate.slice(gate.indexOf('@') + 1) }
}
/** Mail the check could not take stays in the hidden user's Maildir, which the moderation queue adopts. */
export const listGateMaildir = (home: string, gate: string): string => {
  const { local, domain } = gateParts(gate)
  return `${home}/mail/${domain}/${local}`
}
export const listGatePaths = (dir: string, gate: string): { script: string; rules: string; binary: string } => {
  const { local, domain } = gateParts(gate)
  return { script: `${dir}/${domain}/${local}.sieve`, rules: `${dir}/${domain}/${local}.list.json`, binary: `${dir}/${domain}/${local}.svbin` }
}

/** A program that fails or times out answers false: the implicit keep holds the post, so it reaches no member and is not lost. */
export const renderListGateScript = (rulesPath: string): string => [
  '# managed by xPanel: posting check of a mailing list',
  'require ["vnd.dovecot.execute"];',
  `if execute :pipe ${sieveQuote(LIST_GATE_PROGRAM_NAME)} ["filter", ${sieveQuote(rulesPath)}] {`,
  '  discard;',
  '  stop;',
  '}',
  '',
].join('\n')

/** The program, and for each gated list its rule file and compiled script, group-readable by the owning account only. */
export const renderListGate = (os: OsProfile, input: ListGateRenderInput | undefined): { files: RenderedFile[]; preActions: HostAction[]; postActions: HostAction[]; execute: boolean } => {
  const files: RenderedFile[] = [], preActions: HostAction[] = [], postActions: HostAction[] = []
  if (!input) return { files, preActions, postActions, execute: false }
  const dir = mailboxPolicySieveDir(os), domains = new Map<string, string>()
  preActions.push({ kind: 'ensure-dir', path: BOXTRAPPER_BIN_DIR, mode: 0o755, owner: 'root', group: 'root' }, { kind: 'ensure-dir', path: dir, mode: 0o755, owner: 'root', group: 'root' })
  files.push({ path: LIST_GATE_PROGRAM, content: input.program, mode: 0o755, owner: 'root', group: 'root' })
  for (const list of input.lists) {
    const account = assertAccount(list.account), paths = listGatePaths(dir, list.gate)
    domains.set(gateParts(list.gate).domain, account.username)
    files.push({ path: paths.rules, content: JSON.stringify(list.rules), mode: 0o640, owner: 'root', group: account.username },
      { path: paths.script, content: renderListGateScript(paths.rules), mode: 0o640, owner: 'root', group: account.username })
    postActions.push({ kind: 'exec', argv: ['/usr/bin/sievec', paths.script] }, { kind: 'exec', argv: ['/usr/bin/chown', `root:${account.username}`, paths.binary] }, { kind: 'exec', argv: ['/usr/bin/chmod', '0640', paths.binary] })
  }
  for (const [domain, group] of [...domains].sort(([x], [y]) => x.localeCompare(y))) preActions.push({ kind: 'ensure-dir', path: `${dir}/${domain}`, mode: 0o750, owner: 'root', group })
  return { files, preActions, postActions, execute: input.lists.length > 0 }
}
