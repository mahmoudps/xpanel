import { statfs, lstat, readdir } from 'node:fs/promises'
import { fail, HOME_ROOT_RE, isAccountHome, msgid } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { HostJobCommandStep, HostJobPlan, HostJobVerification, HostJobView } from './host-job-contract.ts'

export const HOME_MOVE_KIND = 'account.rearrange'
const STEP_TIMEOUT_MS = 3_600_000
export const HOME_MOVE_COMMANDS = { copy: '/usr/bin/cp', compare: '/usr/bin/diff', rename: '/usr/bin/mv', restoreContext: '/usr/sbin/restorecon', fileContext: '/usr/sbin/semanage' } as const

export interface HomeRoot { path: string; availableKb: number | null; filesystem: string | null }
export interface HomeMoveHost {
  /** Device id of a path, or null when it does not exist. */
  device: (path: string) => Promise<bigint | null>
  freeKb: (path: string) => Promise<number | null>
  usedKb: (path: string) => Promise<number | null>
  listRoots: () => Promise<string[]>
}

/** /home and every /homeN directory on the host: cPanel's "additional home directories" without a second setting to keep true. */
export const readHomeRoots = async (host: Pick<HomeMoveHost, 'freeKb' | 'listRoots' | 'device'>): Promise<HomeRoot[]> => {
  const roots: HomeRoot[] = []
  for (const path of (await host.listRoots()).filter(item => HOME_ROOT_RE.test(item)).sort()) {
    const device = await host.device(path)
    roots.push({ path, availableKb: await host.freeKb(path), filesystem: device === null ? null : String(device) })
  }
  return roots
}

/** Bytes of a tree without following links; a tree above the bound reads as unknown, so the move refuses rather than guesses. */
async function treeKb(path: string, limit = 2_000_000): Promise<number | null> {
  const queue = [path]
  let bytes = 0, seen = 0
  try {
    while (queue.length) {
      const directory = queue.pop()!
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++seen > limit) return null
        const child = directory + '/' + entry.name
        if (entry.isDirectory()) queue.push(child)
        bytes += (await lstat(child)).blocks * 512
      }
    }
    return Math.ceil(bytes / 1024)
  } catch { return null }
}

export const nativeHomeMoveHost = (): HomeMoveHost => ({
  device: async path => { try { return (await lstat(path, { bigint: true })).dev } catch { return null } },
  freeKb: async path => { try { const fs = await statfs(path); return Math.floor(fs.bavail * fs.bsize / 1024) } catch { return null } },
  usedKb: treeKb,
  listRoots: async () => { const names = await readdir('/'); const roots: string[] = []; for (const name of names) { const path = '/' + name; if (HOME_ROOT_RE.test(path) && (await lstat(path).catch(() => null))?.isDirectory()) roots.push(path) } return roots },
})

export interface HomeMoveTarget { from: string; to: string; staging: string; sameFilesystem: boolean }

/** Everything the host must prove before the account stops. Refusals change nothing. */
export async function planHomeMove(account: Pick<Account, 'username' | 'home'>, root: string, host: HomeMoveHost): Promise<HomeMoveTarget> {
  const refuse = (reason: string, message: string): never => fail('PRECONDITION_FAILED', message, { stateChanged: false, reason })
  if (!HOME_ROOT_RE.test(root) || !(await host.listRoots()).includes(root)) return fail('VALIDATION', 'the destination is not a home root of this server', { stateChanged: false, reason: 'invalid_home_root' })
  const to = root + '/' + account.username, from = account.home, staging = `${root}/.xpanel-move-${account.username}`
  if (!isAccountHome(from, account.username)) return refuse('account_busy', 'the account home is not the expected directory')
  if (to === from) return refuse('home_unchanged', 'the account already lives here')
  const [fromDevice, rootDevice] = [await host.device(from), await host.device(root)]
  if (fromDevice === null || rootDevice === null) return refuse('home_missing', 'the account home could not be read')
  if (await host.device(to) !== null || await host.device(staging) !== null) return refuse('home_exists', 'the destination already holds this username')
  const sameFilesystem = fromDevice === rootDevice
  if (!sameFilesystem) {
    const [used, free] = [await host.usedKb(from), await host.freeKb(root)]
    if (used === null || free === null) return refuse('home_space', 'the free space of the destination could not be measured')
    // Room for the copy and for what a filesystem needs to stay usable.
    if (free < used + Math.ceil(used / 10)) return refuse('home_space', 'the destination does not have enough free space')
  }
  return { from, to, staging, sameFilesystem }
}

