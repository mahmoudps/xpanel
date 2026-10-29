import { isIP } from 'node:net'
import { fail } from '@xpanel/core'
import type { ConfigTestResult } from './executor.ts'
import { FAIL2BAN_CLIENT, FAIL2BAN_STATUS_ARGV, fail2banJailStatusArgv, fail2banUnbanArgv, isFail2banAddress, isFail2banJail } from '../../../packages/os/src/security-tools-command.ts'

export type SecurityToolsRun = (argv: string[]) => Promise<ConfigTestResult>
/** true/false from a fixed-path stat; null when existence could not be determined. */
export type BinaryPresent = (path: string) => Promise<boolean | null>
export interface Fail2banJailView {
  name: string
  state: 'read' | 'unavailable'
  currentlyFailed: number | null
  totalFailed: number | null
  currentlyBanned: number | null
  totalBanned: number | null
  banned: string[]
  truncated: boolean
}
export interface IntrusionRead {
  state: 'read' | 'not_installed' | 'unavailable'
  observedAt: string
  reason?: 'command_failed' | 'malformed_output'
  jails: Fail2banJailView[]
  /** Jails whose names fall outside the reviewed grammar are counted, never queried. */
  unsupportedJails: number
  jailsTruncated: boolean
}
export interface UnbanResult {
  jail: string
  address: string
  outcome: 'confirmed' | 'unknown'
  verificationRequired: boolean
  after: { banned: boolean | null }
  observedAt: string
}

export const INTRUSION_BANNED_LIMIT = 5000
export const INTRUSION_JAIL_LIMIT = 64
const COUNT = /^(?:0|[1-9][0-9]{0,15})$/
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const count = (value: string | undefined): number | null => value !== undefined && COUNT.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
// fail2ban bans single addresses; subnet entries (some ban actions) are shown but never unbanned here.
const bannedEntry = (value: string): boolean => {
  if (isFail2banAddress(value)) return true
  const match = /^([0-9A-Fa-f:.]{2,45})\/([0-9]{1,3})$/.exec(value)
  const family = match ? isIP(match[1]!) : 0
  return family !== 0 && Number(match![2]) <= (family === 4 ? 32 : 128)
}

/** fail2ban-client prints status as a tree (fail2ban client/beautifier.py): "|- Key:\tValue" and "`- Key:\tValue". */
function treeFields(stdout: string): { head: string; values: Map<string, string> } | null {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 2 * 1024 * 1024) return null
  const lines = stdout.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim() !== '')
  const values = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const match = /^[ |`-]*[|`]- ([A-Za-z][A-Za-z ]{0,40}):\t(.*)$/.exec(line)
    if (!match) continue
    if (values.has(match[1]!)) return null
    values.set(match[1]!, match[2]!.trim())
  }
  return { head: lines[0]?.trim() ?? '', values }
}

export function parseFail2banStatus(stdout: string): { jails: string[] } | null {
  const tree = treeFields(stdout)
  if (!tree || tree.head !== 'Status') return null
  const total = count(tree.values.get('Number of jail')), list = tree.values.get('Jail list')
  if (total === null || list === undefined) return null
  const jails = list === '' ? [] : list.split(/,\s*/)
  if (jails.length !== total || jails.some(name => !name || name.length > 256 || UNSAFE.test(name))) return null
  return { jails }
}

export function parseFail2banJail(stdout: string, jail: string, limit = INTRUSION_BANNED_LIMIT): Fail2banJailView | null {
  const tree = treeFields(stdout)
  if (!tree || tree.head !== 'Status for the jail: ' + jail) return null
  const value = (key: string): number | null => count(tree.values.get(key))
  const currentlyFailed = value('Currently failed'), totalFailed = value('Total failed'), currentlyBanned = value('Currently banned'), totalBanned = value('Total banned')
  const list = tree.values.get('Banned IP list')
  if (currentlyFailed === null || totalFailed === null || currentlyBanned === null || totalBanned === null || list === undefined) return null
  const entries = list.split(' ').filter(Boolean)
  if (!entries.every(bannedEntry)) return null
  return { name: jail, state: 'read', currentlyFailed, totalFailed, currentlyBanned, totalBanned, banned: entries.slice(0, Math.max(0, limit)), truncated: entries.length > limit }
}

const unavailableJail = (name: string): Fail2banJailView => ({ name, state: 'unavailable', currentlyFailed: null, totalFailed: null, currentlyBanned: null, totalBanned: null, banned: [], truncated: false })
const attempt = (run: SecurityToolsRun, argv: string[]): Promise<ConfigTestResult | null> => run(argv).then(result => result?.ok && result.code === 0 && typeof result.stdout === 'string' ? result : null, () => null)

export async function readIntrusion(input: { run: SecurityToolsRun; present: BinaryPresent; now?: () => Date }): Promise<IntrusionRead> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const empty = { observedAt, jails: [], unsupportedJails: 0, jailsTruncated: false }
  if (await input.present(FAIL2BAN_CLIENT).catch(() => null) === false) return { state: 'not_installed', ...empty }
  const status = await attempt(input.run, [...FAIL2BAN_STATUS_ARGV])
  if (!status) return { state: 'unavailable', reason: 'command_failed', ...empty }
  const parsed = parseFail2banStatus(status.stdout)
  if (!parsed) return { state: 'unavailable', reason: 'malformed_output', ...empty }
  const supported = parsed.jails.filter(isFail2banJail)
  const jails: Fail2banJailView[] = []
  let budget = INTRUSION_BANNED_LIMIT
  for (const name of supported.slice(0, INTRUSION_JAIL_LIMIT)) {
    const result = await attempt(input.run, fail2banJailStatusArgv(name))
    const view = result ? parseFail2banJail(result.stdout, name, budget) : null
    jails.push(view ?? unavailableJail(name))
    budget -= view?.banned.length ?? 0
  }
  return { state: 'read', observedAt, jails, unsupportedJails: parsed.jails.length - supported.length, jailsTruncated: supported.length > INTRUSION_JAIL_LIMIT }
}

/** Unbans one address in one jail only after a fresh read shows it banned there; a re-read alone proves the effect. */
export async function unbanAddress(input: { run: SecurityToolsRun; jail: unknown; address: unknown; now?: () => Date; authorize?: () => Promise<void> }): Promise<UnbanResult> {
  const { run, jail, address } = input
  if (!isFail2banJail(jail) || !isFail2banAddress(address)) return fail('VALIDATION', 'a reviewed jail name and one IP address are required', { stateChanged: false })
  const read = async (): Promise<Fail2banJailView | null> => { const result = await attempt(run, fail2banJailStatusArgv(jail)); return result ? parseFail2banJail(result.stdout, jail, Number.POSITIVE_INFINITY) : null }
  const before = await read()
  if (!before) return fail('PRECONDITION_FAILED', 'the jail could not be read before unbanning', { stateChanged: false })
  if (!before.banned.includes(address)) return fail('CONFLICT', 'the address is not banned in this jail; reload before retrying', { stateChanged: false })
  await input.authorize?.()
  const accepted = !!await attempt(run, fail2banUnbanArgv(jail, address))
  const after = await read(), banned = after ? after.banned.includes(address) : null
  if (!accepted && banned === true) return fail('PRECONDITION_FAILED', 'fail2ban did not accept the unban; the address is still banned', { stateChanged: false })
  const outcome = accepted && banned === false ? 'confirmed' : 'unknown'
  return { jail, address, outcome, verificationRequired: outcome === 'unknown', after: { banned }, observedAt: (input.now?.() ?? new Date()).toISOString() }
}
