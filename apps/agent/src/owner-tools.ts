import { arch, hostname, release } from 'node:os'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, OsProfile, Plan } from '@xpanel/core'
import { system } from '@xpanel/render'
import { isHomeRelativePath, readUnitStates } from './account-runtime.ts'
import type { RuntimeFiles, RuntimeHost } from './account-runtime.ts'
import { accountUnitArgv } from './web-apps.ts'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Owner tools that read the host or run as the account: Server Information, Perl modules (CPAN into ~/perl5)
 * and Images (Thumbnailer, Scaler, Converter). Everything account-written runs in the account's sandbox.
 */
export const OWNER_TOOL_FEATURES = { 'server-information': 'xpanel-server-information', 'perl-modules': 'perl-modules', images: 'images' } as const
export const CPANM_BINARY = '/usr/bin/cpanm'
export const PERL_LIBRARY = 'perl5'
const MODULE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:::[A-Za-z_][A-Za-z0-9_]{0,63}){0,8}$/
const PYTHON = system.RUNTIME_BINARIES.python
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
type ToolAccount = Pick<Account, 'username' | 'uid' | 'gid' | 'home'>

export interface OwnerToolsContext {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  os: OsProfile
  /** null off a Linux host: every tool reports unavailable */
  host: RuntimeHost | null
  files: ((account: Account, plan: Plan) => RuntimeFiles | null) | null
  services: (() => Promise<readonly { id: string; label: string; state: string }[]>) | null
  panelVersion: string | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}

/** Fresh owner, active account and plan feature; used by every route here and by website backups. */
export async function authorizeOwnerTool(ctx: Pick<OwnerToolsContext, 'caller' | 'store' | 'currentPrincipal'>, username: string, feature: string): Promise<{ account: Account; plan: Plan }> {
  const { caller } = ctx
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'this tool requires the signed-in account owner', unchanged)
  const account = await ctx.store.getAccountByUsername(username)
  if (!account || account.id !== caller.accountId || account.status !== 'active') return fail('FORBIDDEN', 'the account does not match the current owner', unchanged)
  const principal = await ctx.currentPrincipal()
  if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'current account owner is required', unchanged)
  const plan = await ctx.store.getPlan(account.planId), features = plan ? await ctx.store.getFeatureList(plan.featureListId) : null
  if (!plan || !features || features.disabled.includes(feature)) return fail('FORBIDDEN', 'the account plan does not allow this', unchanged)
  return { account, plan }
}

// ---------------------------------------------------------------- Server Information

const VERSION_COMMANDS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  nginx: [['/usr/sbin/nginx', '-v']], apache: [['/usr/sbin/apache2', '-v'], ['/usr/sbin/httpd', '-v']], mariadb: [['/usr/bin/mariadb', '--version']],
  postgresql: [['/usr/bin/psql', '--version']], perl: [['/usr/bin/perl', '--version']], python: [[PYTHON, '--version']],
}
const VERSION = /(\d+\.\d+(?:\.\d+)?)/
export const PILLOW_CHECK = [PYTHON, '-I', '-c', 'import PIL'] as const

/** One exact argv per check, so this admission cannot widen into another command. */
export function isOwnerToolCommand(argv: readonly string[]): boolean {
  const same = (known: readonly string[]): boolean => known.length === argv.length && known.every((value, index) => value === argv[index])
  if (Object.values(VERSION_COMMANDS).flat().some(same) || same(PILLOW_CHECK)) return true
  if (argv[1] === undefined) return false
  const perl = /^--unit=xpanel-perl-([a-z][a-z0-9]{0,15})\.service$/.exec(argv[1])
  const uid = argv.find(v => /^User=[0-9]+$/.test(v))?.slice(5), gid = argv.find(v => /^Group=[0-9]+$/.test(v))?.slice(6)
  try {
    if (perl && uid && gid) {
      const module = argv.at(-1)!, action = argv.includes('--uninstall') ? 'uninstall' : argv.includes('--reinstall') ? 'reinstall' : 'install'
      return JSON.stringify(argv) === JSON.stringify(buildPerlCommand({ username: perl[1]!, uid: Number(uid), gid: Number(gid), home: '/home/' + perl[1] }, action, module))
    }
    const user = argv.find(v => /^User=[a-z][a-z0-9]{0,15}$/.test(v))?.slice(5)
    if (argv.includes(IMAGE_SCRIPT) && user) {
      const tail = argv.slice(argv.indexOf(IMAGE_SCRIPT) + 1)
      return JSON.stringify(argv) === JSON.stringify(buildImageCommand({ username: user, uid: imageIdentity(argv, 'uid'), gid: imageIdentity(argv, 'gid'), home: '/home/' + user }, tail))
    }
  } catch { return false }
  return false
}
const imageIdentity = (argv: readonly string[], key: 'uid' | 'gid'): number => {
  const slice = argv.find(v => /^Slice=/.test(v))
  const id = Number(/(\d+)\.slice$/.exec(slice ?? '')?.[1])
  if (!Number.isSafeInteger(id)) throw new Error(`no ${key}`)
  return id
}