const step = (id: string, title: string, argv: string[]): HostJobCommandStep => ({ id, title, argv, timeoutMs: STEP_TIMEOUT_MS, mutates: true, env: { LC_ALL: 'C' } })

/** The same filesystem is a rename; another one is a copy that must compare equal before it takes the new name. */
export const homeMoveSteps = (target: HomeMoveTarget): HostJobCommandStep[] => target.sameFilesystem
  ? [step('move', msgid('Rename the home directory'), [HOME_MOVE_COMMANDS.rename, '-T', '--', target.from, target.to])]
  : [step('copy', msgid('Copy the home directory'), [HOME_MOVE_COMMANDS.copy, '-a', '--', target.from, target.staging]),
    step('compare', msgid('Compare every file'), [HOME_MOVE_COMMANDS.compare, '-r', '--no-dereference', '--', target.from, target.staging]),
    step('publish', msgid('Give the copy its name'), [HOME_MOVE_COMMANDS.rename, '-T', '--', target.staging, target.to])]

export interface HomeMoveEffects {
  /** State change plus host reconcile: the account takes its new home. */
  finish: () => Promise<void>
  /** State change plus host reconcile: the account returns as it was. */
  cancel: () => Promise<void>
  /** Removes a directory the move no longer needs; only after the new home serves. */
  remove: (path: string) => Promise<void>
  /** Panel-written paths inside account files, such as Directory Privacy password files. */
  rewritePaths: (from: string, to: string) => Promise<void>
}

/** The host job of Rearrange an Account. The old home goes only after the new one served a clean reconcile. */
export function createHomeMovePlan(account: Pick<Account, 'id' | 'username'>, target: HomeMoveTarget, effects: HomeMoveEffects, assertAuthority: () => Promise<void>, selinux = false): HostJobPlan {
  const steps = homeMoveSteps(target), rootPath = target.to.slice(0, target.to.lastIndexOf('/'))
  // A new root takes the /home file contexts; a rule that already exists is not a failure.
  const labels = selinux ? [step('context-rule', msgid('Label the home root'), [HOME_MOVE_COMMANDS.fileContext, 'fcontext', '-a', '-e', '/home', rootPath]), step('context', msgid('Label the home directory'), [HOME_MOVE_COMMANDS.restoreContext, '-R', '--', target.to])] : []
  const allowed = new Set([...steps, ...labels].map(item => JSON.stringify(item.argv)))
  const verified = (ok: boolean, detail: Record<string, unknown>): HostJobVerification => ({ ok, detail })
  return {
    kind: HOME_MOVE_KIND, summary: `Move ${account.username} to ${target.to}`, accountId: account.id,
    fingerprint: { account: account.id, to: target.to }, detail: { from: target.from, to: target.to, sameFilesystem: target.sameFilesystem },
    steps, policy: argv => allowed.has(JSON.stringify(argv)), beforeStep: assertAuthority,
    finalize: async (run, results) => {
      const done = results.length === steps.length && results.every(row => row.result?.ok && !row.result.timedOut && row.result.code === 0)
      if (!done) {
        try { await effects.remove(target.staging) } catch { return verified(false, { stage: 'cleanup', staging: target.staging }) }
        // A rename that did not finish leaves the home in place; nothing else ran.
        try { await effects.cancel() } catch { return verified(false, { stage: 'cancel' }) }
        return verified(false, { stage: 'moved', moved: false })
      }
      // A stale password path fails closed in the site; it must not strand the account, so the job reports it after the move.
      let privacy = true
      try {
        for (const item of labels) { const labelled = await run(item); if (item.id === 'context' && !labelled.ok) throw new Error('label') }
        await effects.rewritePaths(target.from, target.to).catch(() => { privacy = false })
        await effects.finish()
      } catch { return verified(false, { stage: 'finish', home: target.to, previous: target.sameFilesystem ? null : target.from }) }
      if (!target.sameFilesystem) {
        try { await effects.remove(target.from) } catch { return verified(false, { stage: 'remove-old', previous: target.from }) }
      }
      return privacy ? verified(true, { home: target.to }) : verified(false, { stage: 'directory-privacy', home: target.to })
    },
  }
}

