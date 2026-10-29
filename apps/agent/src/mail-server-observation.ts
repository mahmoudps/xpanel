import { fail } from '@xpanel/core'
import { DOVECOT_OBSERVED_SETTINGS, DOVECOT_PATH_SETTINGS, MASTER_OBSERVED_OPTIONS, isDovecotFileReference, POSTCONF_MAIN_ARGV, POSTCONF_MASTER_ARGV, POSTFIX_OBSERVED_KEYS, doveconfSettingArgv } from '../../../packages/os/src/mail-server-command.ts'

export interface MailServerCommandResult { ok: boolean; code: number; stdout: string; stderr: string }
export type MailServerRun = (argv: string[]) => Promise<MailServerCommandResult>
export type MailServerReadReason = 'command_failed' | 'output_limit' | 'malformed_output'
/** One master.cf inet service: `fields` is the type and the six fixed columns; only allowlisted `-o` overrides are kept. */
export interface MasterService { service: string; fields: string; options: Record<string, string>; otherOptions: number }
type Section<T> = { state: 'read' | 'unavailable'; reason?: MailServerReadReason } & T
export interface MailServerObservation {
  observedAt: string
  postfix: Section<{ settings: Record<string, string> }>
  master: Section<{ services: MasterService[] }>
  dovecot: Section<{ settings: Record<string, string | null> }>
}

const MAX_OUTPUT_BYTES = 1024 * 1024
export const MAIL_SERVER_MAX_VALUE = 4096
export const MAIL_SERVER_MAX_SERVICES = 64
const MAX_DOVECOT_VALUE = 1024
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const PARAMETER = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}) =(?: (.*))?$/
const TYPES = ['inet', 'unix', 'unix-dgram', 'fifo', 'pass']
export const isMailServerText = (value: unknown, max = MAIL_SERVER_MAX_VALUE): value is string => typeof value === 'string' && value.length <= max && !CONTROL.test(value)
class Malformed extends Error {}
const malformed = (): never => { throw new Malformed() }

/** postconf(5)/master(5): a logical line starts with non-whitespace text; a line that starts with whitespace continues it. */
function logicalLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    if (/^[ \t]/.test(raw)) { if (!lines.length) return malformed(); lines[lines.length - 1] += ' ' + raw.trim() } else lines.push(raw.trimEnd())
  }
  if (lines.some(line => CONTROL.test(line))) return malformed()
  return lines
}

/** postconf(1) -n prints `name = value` (or `name =` for an empty value) per parameter; also parses rendered main.cf fragments. */
export function parsePostconfMain(text: string): Map<string, string> {
  const settings = new Map<string, string>()
  for (const line of logicalLines(text)) {
    const match = PARAMETER.exec(line)
    if (!match || settings.has(match[1]!)) return malformed()
    settings.set(match[1]!, (match[2] ?? '').trim())
  }
  return settings
}

/** postconf(1) -M prints one master.cf entry per line: service type private unpriv chroot wakeup maxproc command [args]. Only inet services are returned. */
export function parsePostconfMaster(text: string): MasterService[] {
  const services: MasterService[] = [], seen = new Set<string>()
  for (const line of logicalLines(text)) {
    const [service = '', type = '', priv = '', unpriv = '', chroot = '', wakeup = '', maxproc = '', command = '', ...args] = line.split(/\s+/)
    if (!/^[A-Za-z0-9_.:[\]/-]{1,128}$/.test(service) || !TYPES.includes(type) || ![priv, unpriv, chroot].every(flag => /^[yn-]$/.test(flag))
      || !/^(?:-|\d{1,9}\??)$/.test(wakeup) || !/^(?:-|\d{1,9})$/.test(maxproc) || !/^[A-Za-z0-9_./-]{1,128}$/.test(command) || seen.has(service + ' ' + type)) return malformed()
    seen.add(service + ' ' + type)
    if (type !== 'inet') continue
    const options: Record<string, string> = {}
    let otherOptions = 0
    for (let index = 0; index < args.length; index++) {
      if (args[index] !== '-o') continue
      let spec = args[++index] ?? malformed()
      // master(5), Postfix >= 3.0: `-o { name = value }` may carry whitespace inside the braces.
      if (spec.startsWith('{')) {
        const parts = [spec]
        while (!parts[parts.length - 1]!.endsWith('}')) parts.push(args[++index] ?? malformed())
        spec = parts.join(' ').slice(1, -1).trim()
      }
      const equals = spec.indexOf('='), name = spec.slice(0, equals).trim(), value = spec.slice(equals + 1).trim()
      if (equals < 1 || !NAME.test(name)) return malformed()
      if (!MASTER_OBSERVED_OPTIONS.includes(name)) { otherOptions += 1; continue }
      if (value.length > MAIL_SERVER_MAX_VALUE) return malformed()
      options[name] = value
    }
    services.push({ service, fields: [type, priv, unpriv, chroot, wakeup, maxproc, command].join(' '), options, otherOptions })
  }
  if (services.length > MAIL_SERVER_MAX_SERVICES) return malformed()
  return services
}