async function readServerInformation(ctx: OwnerToolsContext, account: Account, plan: Plan): Promise<Record<string, unknown>> {
  const versions: Record<string, string | null> = {}
  for (const [name, commands] of Object.entries(VERSION_COMMANDS)) {
    versions[name] = null
    for (const argv of commands) {
      const present = ctx.host ? await ctx.host.exists(argv[0]!) : false
      if (!present) continue
      const result = await ctx.host!.run([...argv]).catch(() => null)
      versions[name] = result?.ok ? VERSION.exec(result.stdout + ' ' + result.stderr)?.[1] ?? null : null
      break
    }
  }
  return { context: { accountId: account.id }, plan: plan.name, hostname: hostname(), panelVersion: ctx.panelVersion, os: { id: ctx.os.id, version: ctx.os.versionId, arch: arch(), kernel: release() }, primaryDomain: account.primaryDomain,
    versions, paths: { sendmail: '/usr/sbin/sendmail', perl: '/usr/bin/perl' }, services: ctx.services ? await ctx.services().catch(() => null) : null }
}

// ---------------------------------------------------------------- Perl modules

export const perlUnitName = (username: string): string => `xpanel-perl-${system.assertUsername(username)}.service`
export type PerlAction = 'install' | 'reinstall' | 'uninstall'
export function buildPerlCommand(account: ToolAccount, action: PerlAction, module: string): string[] {
  if (!MODULE.test(module)) return fail('VALIDATION', 'invalid Perl module name', unchanged)
  const library = account.home + '/' + PERL_LIBRARY
  const verb = action === 'uninstall' ? ['--uninstall', '--force'] : action === 'reinstall' ? ['--reinstall', '--notest'] : ['--notest']
  return accountUnitArgv(account, perlUnitName(account.username), '', [CPANM_BINARY, ...verb, '--local-lib', library, module], [], {})
}

