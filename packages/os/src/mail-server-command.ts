/** Reviewed Postfix/Dovecot configuration reads. Fixed argv only: never `-c`, `-e`, `-x`, `doveconf -n/-a/-P` (which can print secrets). */
export const POSTCONF = '/usr/sbin/postconf'
export const DOVECONF = '/usr/bin/doveconf'
// postconf(1) -n: only parameters with an explicit name=value setting in main.cf; -M: master.cf service entries.
export const POSTCONF_MAIN_ARGV = [POSTCONF, '-n'] as const
export const POSTCONF_MASTER_ARGV = [POSTCONF, '-M'] as const
/** doveconf(1) -h prints only the value of the named setting; none of these settings holds a secret. */
export const DOVECOT_OBSERVED_SETTINGS = ['protocols', 'listen', 'ssl', 'ssl_min_protocol', 'mail_location', 'auth_mechanisms'] as const
export type DovecotObservedSetting = typeof DOVECOT_OBSERVED_SETTINGS[number]
export const doveconfSettingArgv = (setting: DovecotObservedSetting): string[] => {
  if (!(DOVECOT_OBSERVED_SETTINGS as readonly string[]).includes(setting)) throw new Error('unsupported_doveconf_setting')
  return [DOVECONF, '-h', setting]
}

/** main.cf parameters shown per page. Password maps, credentials and lookup-table contents are never listed. */
export const MAIL_SERVER_PAGE_KEYS = {
  server: ['myhostname', 'mydomain', 'myorigin', 'inet_interfaces', 'inet_protocols', 'mynetworks', 'compatibility_level', 'smtpd_banner',
    'smtpd_tls_security_level', 'smtpd_tls_auth_only', 'smtpd_tls_cert_file', 'smtpd_tls_protocols', 'smtpd_tls_mandatory_protocols', 'smtp_tls_security_level',
    'smtpd_sasl_auth_enable', 'smtpd_sasl_type', 'smtpd_sasl_path', 'smtpd_sender_login_maps', 'smtpd_relay_restrictions', 'smtpd_recipient_restrictions',
    'smtpd_sender_restrictions', 'smtpd_client_restrictions', 'smtpd_helo_required', 'smtpd_milters', 'non_smtpd_milters', 'milter_protocol', 'milter_default_action',
    'recipient_delimiter', 'mailbox_size_limit'],
  routing: ['relayhost', 'mydestination', 'relay_domains', 'virtual_mailbox_domains', 'virtual_mailbox_maps', 'virtual_alias_domains', 'virtual_alias_maps',
    'virtual_transport', 'transport_maps', 'default_transport', 'relay_transport', 'local_transport', 'alias_maps', 'sender_dependent_relayhost_maps',
    'sender_dependent_default_transport_maps'],
  outbound: ['message_size_limit', 'smtpd_recipient_limit', 'smtpd_client_message_rate_limit', 'smtpd_client_recipient_rate_limit', 'smtpd_client_connection_rate_limit',
    'smtpd_client_connection_count_limit', 'smtpd_client_event_limit_exceptions', 'anvil_rate_time_unit', 'default_destination_concurrency_limit',
    'default_destination_recipient_limit', 'default_destination_rate_delay', 'smtp_destination_concurrency_limit', 'default_process_limit'],
} as const satisfies Record<string, readonly string[]>
export type MailServerPage = keyof typeof MAIL_SERVER_PAGE_KEYS
export const MAIL_SERVER_PAGES = Object.keys(MAIL_SERVER_PAGE_KEYS) as MailServerPage[]
export const POSTFIX_OBSERVED_KEYS: readonly string[] = [...new Set(Object.values(MAIL_SERVER_PAGE_KEYS).flat())]
/** master.cf `-o` overrides shown for inet services; any other override is only counted. */
export const MASTER_OBSERVED_OPTIONS: readonly string[] = ['syslog_name', 'smtpd_tls_security_level', 'smtpd_tls_wrappermode', 'smtpd_tls_auth_only', 'smtpd_sasl_auth_enable',
  'smtpd_sasl_type', 'smtpd_sasl_path', 'smtpd_sender_login_maps', 'smtpd_sender_restrictions', 'smtpd_relay_restrictions', 'smtpd_client_restrictions',
  'smtpd_recipient_restrictions', 'smtpd_reject_unlisted_recipient', 'milter_macro_daemon_name']

export function isMailServerCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  if (argv.length === 2) return argv[0] === POSTCONF && (argv[1] === '-n' || argv[1] === '-M')
  return argv.length === 3 && argv[0] === DOVECONF && argv[1] === '-h' && (DOVECOT_OBSERVED_SETTINGS as readonly unknown[]).includes(argv[2])
}
