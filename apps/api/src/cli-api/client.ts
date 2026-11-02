import { request as httpRequest } from 'node:http'
import { userInfo } from 'node:os'
import { CLI_API_FUNCTIONS, type CliApiCommand } from './functions.ts'

// Standalone: node: modules and the function table only, so any local user can run it without the panel's packages.

export const EXIT = Object.freeze({ ok: 0, usage: 1, refused: 2, failed: 3 })
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const SECRET_KEY = /pass(?:word|phrase)?|secret|token/i
const NAME = /^[a-z][a-z0-9_-]{0,63}$/

export class CliUsageError extends Error {}
const usage = (message: string): never => { throw new CliUsageError(message) }

export interface CliCall {
  command: CliApiCommand
  actAs: { kind: 'user' | 'reseller'; name: string } | null
  method: string
  /** Path with its parameters filled and, for GET, the query string. */
  path: string
  body: Record<string, unknown> | null
}

export type CliInvocation = { kind: 'help' } | { kind: 'list'; command: CliApiCommand; module: string | null } | { kind: 'call'; call: CliCall }

export const helpText = (command: CliApiCommand): string => [
  command === 'xuapi'
    ? 'Usage: xuapi [--user=<account>] <Module> <function> [key=value | key:=<json> | key=@-] ...'
    : 'Usage: xwhmapi [--reseller=<name>] <Module> <function> [key=value | key:=<json> | key=@-] ...',
  `       ${command} [options] <METHOD> <path> [params]`,
  `       ${command} [options] list [<Module>]`,
  '',
  command === 'xuapi'
    ? 'Runs an account API function as the calling hosting account. Root names the account with --user.'
    : 'Runs a server API function as root. Root may act as a reseller with --reseller.',
  'key=value sends a string, key:=<json> a JSON value, key=@- one value read from standard input.',
  'Passwords, passphrases, secrets and tokens are accepted only through key=@-.',
  'Output is one JSON document. Exit status: 0 done, 1 usage error, 2 refused by the API, 3 API failure or unreachable.',
].join('\n')

const parseParam = (arg: string, readStdin: () => string): [string, unknown] => {
  const typed = /^([A-Za-z_][A-Za-z0-9_.-]*):=(.*)$/s.exec(arg)
  const plain = typed ? null : /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/s.exec(arg)
  const match = typed ?? plain ?? usage(`parameter "${arg}" must be key=value, key:=<json> or key=@-`)
  const [, key, raw] = match as RegExpExecArray
  if (raw === '@-') {
    const value = readStdin()
    if (!typed) return [key!, value]
    try { return [key!, JSON.parse(value) as unknown] } catch { return usage(`standard input for ${key} is not valid JSON`) }
  }
  if (SECRET_KEY.test(key!)) usage(`${key} must not appear on the command line; pass it as ${key}=@- on standard input`)
  if (!typed) return [key!, raw]
  try { return [key!, JSON.parse(raw!) as unknown] } catch { return usage(`${key}:= needs a JSON value`) }
}

/** Parses everything after the command name. `readStdin` is called at most once. */
export const parseCliArgs = (command: CliApiCommand, argv: readonly string[], readStdin: () => string, defaultAccount?: () => string): CliInvocation => {
  let actAs: CliCall['actAs'] = null
  const rest: string[] = []
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    const option = /^--(user|reseller)=(.*)$/.exec(arg)
    if (option) {
      const kind = option[1] as 'user' | 'reseller'
      if ((kind === 'user') !== (command === 'xuapi')) usage(`--${kind} is not an option of ${command}`)
      if (actAs) usage(`--${kind} may be given once`)
      if (!NAME.test(option[2]!)) usage(`--${kind} needs a valid name`)
      actAs = { kind, name: option[2]! }
    } else if (arg.startsWith('--')) usage(`unknown option ${arg}`)
    else rest.push(arg)
  }
  if (rest.length === 0) return { kind: 'help' }
  if (rest[0] === 'list') {
    if (rest.length > 2) usage(`usage: ${command} list [<Module>]`)
    return { kind: 'list', command, module: rest[1] ?? null }
  }
  if (rest.length < 2) usage(`usage: ${command} <Module> <function> [params] or ${command} <METHOD> <path> [params]`)
  let stdinUsed = false
  const once = (): string => {
    if (stdinUsed) usage('only one parameter may read standard input')
    stdinUsed = true
    return readStdin().replace(/\r?\n$/, '')
  }
  const params = new Map(rest.slice(2).map(arg => parseParam(arg, once)))
  let method: string, template: string
  if (METHODS.has(rest[0]!)) {
    method = rest[0]!
    template = rest[1]!.startsWith('/api/') ? rest[1]! : `/api/${rest[1]!.replace(/^\/+/, '')}`
    if (/[?#]|(?:^|\/)\.\.?(?:\/|$)/.test(template)) usage('the path takes no query, fragment or dot segment; pass parameters as key=value')
  } else {
    const found = CLI_API_FUNCTIONS[command].find(([module, fn]) => module === rest[0] && fn === rest[1])
    if (!found) usage(`unknown function ${rest[0]} ${rest[1]}; run ${command} list ${rest[0]}`)
    method = found![2]
    template = found![3]
  }
  const path = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    let value = params.get(name)
    params.delete(name)
    // An account runs against its own account unless it names one.
    if (value === undefined && command === 'xuapi' && (name === 'account' || name === 'username')) value = actAs?.name ?? defaultAccount?.()
    if (typeof value !== 'string' || value.length === 0) return usage(`${name}=<value> is required`)
    return encodeURIComponent(value)
  })
  const query = method === 'GET' && params.size > 0
    ? `?${new URLSearchParams([...params].map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))}`
    : ''
  return { kind: 'call', call: { command, actAs, method, path: path + query, body: method === 'GET' || params.size === 0 ? null : Object.fromEntries(params) } }
}

