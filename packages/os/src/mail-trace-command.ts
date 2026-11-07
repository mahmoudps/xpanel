/** dig(1): +adflag requests validation, +noall +comments keeps only the header; the domain is a checked host name, so it can never read as an option. */
const DIG = '/usr/bin/dig'
const FIXED = ['+time=3', '+tries=1', '+adflag', '+noall', '+comments', 'MX'] as const
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export function mailTraceDigArgv(domain: string): string[] {
  if (!HOST.test(domain)) throw new Error('unsupported_mail_trace_command')
  return [DIG, ...FIXED, domain]
}
export const isMailTraceCommand = (argv: readonly unknown[]): boolean =>
  Array.isArray(argv) && argv.length === FIXED.length + 2 && argv[0] === DIG && FIXED.every((value, index) => argv[index + 1] === value) && typeof argv[argv.length - 1] === 'string' && HOST.test(argv[argv.length - 1] as string)
