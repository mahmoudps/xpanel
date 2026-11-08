import { isMaintenanceMailbox } from './mailbox-maintenance-command.ts'

/**
 * Reviewed doveadm-expunge(1) grammar for Email Disk Usage: one literal mailbox after -u, one literal folder and a
 * search query of fixed keywords. Never -A, a user mask, a folder mask or a query with no condition.
 */
const DOVEADM = '/usr/bin/doveadm'
export const MAILBOX_EXPUNGE_MAX_TERMS = 8
const SIZE = /^[1-9][0-9]{0,11}[BKMGT]?$/
const DATE = /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[1-9][0-9]{0,4}[dwh])$/
const TEXT = /^[A-Za-z0-9@._+-]{1,64}$/
// doveadm-search-query(7) keywords; ALL is the fixed "all messages" preset and never part of a typed query.
const KEYWORDS: Readonly<Record<string, RegExp | null>> = { LARGER: SIZE, SMALLER: SIZE, BEFORE: DATE, SINCE: DATE, SAVEDBEFORE: DATE, SAVEDSINCE: DATE, SENTBEFORE: DATE, SENTSINCE: DATE, FROM: TEXT, TO: TEXT, SUBJECT: TEXT, BODY: TEXT, SEEN: null, UNSEEN: null, FLAGGED: null, UNFLAGGED: null }

/** A folder as doveadm listed it; a mask or option-like name is refused. */
export const isExpungeFolder = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 255 && !/[\u0000-\u001f\u007f*%]/.test(value) && !value.startsWith('-')

/** Upper-cased terms of a typed query, or null when it is empty or holds anything outside the grammar. */
export function parseExpungeQuery(text: unknown): string[] | null {
  if (typeof text !== 'string' || text.length > 200) return null
  const tokens = text.trim().split(/\s+/).filter(Boolean), terms: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const keyword = tokens[index]!.toUpperCase()
    if (!Object.hasOwn(KEYWORDS, keyword)) return null
    terms.push(keyword)
    const argument = KEYWORDS[keyword]
    if (argument) { const value = tokens[++index]; if (value === undefined || !argument.test(value)) return null; terms.push(value) }
  }
  return terms.length >= 1 && terms.length <= MAILBOX_EXPUNGE_MAX_TERMS * 2 ? terms : null
}
const validTerms = (terms: readonly string[]): boolean => terms.length === 1 && terms[0] === 'ALL' || JSON.stringify(parseExpungeQuery(terms.join(' '))) === JSON.stringify(terms)

export function mailboxExpungeArgv(mailbox: string, folder: string, terms: readonly string[]): string[] {
  if (!isMaintenanceMailbox(mailbox) || !isExpungeFolder(folder) || !validTerms(terms)) throw new Error('unsupported_mailbox_expunge')
  return [DOVEADM, 'expunge', '-u', mailbox, 'mailbox', folder, ...terms]
}
export function isMailboxExpungeCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string') || argv[0] !== DOVEADM || argv[1] !== 'expunge') return false
  try { return JSON.stringify(argv) === JSON.stringify(mailboxExpungeArgv(argv[3] as string, argv[5] as string, argv.slice(6) as string[])) } catch { return false }
}
