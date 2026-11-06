import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import { system } from '@xpanel/render'
import { effectiveSecPolicy, SEC_COMPILER_ACCESS_STATE } from './sec-policy.ts'
import type { SecCompilerAccessPolicy } from './sec-policy.ts'

export type CompilerPresent = (path: string, kind: 'file' | 'directory') => Promise<boolean | null>
export type CompilerStat = (path: string) => Promise<{ uid: number; gid: number; mode: number } | null>
const present: CompilerPresent = (path, kind) => stat(path).then(facts => kind === 'file' ? facts.isFile() : facts.isDirectory(), error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null)
const statFollow: CompilerStat = path => stat(path).then(facts => ({ uid: facts.uid, gid: facts.gid, mode: facts.mode & 0o7777 }), error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error))

/** Saved policy, or null when Compiler Access was never saved (the distribution's permissions stay untouched). */
export async function readCompilerAccessPolicy(root: string): Promise<SecCompilerAccessPolicy | null> {
  let text: string
  try { text = await readFile(join(root, SEC_COMPILER_ACCESS_STATE), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', 'saved compiler access is unreadable; review it before reconciliation')
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('PRECONDITION_FAILED', 'saved compiler access is invalid; review it before reconciliation') }
  return effectiveSecPolicy('compiler-access', raw)
}

/** Granted, existing accounts; owner rule 2026-11-06: accounts on a jailed shell stay restricted. */
export function compilerAccessMembers(snapshot: { accounts: readonly Account[]; plans: readonly Plan[] }, policy: SecCompilerAccessPolicy): { members: string[]; excluded: { username: string; reason: 'jailed_shell' }[] } {
  const granted = new Set(policy.accountIds), members: string[] = [], excluded: { username: string; reason: 'jailed_shell' }[] = []
  for (const account of [...snapshot.accounts].sort((left, right) => left.username.localeCompare(right.username))) {
    if (!granted.has(account.id) || account.status === 'terminating') continue
    // A missing plan is treated as jailed so an unknown shell never widens access.
    const planShell = snapshot.plans.find(plan => plan.id === account.planId)?.shell ?? 'jailed'
    if (account.shell === 'jailed' && planShell === 'jailed') excluded.push({ username: account.username, reason: 'jailed_shell' })
    else members.push(account.username)
  }
  return { members, excluded }
}

// What runs each family's hook: dpkg reads its own configuration directory; EL 9 and 10 both ship dnf 4, whose
// post-transaction-actions plugin reads the action directory. Removing the plugin keeps that directory while our
// action is in it, so the plugin's own configuration file is what proves the plugin is installed.
const HOOK_RUNNERS: Readonly<Record<'debian' | 'rhel', readonly (readonly [string, 'file' | 'directory'])[]>> = {
  debian: [['/etc/dpkg/dpkg.cfg.d', 'directory']],
  rhel: [['/etc/dnf/plugins/post-transaction-actions.d', 'directory'], ['/etc/dnf/plugins/post-transaction-actions.conf', 'file']],
}

/** The package-manager hook is installed only where something runs it (EL needs the dnf post-transaction-actions plugin). */
export const compilerAccessHookAvailable = async (family: string, check: CompilerPresent = present): Promise<boolean> => {
  if (family !== 'debian' && family !== 'rhel') return false
  for (const [path, kind] of HOOK_RUNNERS[family]) if (await check(path, kind).catch(() => null) !== true) return false
  return true
}

/** Reconcile input, or null when nothing is managed. */
export async function compilerAccessInput(root: string, family: string, snapshot: { accounts: readonly Account[]; plans: readonly Plan[] }, check: CompilerPresent = present): Promise<system.CompilerAccessInput | null> {
  const policy = await readCompilerAccessPolicy(root)
  if (!policy) return null
  return { restricted: policy.restricted, members: compilerAccessMembers(snapshot, policy).members, packageHook: policy.restricted && await compilerAccessHookAvailable(family, check) }
}

export interface CompilerAccessObservation {
  observedAt: string
  family: string
  policy: SecCompilerAccessPolicy | null
  expected: { members: string[]; excluded: { username: string; reason: 'jailed_shell' }[] } | null
  group: { exists: boolean; gid: number | null; members: string[] }
  commands: { name: string; present: boolean; restricted: boolean | null; mode: number | null }[]
  hook: { mechanism: 'dpkg-post-invoke' | 'dnf-post-transaction-actions' | null; available: boolean; installed: boolean }
  state: 'unmanaged' | 'applied' | 'drift'
}

/** Read-only host facts: the group entry, each compiler command's effective permissions and the hook file. */
export async function observeCompilerAccess(input: {
  root: string; family: string; snapshot: { accounts: readonly Account[]; plans: readonly Plan[] }
  run: (argv: string[]) => Promise<{ ok: boolean; code: number; stdout: string }>
  present?: CompilerPresent; statPath?: CompilerStat; now?: () => Date
}): Promise<CompilerAccessObservation> {
  const check = input.present ?? present, statPath = input.statPath ?? statFollow
  const policy = await readCompilerAccessPolicy(input.root)
  const expected = policy ? compilerAccessMembers(input.snapshot, policy) : null
  // getent(1) group: name:password:GID:member,member; exit 2 means the group does not exist.
  const entry = await input.run(['/usr/bin/getent', 'group', system.COMPILER_GROUP]).catch(() => null)
  const fields = entry?.ok && entry.code === 0 ? entry.stdout.trim().split(':') : null
  const group = fields && fields.length === 4 && fields[0] === system.COMPILER_GROUP && /^[0-9]+$/.test(fields[2]!)
    ? { exists: true, gid: Number(fields[2]), members: fields[3] ? fields[3].split(',').sort() : [] }
    : { exists: false, gid: null, members: [] }
  const commands: CompilerAccessObservation['commands'] = []
  for (const name of system.COMPILER_COMMANDS) {
    const facts = await statPath('/usr/bin/' + name).catch(() => null)
    commands.push({ name, present: facts !== null, mode: facts?.mode ?? null,
      restricted: facts === null ? null : facts.uid === 0 && group.gid !== null && facts.gid === group.gid && (facts.mode & 0o777) === 0o750 })
  }
  const family = input.family === 'debian' || input.family === 'rhel' ? input.family : null
  const hook = { mechanism: family === 'debian' ? 'dpkg-post-invoke' as const : family === 'rhel' ? 'dnf-post-transaction-actions' as const : null,
    available: family ? await compilerAccessHookAvailable(family, check) : false,
    installed: family ? await check(system.COMPILER_ACCESS_HOOKS[family], 'file').catch(() => null) === true : false }
  const found = commands.filter(command => command.present)
  const applied = !policy ? false : policy.restricted
    ? found.every(command => command.restricted) && group.members.join() === expected!.members.join() && hook.installed === hook.available
    : found.every(command => command.restricted === false) && !hook.installed
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), family: input.family, policy, expected, group, commands, hook, state: !policy ? 'unmanaged' : applied ? 'applied' : 'drift' }
}