export const listFunctions = (command: CliApiCommand, module: string | null): string => {
  const rows = CLI_API_FUNCTIONS[command].filter(([name]) => module === null || name === module)
  if (rows.length === 0) usage(`no functions in module ${module}`)
  return rows.map(([name, fn, method, path]) => `${name} ${fn}\t${method} ${path}`).join('\n')
}

export interface CliResponse { status: number; contentType: string; body: AsyncIterable<Uint8Array> }
export type CliTransport = (call: CliCall) => Promise<CliResponse>

export const socketPathFor = (command: CliApiCommand, env: NodeJS.ProcessEnv = process.env): string =>
  `${env.XPANEL_CLI_SOCKET_DIR ?? '/run/xpanel-api'}/${command}.sock`

/** One HTTP request over the local socket of the running API service. */
export const socketTransport = (socketPath: string): CliTransport => call => new Promise((resolve, reject) => {
  const body = call.body ? Buffer.from(JSON.stringify(call.body)) : null
  const req = httpRequest({
    // One connection per call: the kernel identity belongs to the connection.
    socketPath, agent: false, method: call.method, path: call.path,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json', 'content-length': String(body.byteLength) } : {}),
      ...(call.actAs ? { 'x-xpanel-act-as': `${call.actAs.kind}:${call.actAs.name}` } : {}),
    },
  }, res => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: res }))
  req.once('error', reject)
  req.end(body ?? undefined)
})

const collect = async (body: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export interface CliIo {
  stdout: (text: string | Uint8Array) => void
  stderr: (text: string) => void
  readStdin: () => string
  defaultAccount?: () => string
}

/** Runs one invocation and returns the exit status. */
export const runCliApi = async (command: CliApiCommand, argv: readonly string[], io: CliIo, transport: CliTransport): Promise<number> => {
  let invocation: CliInvocation
  try {
    invocation = parseCliArgs(command, argv, io.readStdin, io.defaultAccount)
    if (invocation.kind === 'help') { io.stdout(`${helpText(command)}\n`); return EXIT.ok }
    if (invocation.kind === 'list') { io.stdout(`${listFunctions(command, invocation.module)}\n`); return EXIT.ok }
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    io.stderr(`${command}: ${error.message}\n`)
    return EXIT.usage
  }
  let response: CliResponse
  try {
    response = await transport(invocation.call)
  } catch (error) {
    io.stderr(`${command}: the xPanel API service is unreachable: ${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.failed
  }
  const exit = response.status >= 200 && response.status < 300 ? EXIT.ok : response.status >= 400 && response.status < 500 ? EXIT.refused : EXIT.failed
  if (!/^application\/(?:problem\+)?json\b/.test(response.contentType)) {
    for await (const chunk of response.body) io.stdout(chunk)
    io.stderr(`${command}: HTTP ${response.status} ${response.contentType || 'without content type'}\n`)
    return exit
  }
  const text = await collect(response.body)
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) as unknown : null } catch { parsed = text }
  io.stdout(`${JSON.stringify({ status: response.status, [exit === EXIT.ok ? 'data' : 'error']: parsed }, null, 2)}\n`)
  return exit
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2)
  if (command !== 'xuapi' && command !== 'xwhmapi') {
    process.stderr.write('usage: client.ts xuapi|xwhmapi [arguments]\n')
    process.exit(EXIT.usage)
  }
  const { readFileSync } = await import('node:fs')
  process.exitCode = await runCliApi(command, argv, {
    stdout: text => { process.stdout.write(text) },
    stderr: text => { process.stderr.write(text) },
    readStdin: () => readFileSync(0, 'utf8'),
    defaultAccount: () => userInfo().username,
  }, socketTransport(socketPathFor(command)))
}
