import { fail } from '@xpanel/core'
import { QUARANTINE_GUID, QUARANTINE_UUID, QUARANTINE_MAILBOX, QUARANTINE_FOLDERS, QUARANTINE_PAGE_UIDS, quarantineIdentity } from '../../core/src/mail-quarantine.ts'
export { QUARANTINE_GUID, QUARANTINE_UUID, QUARANTINE_MAILBOX, QUARANTINE_FOLDERS } from '../../core/src/mail-quarantine.ts'

export const QUARANTINE_STATUS_FIELDS = 'guid uidvalidity uidnext messages'
export const QUARANTINE_SUMMARY_FIELDS = 'mailbox-guid uid guid date.received.unixtime date.saved.unixtime size.virtual hdr.from hdr.to hdr.subject hdr.x-spam-score hdr.x-spam-status'
export const QUARANTINE_RAW_FIELDS = 'mailbox-guid uid guid text'
export const QUARANTINE_ID_FIELDS = 'mailbox-guid uid guid'
const username = quarantineIdentity.username
const uid = quarantineIdentity.uidText
const range = (value: string): boolean => {
  const parts = value.split(':')
  return parts.length <= 2 && parts.every(uid) && (parts.length === 1 || Number(parts[0]) <= Number(parts[1]) && Number(parts[1]) - Number(parts[0]) < QUARANTINE_PAGE_UIDS)
}
const mailbox = quarantineIdentity.address
export const quarantineStagePath = (accountId: string, operationId: string): string => `/var/lib/xpanel/mail-quarantine/${accountId}/stage/${operationId}.eml`
export const quarantineBayesPath = (accountId: string): string => `/var/lib/xpanel/mail-spam/${accountId}/bayes`
export const isQuarantineStagePath = (value: string): boolean => /^\/var\/lib\/xpanel\/mail-quarantine\/[0-9a-f-]{36}\/stage\/[0-9a-f-]{36}\.eml$/.test(value)
  && QUARANTINE_UUID.test(value.split('/')[5]!) && QUARANTINE_UUID.test(value.split('/')[7]!.slice(0, -4))

/** Finite exception for Dovecot's literal multi-field argument; never widen generic SAFE_ARG. */
export function isMailQuarantineArgv(input: readonly unknown[]): input is readonly string[] {
  if (!Array.isArray(input) || Array.from(input).some(part => typeof part !== 'string' || part.includes('\0'))) return false
  const argv = input as readonly string[]
  if (argv[0] === '/usr/sbin/runuser') {
    const accountId = argv[7]?.split('/')[5]
    return argv.length === 9 && argv[1] === '-u' && username.test(argv[2]!) && argv[3] === '--'
      && argv[4] === '/usr/bin/sa-learn' && argv[5] === '--ham' && argv[6] === '--dbpath'
      && !!accountId && QUARANTINE_UUID.test(accountId) && argv[7] === quarantineBayesPath(accountId)
      && isQuarantineStagePath(argv[8]!) && argv[8]!.split('/')[5] === accountId
  }
  if (argv[0] !== '/usr/bin/doveadm') return false
  if (argv[1] === '-f' && argv[2] === 'json') {
    if (argv[3] === 'mailbox') return argv.length === 9 && argv[4] === 'status' && argv[5] === '-u'
      && mailbox(argv[6]!) && argv[7] === QUARANTINE_STATUS_FIELDS && [...QUARANTINE_FOLDERS, 'INBOX'].includes(argv[8]!)
    if (argv[3] !== 'fetch' || argv[4] !== '-u' || !mailbox(argv[5]!)) return false
    if (argv.length === 11 && argv[6] === QUARANTINE_ID_FIELDS && argv[7] === 'mailbox' && argv[8] === 'INBOX' && argv[9] === 'guid') return QUARANTINE_GUID.test(argv[10]!)
    return [11, 13].includes(argv.length) && [QUARANTINE_SUMMARY_FIELDS, QUARANTINE_RAW_FIELDS, QUARANTINE_ID_FIELDS].includes(argv[6]!)
      && argv[7] === 'mailbox-guid' && QUARANTINE_GUID.test(argv[8]!) && argv[9] === 'uid'
      && (argv.length === 11 ? argv[6] === QUARANTINE_SUMMARY_FIELDS && range(argv[10]!) : uid(argv[10]!) && argv[11] === 'guid' && QUARANTINE_GUID.test(argv[12]!))
  }
  const moving = argv[1] === 'move', deleting = argv[1] === 'expunge'
  if (!moving && !deleting || argv[2] !== '-u' || !mailbox(argv[3]!)) return false
  const start = moving ? 5 : 4
  return argv.length === (moving ? 11 : 10) && (!moving || argv[4] === 'INBOX')
    && argv[start] === 'mailbox-guid' && QUARANTINE_GUID.test(argv[start + 1]!) && argv[start + 2] === 'uid' && uid(argv[start + 3]!)
    && argv[start + 4] === 'guid' && QUARANTINE_GUID.test(argv[start + 5]!)
}

export const assertMailQuarantineArgv = (argv: string[]): string[] =>
  isMailQuarantineArgv(argv) ? argv : fail('VALIDATION', 'unsupported quarantine command', { stateChanged: false })