const allowlisted = (all: Map<string, string>): Record<string, string> => {
  const settings: Record<string, string> = {}
  for (const key of POSTFIX_OBSERVED_KEYS) {
    const value = all.get(key)
    if (value === undefined) continue
    if (value.length > MAIL_SERVER_MAX_VALUE) return malformed()
    settings[key] = value
  }
  return settings
}

/** Reads main.cf, master.cf and allowlisted Dovecot settings; every value is observed host output, never a default or a guess. */
export async function readMailServerObservation(input: { run: MailServerRun; now?: () => Date }): Promise<MailServerObservation> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const stdout = async (argv: string[]): Promise<string | null> => {
    try { const result = await input.run(argv); return result && result.ok && result.code === 0 && typeof result.stdout === 'string' ? result.stdout : null } catch { return null }
  }
  const section = async <T extends object>(argv: readonly string[], parse: (text: string) => T, empty: T): Promise<Section<T>> => {
    const text = await stdout([...argv])
    if (text === null) return { state: 'unavailable', reason: 'command_failed', ...empty }
    if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) return { state: 'unavailable', reason: 'output_limit', ...empty }
    try { return { state: 'read', ...parse(text) } } catch (error) { if (error instanceof Malformed) return { state: 'unavailable', reason: 'malformed_output', ...empty }; throw error }
  }
  const postfix = await section(POSTCONF_MAIN_ARGV, text => ({ settings: allowlisted(parsePostconfMain(text)) }), { settings: {} })
  const master = await section(POSTCONF_MASTER_ARGV, text => ({ services: parsePostconfMaster(text) }), { services: [] })
  const settings: Record<string, string | null> = {}
  for (const name of DOVECOT_OBSERVED_SETTINGS) {
    // doveconf(1) -h prints the bare value followed by a newline; an unknown setting (e.g. mail_location on Dovecot 2.4) exits non-zero.
    const value = (await stdout(doveconfSettingArgv(name)))?.replace(/\n$/, '') ?? null
    settings[name] = value !== null && value.length <= MAX_DOVECOT_VALUE && !CONTROL.test(value) && (!DOVECOT_PATH_SETTINGS.includes(name) || value === '' || isDovecotFileReference(value)) ? value : null
  }
  const dovecot: MailServerObservation['dovecot'] = Object.values(settings).some(value => value !== null) ? { state: 'read', settings } : { state: 'unavailable', reason: 'command_failed', settings }
  return { observedAt, postfix, master, dovecot }
}

export interface MailServerObservationRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Null when this agent is not running with the native Linux host executor. */
  run: MailServerRun | null
  now?: () => Date
}

/** Root-only, read-only. No selector, path or setting name from the caller reaches a command. */
export async function handleMailServerObservationRoute(_req: Request, url: URL, method: string, ctx: MailServerObservationRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/mail/server') return null
  await ctx.assertRoot('mail.server.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'mail server observation does not accept selectors', { stateChanged: false })
  if (!ctx.run) return fail('PRECONDITION_FAILED', 'mail server observation requires the native Linux host executor', { stateChanged: false })
  const body = await readMailServerObservation({ run: ctx.run, ...(ctx.now ? { now: ctx.now } : {}) })
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
