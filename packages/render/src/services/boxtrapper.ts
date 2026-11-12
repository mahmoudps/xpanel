import type { HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import { BOXTRAPPER_BIN_DIR, MAX_SIEVE_REDIRECTS, mailboxPolicySieveDir, sieveQuote } from './mail.ts'
import { assertAccount, normalizeHostedEmail } from './validate.ts'
import type { AccountRef } from './validate.ts'

export const BOXTRAPPER_PROGRAM_NAME = 'xpanel-boxtrapper'
export const BOXTRAPPER_PROGRAM = `${BOXTRAPPER_BIN_DIR}/${BOXTRAPPER_PROGRAM_NAME}`
/** Everything the delivery program reads for one mailbox. */
export interface BoxTrapperRules {
  mailbox: string
  /** account-owned directory beside the Maildir: lists, queue, log */
  store: string
  extraAddresses: string[]
  displayName: string
  retentionDays: number
  /** null while no spam filter rewrites the score header */
  spamBypass: number | null
  autoAllowSent: boolean
  allowByAssociation: boolean
  dailyNotices: number
  templates: Record<'verify' | 'released' | 'failed' | 'deny', { subject: string; body: string }>
}
export interface BoxTrapperMailbox { address: string; account: AccountRef; rules: BoxTrapperRules; forward: string[] }
export interface BoxTrapperRenderInput { program: string; mailboxes: BoxTrapperMailbox[] }

export const boxTrapperPaths = (dir: string, domain: string, local: string): { script: string; rules: string; binary: string } =>
  ({ script: `${dir}/${domain}/${local}.boxtrapper.sieve`, rules: `${dir}/${domain}/${local}.boxtrapper.json`, binary: `${dir}/${domain}/${local}.boxtrapper.svbin` })

/** A program that fails or times out answers false, so the message stays in normal delivery. */
export const renderBoxTrapperScript = (rulesPath: string, forward: readonly string[]): string => [
  "# managed by xPanel: BoxTrapper, after the mailbox spam policy and before the mailbox's own filters",
  `require [${['vnd.dovecot.execute', 'variables', ...forward.length ? ['copy'] : []].map(sieveQuote).join(', ')}];`,
  `if execute :pipe :output "boxtrapper" ${sieveQuote(BOXTRAPPER_PROGRAM_NAME)} ["filter", ${sieveQuote(rulesPath)}] {`,
  '  if string :is "${boxtrapper}" "hold" {',
  '    discard;',
  '    stop;',
  '  }',
  ...forward.length ? ['  if string :is "${boxtrapper}" "allow" {', ...forward.map(address => `    redirect :copy ${sieveQuote(address)};`), '  }'] : [],
  '}',
  '',
].join('\n')

/**
 * The program, and for each enabled mailbox its rule file and compiled script, group-readable by the owning account
 * only. No input renders nothing; a compile failure fails the generation.
 */
export const renderBoxTrapper = (os: OsProfile, input: BoxTrapperRenderInput | undefined): { files: RenderedFile[]; preActions: HostAction[]; postActions: HostAction[]; execute: boolean } => {
  const files: RenderedFile[] = [], preActions: HostAction[] = [], postActions: HostAction[] = []
  if (!input) return { files, preActions, postActions, execute: false }
  const dir = mailboxPolicySieveDir(os)
  preActions.push({ kind: 'ensure-dir', path: BOXTRAPPER_BIN_DIR, mode: 0o755, owner: 'root', group: 'root' }, { kind: 'ensure-dir', path: dir, mode: 0o755, owner: 'root', group: 'root' })
  files.push({ path: BOXTRAPPER_PROGRAM, content: input.program, mode: 0o755, owner: 'root', group: 'root' })
  const domains = new Map<string, string>()
  for (const box of input.mailboxes) {
    const account = assertAccount(box.account), { local, domain } = normalizeHostedEmail(box.address, 'mailbox')
    if (box.forward.length > MAX_SIEVE_REDIRECTS) throw new Error('boxtrapper_forward_limit')
    domains.set(domain, account.username)
    const paths = boxTrapperPaths(dir, domain, local)
    files.push({ path: paths.rules, content: JSON.stringify(box.rules), mode: 0o640, owner: 'root', group: account.username },
      { path: paths.script, content: renderBoxTrapperScript(paths.rules, box.forward), mode: 0o640, owner: 'root', group: account.username })
    postActions.push({ kind: 'exec', argv: ['/usr/bin/sievec', '-P', 'sieve_extprograms', '-x', '+vnd.dovecot.execute', paths.script] }, { kind: 'exec', argv: ['/usr/bin/chown', `root:${account.username}`, paths.binary] }, { kind: 'exec', argv: ['/usr/bin/chmod', '0640', paths.binary] })
  }
  for (const [domain, group] of [...domains].sort(([x], [y]) => x.localeCompare(y))) preActions.push({ kind: 'ensure-dir', path: `${dir}/${domain}`, mode: 0o750, owner: 'root', group })
  return { files, preActions, postActions, execute: input.mailboxes.length > 0 }
}
