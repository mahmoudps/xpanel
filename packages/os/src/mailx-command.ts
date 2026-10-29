/**
 * Reviewed grammar for the server mail policy applier (inbound spam, SMTP relay, BCC copies, bulk-sending limits and
 * account archives). postconf(1) -e/-X only ever name the fixed MAILX_POSTCONF keys below with values matching their
 * exact grammar; every other argv is a literal. No shell, no caller-selected binary, path or setting name.
 */
export const MAILX_POSTCONF = '/usr/sbin/postconf'
export const MAILX_POSTFIX = '/usr/sbin/postfix'
export const MAILX_SYSTEMCTL = '/usr/bin/systemctl'
export const MAILX_DOVEADM = '/usr/bin/doveadm'
export const MAILX_MAP_DIR = '/etc/postfix/xpanel/mailx'
export const MAILX_MAPS = {
  relaySasl: `${MAILX_MAP_DIR}/relay_sasl`,
  relayTls: `${MAILX_MAP_DIR}/relay_tls_policy`,
  recipientBcc: `${MAILX_MAP_DIR}/recipient_bcc`,
  senderBcc: `${MAILX_MAP_DIR}/sender_bcc`,
} as const
// postfix(1): `check` validates the configuration and file permissions; `reload` re-reads it without dropping mail.
export const MAILX_POSTFIX_CHECK_ARGV = [MAILX_POSTFIX, 'check'] as const
export const MAILX_POSTFIX_RELOAD_ARGV = [MAILX_POSTFIX, 'reload'] as const
export const MAILX_POSTCONF_MAIN_ARGV = [MAILX_POSTCONF, '-n'] as const
// rspamadm(1) configtest parses the whole configuration; spamassassin(1) --lint checks the site rules.
export const MAILX_RSPAMD_TEST_ARGV = ['/usr/bin/rspamadm', 'configtest'] as const
export const MAILX_SPAMASSASSIN_TEST_ARGV = ['/usr/bin/spamassassin', '--lint'] as const
export const MAILX_ENGINE_UNITS = ['rspamd.service', 'spamassassin.service', 'spamd.service'] as const
export type MailxEngineUnit = typeof MAILX_ENGINE_UNITS[number]
/** SpamAssassin reaches Postfix through spamass-milter; the unit is observed only, never reloaded. */
export const MAILX_SPAMASS_MILTER_UNIT = 'spamass-milter.service'
export type MailxShowUnit = MailxEngineUnit | typeof MAILX_SPAMASS_MILTER_UNIT
// Postfix milter addresses (MILTER_README): the rspamd proxy worker listens on localhost:11332 with milter = yes.
// Debian's spamass-milter binds inside the Postfix queue directory (relative, so chroot or not); the EL
// spamass-milter-postfix package binds /run/spamass-milter/postfix/sock for the non-chrooted smtpd.
export const MAILX_RSPAMD_MILTER = 'inet:localhost:11332'
export const MAILX_SPAMASS_MILTERS = { debian: 'local:spamass/spamass.sock', rhel: 'unix:/run/spamass-milter/postfix/sock' } as const
/** Reconciler-rendered tables the mail policy status reads back (both families keep Postfix and Dovecot in /etc). */
export const MAILX_VIRTUAL_ALIASES = '/etc/postfix/xpanel/virtual_aliases'
export const MAILX_SIEVE_DIR = '/etc/dovecot/xpanel/sieve'

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const ADDRESS = /^(?=.{3,254}$)[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9_+-])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
export const isMailxHost = (value: unknown): value is string => typeof value === 'string' && HOST.test(value) && !value.split('.').some(label => label.startsWith('xn--') && label.length < 5)
export const isMailxAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value) && !value.split('@')[0]!.includes('..')
const count = (min: number, max: number, suffix = '') => (value: string): boolean => {
  const digits = suffix ? value.slice(0, -suffix.length) : value
  return (!suffix || value.endsWith(suffix)) && /^(?:0|[1-9][0-9]{0,6})$/.test(digits) && Number(digits) >= min && Number(digits) <= max
}
const literal = (...values: string[]) => (value: string): boolean => values.includes(value)