/**
 * A move whose job died with the agent never ran its finalizer. What is on disk decides: a published directory was
 * compared before it took its name, so the account finishes the move; anything less goes back.
 */
export async function recoverHomeMove(account: Pick<Account, 'username' | 'home'> & { homeMove?: { to: string } }, host: Pick<HomeMoveHost, 'device'>, effects: Pick<HomeMoveEffects, 'finish' | 'cancel' | 'remove' | 'rewritePaths'>): Promise<'finished' | 'cancelled'> {
  const to = account.homeMove?.to ?? fail('PRECONDITION_FAILED', 'the account is not moving', { stateChanged: false, reason: 'not_moving' })
  const staging = `${to.slice(0, to.lastIndexOf('/'))}/.xpanel-move-${account.username}`
  if (await host.device(to) === null) { await effects.remove(staging); await effects.cancel(); return 'cancelled' }
  await effects.rewritePaths(account.home, to).catch(() => undefined)
  await effects.finish()
  if (await host.device(account.home) !== null) await effects.remove(account.home)
  return 'finished'
}

export interface HomeMoveRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Null without a Linux host; the routes then refuse instead of pretending. */
  host: HomeMoveHost | null
  getAccount: (username: string) => Promise<Account | null>
  /** Stops the account (state plus host reconcile); on failure the account is back as it was. */
  begin: (account: Account, to: string, actor: string) => Promise<void>
  effects: (account: Account, target: HomeMoveTarget, actor: string) => HomeMoveEffects
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  /** Queued or running moves, for the recovery of one that died. */
  activeJobs: () => Promise<HostJobView[]>
  selinux: boolean
}

/** GET /host/home-roots reads the roots. POST /host/accounts/<user>/rearrange stops the account and queues the move. */
export async function handleHomeMoveRoute(req: Request, url: URL, method: string, ctx: HomeMoveRouteContext): Promise<Response | null> {
  const match = /^\/host\/accounts\/([a-z][a-z0-9]{0,15})\/rearrange$/.exec(url.pathname)
  if (url.pathname !== '/host/home-roots' && !match) return null
  const { actor } = await ctx.assertRoot('account.rearrange')
  if (!ctx.host) return fail('PRECONDITION_FAILED', 'home roots are read from a Linux host', { stateChanged: false, reason: 'host_unavailable' })
  if (!match) { if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } }); return Response.json({ roots: await readHomeRoots(ctx.host) }) }
  if (method === 'DELETE') {
    const account = await ctx.getAccount(match[1]!) ?? fail('NOT_FOUND', 'account not found', { stateChanged: false })
    if ((await ctx.activeJobs()).some(job => job.accountId === account.id)) return fail('CONFLICT', 'the move is still running', { stateChanged: false, reason: 'move_running' })
    const target = { from: account.home, to: account.homeMove?.to ?? '', staging: '', sameFilesystem: false }
    return Response.json({ outcome: await recoverHomeMove(account, ctx.host, ctx.effects(account, target, actor)) })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable', { stateChanged: false, reason: 'host_unavailable' })
  const raw = await req.text()
  let body: unknown
  try { body = raw.length <= 256 ? JSON.parse(raw) : null } catch { body = null }
  const rootPath = (body as { root?: unknown } | null)?.root
  if (typeof rootPath !== 'string') return fail('VALIDATION', 'root is required', { stateChanged: false })
  const account = await ctx.getAccount(match[1]!) ?? fail('NOT_FOUND', 'account not found', { stateChanged: false })
  const target = await planHomeMove(account, rootPath, ctx.host)
  await ctx.begin(account, target.to, actor)
  const job = await ctx.submitJob(createHomeMovePlan(account, target, ctx.effects(account, target, actor), async () => { await ctx.assertRoot('account.rearrange') }, ctx.selinux), actor)
  return Response.json({ job: { id: job.id, referenceCode: job.referenceCode }, home: target.to, sameFilesystem: target.sameFilesystem })
}