/** cpanm records every distribution it installs under <lib>/<arch>/.meta/<dist>/install.json. */
export async function readPerlInventory(files: RuntimeFiles): Promise<{ name: string; version: string }[]> {
  const base = PERL_LIBRARY + '/lib/perl5'
  const list = async (path: string): Promise<readonly { name: string; kind: string }[]> => { try { return await files.list(path, { showHidden: true }) } catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return []; throw error } }
  const out: { name: string; version: string }[] = []
  for (const dir of (await list(base)).filter(entry => entry.kind === 'directory')) {
    const meta = base + '/' + dir.name + '/.meta'
    for (const dist of (await list(meta)).filter(entry => entry.kind === 'directory').slice(0, 500)) {
      try {
        const info = JSON.parse((await files.readText(meta + '/' + dist.name + '/install.json')).content) as { name?: unknown; target?: unknown; version?: unknown }
        const name = typeof info.target === 'string' ? info.target : info.name
        if (typeof name === 'string') out.push({ name: name.slice(0, 128), version: String(info.version ?? '').slice(0, 32) })
      } catch { /* a dist without readable metadata is not listed as installed */ }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function handlePerl(req: Request, method: string, log: boolean, ctx: OwnerToolsContext, account: Account, plan: Plan): Promise<Response> {
  const unit = perlUnitName(account.username), host = ctx.host
  if (log) {
    if (!host) return fail('PRECONDITION_FAILED', 'logs are unavailable on this server', unchanged)
    const r = await host.run(['/usr/bin/journalctl', '--unit=' + unit, '--lines=200', '--no-pager', '--output=short-iso', '--utc', '--quiet'])
    if (!r.ok) return fail('PRECONDITION_FAILED', 'the log could not be read', unchanged)
    return json(200, { unit, lines: r.stdout.split('\n').filter(Boolean).slice(-200).map(line => line.slice(0, 2000)) })
  }
  const engine = host ? await host.exists(CPANM_BINARY) : false
  const job = async (): Promise<string> => { const u = host ? (await readUnitStates(host, [unit])).get(unit) : undefined; return !u || u.load !== 'loaded' ? 'none' : u.active === 'activating' ? 'running' : u.active === 'failed' ? 'failed' : 'none' }
  if (method === 'GET') {
    const files = ctx.files?.(account, plan) ?? null
    return json(200, { context: { accountId: account.id }, library: account.home + '/' + PERL_LIBRARY + '/lib/perl5', useLine: `use lib '${account.home}/${PERL_LIBRARY}/lib/perl5';`, engine, job: await job(), modules: files ? await readPerlInventory(files) : null })
  }
  let body: Record<string, unknown>
  try { body = JSON.parse(await req.text()) as Record<string, unknown> } catch { return fail('VALIDATION', 'request body must be JSON', unchanged) }
  const action = body?.action, module = body?.module
  if (!['install', 'reinstall', 'uninstall'].includes(action as string) || typeof module !== 'string' || !MODULE.test(module)) return fail('VALIDATION', 'give an exact module name such as JSON::Tiny', { ...unchanged, reason: 'invalid_module' })
  if (!host || !engine) return fail('PRECONDITION_FAILED', 'the CPAN client is not installed on this server', { ...unchanged, reason: 'cpan_unavailable' })
  if (await job() === 'running') return fail('CONFLICT', 'another module operation is running', { ...unchanged, reason: 'OPERATION_IN_PROGRESS' })
  await host.systemd('reset-failed', unit).catch(() => {})
  const started = await host.run(buildPerlCommand(account, action as PerlAction, module))
  if (!started.ok) return fail('PRECONDITION_FAILED', 'the module operation could not be started', unchanged)
  await ctx.audit({ actor: ctx.caller.actor, principalId: ctx.caller.principalId, action: 'account.perl-modules.' + action, target: 'account:' + account.username, outcome: 'ok', detail: { module } }).catch(() => {})
  return json(202, { accepted: true, job: 'running' })
}

// ---------------------------------------------------------------- Images

/** Size, pixel and time bounds live here and in the unit properties, so a hostile image cannot outgrow 1 GB. */
export const IMAGE_SCRIPT = [
  'import json, os, sys',
  'from PIL import Image',
  'Image.MAX_IMAGE_PIXELS = 40000000',
  "KINDS = {'png': 'PNG', 'jpg': 'JPEG', 'jpeg': 'JPEG', 'gif': 'GIF', 'bmp': 'BMP', 'webp': 'WEBP'}",
  'def kind(name):',
  '    return KINDS.get(os.path.splitext(name)[1][1:].lower())',
  'def listing(folder):',
  '    return [n for n in sorted(os.listdir(folder)) if kind(n) and os.path.isfile(os.path.join(folder, n)) and not os.path.islink(os.path.join(folder, n))][:200]',
  'def opened(path):',
  '    if os.path.getsize(path) > 52428800:',
  "        raise ValueError('too large')",
  '    return Image.open(path)',
  'def write(image, path, fmt):',
  "    image = image.convert('RGB') if fmt == 'JPEG' and image.mode not in ('RGB', 'L') else image",
  "    temp = path + '.xpanel-tmp'",
  '    image.save(temp, fmt)',
  '    os.replace(temp, path)',
  "    return {'path': path, 'width': image.width, 'height': image.height}",
  'op, args = sys.argv[1], sys.argv[2:]',
  'results = []',
  "if op == 'read':",
  '    with opened(args[0]) as image:',
  "        results.append({'path': args[0], 'width': image.width, 'height': image.height})",
  "elif op == 'thumbnail':",
  '    folder, wide, high = args[0], int(args[1]), int(args[2])',
  "    target = os.path.join(folder, 'thumbnails')",
  '    os.makedirs(target, exist_ok=True)',
  '    for name in listing(folder):',
  '        with opened(os.path.join(folder, name)) as image:',
  "            results.append(write(image.resize((max(1, image.width * wide // 100), max(1, image.height * high // 100))), os.path.join(target, 'tn_' + name), kind(name)))",
  "elif op == 'scale':",
  '    path, wide, high, keep = args[0], int(args[1]), int(args[2]), args[3]',
  '    with opened(path) as image:',
  '        resized = image.resize((wide, high))',
  '        if keep:',
  '            write(image, keep, kind(keep))',
  '        results.append(write(resized, path, kind(path)))',
  "elif op == 'convert':",
  '    origin, extension = args[0], args[1]',
  '    for path in ([os.path.join(origin, n) for n in listing(origin)] if os.path.isdir(origin) else [origin]):',
  '        with opened(path) as image:',
  "            results.append(write(image, os.path.splitext(path)[0] + '.' + extension, KINDS[extension]))",
  "print(json.dumps({'results': results}))",
  '',
].join('\n')

export function buildImageCommand(account: ToolAccount, args: readonly string[]): string[] {
  const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/id'], {})
  return [...skeleton.slice(0, skeleton.lastIndexOf('--')), '--property', 'RuntimeMaxSec=60', '--property', 'MemoryMax=256M', '--property', 'TasksMax=8', '--', PYTHON, '-I', '-c', IMAGE_SCRIPT, ...args]
}

const IMAGE_NAME = /\.(?:png|jpe?g|gif|bmp|webp)$/i
const path = (value: unknown): string => isHomeRelativePath(value, 16) ? value : fail('VALIDATION', 'choose a path inside your home directory', unchanged)
const imagePath = (value: unknown): string => IMAGE_NAME.test(path(value)) ? value as string : fail('VALIDATION', 'choose a PNG, JPG, GIF, BMP or WEBP image', unchanged)
const whole = (value: unknown, max: number): string => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max ? String(value) : fail('VALIDATION', 'a size is out of range', unchanged)

/** Strict operation grammar; the percent and pixel bounds stop a request from asking for a huge output. */
export function imageArguments(body: Record<string, unknown>): string[] {
  switch (body?.op) {
    case 'read': return ['read', imagePath(body.path)]
    case 'thumbnail': return ['thumbnail', path(body.path), whole(body.widthPercent, 100), whole(body.heightPercent, 100)]
    case 'scale': return ['scale', imagePath(body.path), whole(body.width, 10000), whole(body.height, 10000), body.keepAs === null || body.keepAs === undefined ? '' : imagePath(body.keepAs)]
    case 'convert': return ['convert', path(body.path), ['png', 'jpg', 'gif', 'bmp', 'webp'].includes(body.format as string) ? body.format as string : fail('VALIDATION', 'format must be png, jpg, gif, bmp or webp', unchanged)]
    default: return fail('VALIDATION', 'unknown image operation', unchanged)
  }
}

async function handleImages(req: Request, method: string, ctx: OwnerToolsContext, account: Account): Promise<Response> {
  const engine = ctx.host ? (await ctx.host.run([...PILLOW_CHECK]).catch(() => null))?.ok === true : false
  if (method === 'GET') return json(200, { context: { accountId: account.id }, engine })
  let body: Record<string, unknown>
  try { body = JSON.parse(await req.text()) as Record<string, unknown> } catch { return fail('VALIDATION', 'request body must be JSON', unchanged) }
  const args = imageArguments(body)
  if (!ctx.host || !engine) return fail('PRECONDITION_FAILED', 'image processing is not installed on this server', { ...unchanged, reason: 'image_engine_unavailable' })
  const result = await ctx.host.run(buildImageCommand(account, args))
  if (!result.ok) return fail('PRECONDITION_FAILED', 'the image could not be processed; it may be too large or damaged', { stateChanged: args[0] !== 'read', reason: 'image_failed' })
  let parsed: unknown
  try { parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') } catch { return fail('SERVICE_UNAVAILABLE', 'the image result could not be verified', { stateChanged: args[0] !== 'read', verificationRequired: true }) }
  if (args[0] !== 'read') await ctx.audit({ actor: ctx.caller.actor, principalId: ctx.caller.principalId, action: 'account.images.' + args[0], target: 'account:' + account.username, outcome: 'ok', detail: { path: args[1] } }).catch(() => {})
  return json(200, parsed)
}

export async function handleOwnerToolsRoute(req: Request, url: URL, method: string, ctx: OwnerToolsContext): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/(server-information|perl-modules|images)(\/log)?$/.exec(url.pathname)
  if (!match || match[3] && match[2] !== 'perl-modules') return null
  const tool = match[2] as keyof typeof OWNER_TOOL_FEATURES, writable = tool !== 'server-information' && !match[3]
  if (method !== 'GET' && !(writable && method === 'POST')) return new Response(null, { status: 405, headers: { allow: writable ? 'GET, POST' : 'GET' } })
  const { account, plan } = await authorizeOwnerTool(ctx, match[1]!, OWNER_TOOL_FEATURES[tool])
  if (tool === 'server-information') return json(200, await readServerInformation(ctx, account, plan))
  return tool === 'images' ? handleImages(req, method, ctx, account) : handlePerl(req, method, !!match[3], ctx, account, plan)
}