/** postconf(5) parameters this applier may set; each value grammar is closed. Reconciler-owned keys are never listed. */
export const MAILX_POSTCONF_KEYS: Readonly<Record<string, (value: string) => boolean>> = Object.freeze({
  relayhost: (value: string) => value === '' || (/^\[([^\]]+)\]:([0-9]{1,5})$/.test(value) && isMailxHost(value.slice(1, value.indexOf(']'))) && count(1, 65535)(value.slice(value.indexOf(']') + 2))),
  smtp_sasl_auth_enable: literal('yes', 'no'),
  smtp_sasl_password_maps: literal('', `texthash:${MAILX_MAPS.relaySasl}`),
  smtp_sasl_security_options: literal('noanonymous'),
  smtp_sasl_tls_security_options: literal('noanonymous'),
  smtp_tls_policy_maps: literal('', `texthash:${MAILX_MAPS.relayTls}`),
  always_bcc: (value: string) => value === '' || isMailxAddress(value),
  recipient_bcc_maps: literal('', `texthash:${MAILX_MAPS.recipientBcc}`),
  sender_bcc_maps: literal('', `texthash:${MAILX_MAPS.senderBcc}`),
  smtpd_client_message_rate_limit: count(0, 1000000),
  smtpd_client_recipient_rate_limit: count(0, 1000000),
  smtpd_recipient_limit: count(1, 100000),
  default_destination_rate_delay: count(0, 3600, 's'),
  default_destination_concurrency_limit: count(1, 1000),
  anvil_rate_time_unit: count(60, 86400, 's'),
})
export const isMailxPostconfKey = (key: unknown): key is string => typeof key === 'string' && Object.hasOwn(MAILX_POSTCONF_KEYS, key)
const unsupported = (): never => { throw new Error('unsupported_mailx_command') }

export function mailxPostconfSetArgv(settings: Readonly<Record<string, string>>): string[] {
  const entries = Object.entries(settings)
  if (!entries.length || entries.some(([key, value]) => !isMailxPostconfKey(key) || typeof value !== 'string' || !MAILX_POSTCONF_KEYS[key]!(value))) return unsupported()
  return [MAILX_POSTCONF, '-e', ...entries.map(([key, value]) => `${key}=${value}`)]
}
/** postconf(1) -X removes a parameter from main.cf; used only to roll back a key that was absent before an apply. */
export function mailxPostconfUnsetArgv(keys: readonly string[]): string[] {
  if (!keys.length || keys.some(key => !isMailxPostconfKey(key)) || new Set(keys).size !== keys.length) return unsupported()
  return [MAILX_POSTCONF, '-X', ...keys]
}
export const isMailxEngineUnit = (value: unknown): value is MailxEngineUnit => (MAILX_ENGINE_UNITS as readonly unknown[]).includes(value)
const isMailxShowUnit = (value: unknown): value is MailxShowUnit => isMailxEngineUnit(value) || value === MAILX_SPAMASS_MILTER_UNIT
// systemctl(1) show prints Property=value lines for the requested properties only.
export const mailxEngineShowArgv = (unit: MailxShowUnit): string[] => isMailxShowUnit(unit) ? [MAILX_SYSTEMCTL, 'show', '--no-pager', '--property=LoadState,ActiveState', '--', unit] : unsupported()
export const mailxEngineReloadArgv = (unit: MailxEngineUnit): string[] => isMailxEngineUnit(unit) ? [MAILX_SYSTEMCTL, 'reload', '--', unit] : unsupported()

/** One saved archive mailbox login: lowercase local@domain whose local part cannot read as an option. */
export const isMailxArchiveLogin = (value: unknown): value is string => isMailxAddress(value)
export const MAILX_RETENTION_MAX_DAYS = 3650
/** doveadm-expunge(1): delete INBOX messages saved before the cutoff in one named mailbox; never -A or a user mask. */
export function mailxArchiveExpungeArgv(login: string, days: number): string[] {
  if (!isMailxArchiveLogin(login) || !Number.isSafeInteger(days) || days < 1 || days > MAILX_RETENTION_MAX_DAYS) return unsupported()
  return [MAILX_DOVEADM, 'expunge', '-u', login, 'mailbox', 'INBOX', 'savedbefore', `${days}d`]
}

const strings = (argv: readonly unknown[]): argv is string[] => Array.isArray(argv) && argv.every(value => typeof value === 'string')
const same = (argv: readonly string[], expected: readonly string[]): boolean => argv.length === expected.length && expected.every((value, index) => argv[index] === value)
const attempt = (build: () => string[]): string[] | null => { try { return build() } catch { return null } }

