import { lstat } from 'node:fs/promises'
import { system } from '@xpanel/render'
import { SEC_NFT_LIST_ARGV } from '../../../packages/os/src/sec-host-command.ts'

export type LstatMode = (path: string) => Promise<{ regular: boolean; mode: number; uid: number } | null>
const lstatMode: LstatMode = path => lstat(path).then(facts => ({ regular: facts.isFile(), mode: facts.mode & 0o7777, uid: facts.uid }), error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error))

export interface TracerouteObservation { observedAt: string; state: 'unmanaged' | 'not_installed' | 'applied' | 'drift'; allowed: boolean | null; binaries: { path: string; mode: number }[] }
/** Modes of the real files; a mode that differs from the saved choice is drift, including a change made by hand or a package update. */
export async function observeTraceroute(input: { allowed: boolean | null; stat?: LstatMode; now?: () => Date }): Promise<TracerouteObservation> {
  const stat = input.stat ?? lstatMode, binaries: TracerouteObservation['binaries'] = []
  for (const path of system.TRACEROUTE_BINARIES) { const facts = await stat(path).catch(() => null); if (facts?.regular) binaries.push({ path, mode: facts.mode }) }
  const expected = input.allowed === null ? null : input.allowed ? system.TRACEROUTE_MODE_ALLOWED : system.TRACEROUTE_MODE_BLOCKED
  const state = !binaries.length ? 'not_installed' : expected === null ? 'unmanaged' : binaries.every(item => (item.mode & 0o777) === expected) ? 'applied' : 'drift'
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), state, allowed: input.allowed, binaries }
}

export interface SmtpRestrictionObservation { observedAt: string; state: 'read' | 'not_installed' | 'unavailable'; enabled: boolean; active: boolean | null; application: 'applied' | 'drift' | 'unavailable' }
/** The kernel ruleset carries the rule, or it does not; the saved switch alone proves nothing. */
export function nftHasSmtpRule(stdout: string): boolean | null {
  try {
    const doc = JSON.parse(stdout) as { nftables?: unknown }
    if (!Array.isArray(doc.nftables)) return null
    return doc.nftables.some(item => (item as { rule?: { comment?: unknown } })?.rule?.comment === system.SMTP_RESTRICTION_COMMENT)
  } catch { return null }
}
export async function observeSmtpRestriction(input: { enabled: boolean; run: (argv: string[]) => Promise<{ ok: boolean; code: number; stdout: string }>; present: (path: string, kind: 'file' | 'directory') => Promise<boolean | null>; now?: () => Date }): Promise<SmtpRestrictionObservation> {
  const observedAt = (input.now?.() ?? new Date()).toISOString(), base = { observedAt, enabled: input.enabled }
  if (await input.present(SEC_NFT_LIST_ARGV[0], 'file') === false) return { ...base, state: 'not_installed', active: null, application: 'unavailable' }
  const listing = await input.run([...SEC_NFT_LIST_ARGV]).catch(() => null)
  const active = listing?.ok ? nftHasSmtpRule(listing.stdout) : null
  if (active === null) return { ...base, state: 'unavailable', active: null, application: 'unavailable' }
  return { ...base, state: 'read', active, application: active === input.enabled ? 'applied' : 'drift' }
}

export interface ForkBombObservation { observedAt: string; enabled: boolean; expectedUsers: number; limitedUsers: number; pam: boolean | null; limits: typeof system.FORK_BOMB_LIMITS; application: 'applied' | 'drift' | 'pam_missing' }
const PAM_FILES: readonly string[] = ['/etc/pam.d/sshd', '/etc/pam.d/password-auth', '/etc/pam.d/common-session']
const pamLoadsLimits = (text: string): boolean => text.split('\n').some(line => /^\s*session\s+\S+\s+pam_limits\.so\b/.test(line))
/** pam_limits must be in the SSH session stack (directly on Debian, through password-auth on EL) or the limits file does nothing. */
export async function observeForkBomb(input: { enabled: boolean; users: readonly string[]; readText: (path: string) => Promise<string | null>; now?: () => Date }): Promise<ForkBombObservation> {
  const file = await input.readText(system.FORK_BOMB_LIMITS_FILE)
  const limited = new Set((file ?? '').split('\n').flatMap(line => /^([a-z][a-z0-9]{0,15}) - nproc \d+$/.exec(line)?.[1] ?? []))
  const texts = await Promise.all(PAM_FILES.map(path => input.readText(path)))
  // sshd ignores the PAM session stack when UsePAM is off.
  const sshd = await input.readText('/etc/ssh/sshd_config')
  const pam = sshd !== null && /^\s*UsePAM\s+no\b/im.test(sshd) ? false : texts.every(text => text === null) ? null : texts.some(text => text !== null && pamLoadsLimits(text))
  const matches = input.enabled ? input.users.length === limited.size && input.users.every(user => limited.has(user)) : limited.size === 0
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), enabled: input.enabled, expectedUsers: input.users.length, limitedUsers: limited.size, pam, limits: system.FORK_BOMB_LIMITS,
    application: !matches ? 'drift' : input.enabled && pam !== true ? 'pam_missing' : 'applied' }
}
