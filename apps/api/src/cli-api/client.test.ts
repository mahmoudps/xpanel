import { describe, expect, it } from 'vitest'
import { CliUsageError, EXIT, listFunctions, parseCliArgs, runCliApi, type CliCall, type CliResponse } from './client.ts'

const noStdin = (): string => { throw new Error('stdin must not be read') }
const call = (command: 'xuapi' | 'xwhmapi', argv: string[], stdin: () => string = noStdin): CliCall => {
  const parsed = parseCliArgs(command, argv, stdin, () => 'alice')
  if (parsed.kind !== 'call') throw new Error(`expected a call, got ${parsed.kind}`)
  return parsed.call
}
const respond = (status: number, contentType: string, body: string): CliResponse =>
  ({ status, contentType, body: (async function* () { yield Buffer.from(body) })() })

describe('xuapi / xwhmapi argument parsing', { tags: ['unit'] }, () => {
  it('maps a named function to its method and path and fills its parameters', () => {
    expect(call('xuapi', ['cron', 'list'])).toEqual({ command: 'xuapi', actAs: null, method: 'GET', path: '/api/account/cron', body: null })
    expect(call('xuapi', ['cron', 'run', 'id=0f6b5d3e-6c1a-4d3b-9a4f-2b7d1c9e8a01'])).toMatchObject({ method: 'POST', path: '/api/account/cron/0f6b5d3e-6c1a-4d3b-9a4f-2b7d1c9e8a01/run', body: null })
    expect(call('xwhmapi', ['accounts', 'list', 'status=active'])).toMatchObject({ method: 'GET', path: '/api/accounts?status=active' })
  })

  it('sends strings, typed JSON and one standard-input value', () => {
    expect(call('xuapi', ['cron', 'create', 'command=php run.php', 'enabled:=true', 'minute:=5']).body).toEqual({ command: 'php run.php', enabled: true, minute: 5 })
    expect(call('xuapi', ['POST', 'account/team', 'password=@-', 'name=dev'], () => 's3cret pass\n').body).toEqual({ password: 's3cret pass', name: 'dev' })
    expect(() => call('xuapi', ['POST', 'account/team', 'a=@-', 'b=@-'], () => 'x')).toThrow(CliUsageError)
  })

  it('refuses secrets on the command line', () => {
    for (const arg of ['password=hunter2', 'newPassword=x', 'apiToken=x', 'passphrase:="x"', 'clientSecret=x']) {
      expect(() => call('xuapi', ['POST', 'account/team', arg]), arg).toThrow(/standard input/)
    }
  })

  it('fills the account of an account-scoped path from --user or the calling user', () => {
    expect(call('xuapi', ['accounts', 'certificates_list']).path).toBe('/api/accounts/alice/certificates')
    expect(call('xuapi', ['--user=bobby', 'accounts', 'certificates_list'])).toMatchObject({ actAs: { kind: 'user', name: 'bobby' }, path: '/api/accounts/bobby/certificates' })
    expect(() => call('xuapi', ['accounts', 'get'])).toThrow(/id=<value> is required/)
  })

  it('accepts raw method and path but no query, fragment or dot segment in the path', () => {
    expect(call('xuapi', ['GET', 'account/cron'])).toMatchObject({ method: 'GET', path: '/api/account/cron' })
    expect(call('xuapi', ['DELETE', '/api/account/ssh/keys', 'fingerprint=SHA256:abc'])).toMatchObject({ path: '/api/account/ssh/keys', body: { fingerprint: 'SHA256:abc' } })
    for (const path of ['account/cron?x=1', 'account/../server', '/api/account/cron#a']) expect(() => call('xuapi', ['GET', path]), path).toThrow(CliUsageError)
  })

  it('keeps --user to xuapi and --reseller to xwhmapi', () => {
    expect(() => call('xuapi', ['--reseller=r1', 'cron', 'list'])).toThrow(/not an option of xuapi/)
    expect(() => call('xwhmapi', ['--user=alice', 'accounts', 'list'])).toThrow(/not an option of xwhmapi/)
    expect(call('xwhmapi', ['--reseller=r1', 'accounts', 'list']).actAs).toEqual({ kind: 'reseller', name: 'r1' })
    expect(() => call('xuapi', ['--user=Bad Name', 'cron', 'list'])).toThrow(CliUsageError)
    expect(() => call('xuapi', ['cron', 'nosuch'])).toThrow(/unknown function/)
  })

  it('lists functions of one module', () => {
    expect(listFunctions('xuapi', 'cron').split('\n')).toEqual(expect.arrayContaining(['cron list\tGET /api/account/cron', 'cron run\tPOST /api/account/cron/{id}/run']))
    expect(() => listFunctions('xuapi', 'nosuch')).toThrow(CliUsageError)
  })
})

describe('xuapi / xwhmapi output and exit status', { tags: ['unit'] }, () => {
  const exec = async (response: CliResponse | Error, argv = ['cron', 'list']) => {
    let stdout = '', stderr = ''
    const code = await runCliApi('xuapi', argv, { stdout: text => { stdout += String(text) }, stderr: text => { stderr += text }, readStdin: noStdin }, async () => {
      if (response instanceof Error) throw response
      return response
    })
    return { code, stdout, stderr }
  }

  it('prints one JSON document and maps the HTTP status to the exit status', async () => {
    const ok = await exec(respond(200, 'application/json; charset=utf-8', '{"jobs":[]}'))
    expect(ok.code).toBe(EXIT.ok)
    expect(JSON.parse(ok.stdout)).toEqual({ status: 200, data: { jobs: [] } })
    const refused = await exec(respond(403, 'application/problem+json', '{"code":"FORBIDDEN"}'))
    expect(refused.code).toBe(EXIT.refused)
    expect(JSON.parse(refused.stdout)).toEqual({ status: 403, error: { code: 'FORBIDDEN' } })
    expect((await exec(respond(503, 'application/json', '{}'))).code).toBe(EXIT.failed)
    expect((await exec(new Error('connect ENOENT'))).code).toBe(EXIT.failed)
  })

  it('writes a download as raw bytes and reports usage errors without a request', async () => {
    const raw = await exec(respond(200, 'text/csv', 'a,b\n'))
    expect(raw).toMatchObject({ code: EXIT.ok, stdout: 'a,b\n' })
    expect(raw.stderr).toContain('HTTP 200 text/csv')
    const bad = await exec(new Error('must not connect'), ['cron'])
    expect(bad.code).toBe(EXIT.usage)
    expect((await exec(new Error('must not connect'), ['--help'])).stdout).toContain('Usage: xuapi')
  })
})