/** Executor admission for the mail policy applier. */
export function isMailxCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv)) return false
  if ([MAILX_POSTCONF_MAIN_ARGV, MAILX_POSTFIX_CHECK_ARGV, MAILX_POSTFIX_RELOAD_ARGV, MAILX_RSPAMD_TEST_ARGV, MAILX_SPAMASSASSIN_TEST_ARGV].some(expected => same(argv, expected))) return true
  if (argv[0] === MAILX_POSTCONF && argv[1] === '-e') {
    const pairs = argv.slice(2).map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)] as const)
    if (argv.slice(2).some(item => !item.includes('=')) || new Set(pairs.map(([key]) => key)).size !== pairs.length) return false
    const rebuilt = attempt(() => mailxPostconfSetArgv(Object.fromEntries(pairs)))
    return !!rebuilt && same(argv, rebuilt)
  }
  if (argv[0] === MAILX_POSTCONF && argv[1] === '-X') { const rebuilt = attempt(() => mailxPostconfUnsetArgv(argv.slice(2))); return !!rebuilt && same(argv, rebuilt) }
  const unit = argv[argv.length - 1]
  return isMailxShowUnit(unit) && same(argv, mailxEngineShowArgv(unit)) || isMailxEngineUnit(unit) && same(argv, mailxEngineReloadArgv(unit))
}

/** Host job policy for archive retention: exactly one reviewed expunge step. */
export function isMailxRetentionJobCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv) || argv.length !== 8) return false
  const days = /^([1-9][0-9]{0,3})d$/.exec(argv[7] ?? '')
  const rebuilt = days ? attempt(() => mailxArchiveExpungeArgv(argv[3]!, Number(days[1]))) : null
  return !!rebuilt && same(argv, rebuilt)
}

// rspamc(1) learn_spam/learn_ham and sa-learn(1) --spam/--ham accept a directory and read every message file in it.
export const MAILX_RSPAMC = '/usr/bin/rspamc'
export const MAILX_SA_LEARN = '/usr/bin/sa-learn'
export type MailxLearnDirection = 'spam' | 'ham'
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9_+-])?$/
/** One mailbox Maildir folder: INBOX (`cur`) for ham, the Dovecot special-use Junk folder (`.Junk/cur`, Maildir++ layout) for spam. */
export function mailxLearnFolder(home: string, mailbox: string, direction: MailxLearnDirection): string {
  const at = mailbox.indexOf('@'), local = mailbox.slice(0, at), domain = mailbox.slice(at + 1)
  if (!/^\/home\/[a-z][a-z0-9]{0,15}$/.test(home) || !isMailxAddress(mailbox) || !LOCAL_PART.test(local) || local.includes('..') || !isMailxHost(domain) || !['spam', 'ham'].includes(direction)) return unsupported()
  return `${home}/mail/${domain}/${local}/${direction === 'spam' ? '.Junk/' : ''}cur`
}
const LEARN_FOLDER = /^\/home\/[a-z][a-z0-9]{0,15}\/mail\/([^/]+)\/([^/]+)\/(\.Junk\/)?cur$/
export function mailxLearnArgv(engine: 'rspamd' | 'spamassassin', direction: MailxLearnDirection, folder: string): string[] {
  const match = LEARN_FOLDER.exec(folder)
  if (!match || !isMailxHost(match[1]) || !LOCAL_PART.test(match[2]!) || match[2]!.includes('..') || (direction === 'spam') !== !!match[3]) return unsupported()
  if (engine === 'rspamd') return [MAILX_RSPAMC, direction === 'spam' ? 'learn_spam' : 'learn_ham', folder]
  return engine === 'spamassassin' ? [MAILX_SA_LEARN, direction === 'spam' ? '--spam' : '--ham', folder] : unsupported()
}
/** Host job policy for training: exactly one reviewed learn step on one mailbox folder. */
export function isMailxLearnJobCommand(argv: readonly unknown[]): boolean {
  if (!strings(argv) || argv.length !== 3) return false
  const engine = argv[0] === MAILX_RSPAMC ? 'rspamd' : argv[0] === MAILX_SA_LEARN ? 'spamassassin' : null
  const direction = ['learn_spam', '--spam'].includes(argv[1]!) ? 'spam' : ['learn_ham', '--ham'].includes(argv[1]!) ? 'ham' : null
  const rebuilt = engine && direction ? attempt(() => mailxLearnArgv(engine, direction, argv[2]!)) : null
  return !!rebuilt && same(argv, rebuilt)
}
