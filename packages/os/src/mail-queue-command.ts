/** Reviewed Postfix queue grammar. Never 'ALL', never '-' (stdin), never a caller-chosen flag or path. */
export const POSTQUEUE = '/usr/sbin/postqueue'
export const POSTSUPER = '/usr/sbin/postsuper'
/** postsuper(1): the trailing "queue" operand names hold, incoming, active or deferred. */
export const MAIL_QUEUE_ACTION_QUEUES = ['incoming', 'active', 'deferred', 'hold'] as const
export type MailQueueActionQueue = typeof MAIL_QUEUE_ACTION_QUEUES[number]
export const MAIL_QUEUE_ACTIONS = ['requeue', 'hold', 'release', 'delete', 'deliver'] as const
export type MailQueueAction = typeof MAIL_QUEUE_ACTIONS[number]
export const MAIL_QUEUE_LIST_ARGV = [POSTQUEUE, '-j'] as const
const POSTSUPER_FLAG: Record<Exclude<MailQueueAction, 'deliver'>, string> = { requeue: '-r', hold: '-h', release: '-H', delete: '-d' }

// Short ids are hex; long ids (enable_long_queue_ids) use a base-52-like alphabet without vowels.
export const isMailQueueId = (value: unknown): value is string =>
  typeof value === 'string' && (/^[0-9A-F]{6,20}$/.test(value) || /^[0-9B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z]{10,26}$/.test(value))
export const isMailQueueActionQueue = (value: unknown): value is MailQueueActionQueue =>
  typeof value === 'string' && (MAIL_QUEUE_ACTION_QUEUES as readonly string[]).includes(value)
export const isMailQueueAction = (value: unknown): value is MailQueueAction =>
  typeof value === 'string' && (MAIL_QUEUE_ACTIONS as readonly string[]).includes(value)

export function mailQueueActionArgv(action: MailQueueAction, queueId: string, queue: MailQueueActionQueue): string[] {
  if (!isMailQueueAction(action) || !isMailQueueId(queueId) || !isMailQueueActionQueue(queue)) throw new Error('unsupported_mail_queue_action')
  // postqueue(1) -i: schedule immediate delivery of deferred mail with the specified queue ID.
  return action === 'deliver' ? [POSTQUEUE, '-i', queueId] : [POSTSUPER, POSTSUPER_FLAG[action], queueId, queue]
}

export function isMailQueueCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  if (argv.length === 2) return argv[0] === POSTQUEUE && argv[1] === '-j'
  if (argv.length === 3) return argv[0] === POSTQUEUE && argv[1] === '-i' && isMailQueueId(argv[2])
  return argv.length === 4 && argv[0] === POSTSUPER && Object.values(POSTSUPER_FLAG).includes(argv[1] as string)
    && isMailQueueId(argv[2]) && isMailQueueActionQueue(argv[3])
}
