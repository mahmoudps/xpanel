import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Options { paths: { tasks: string; logs: string }; now?: () => Date; sendmail?: (text: string) => unknown; start?: (unit: string) => boolean }
const program = createRequire(import.meta.url)('./host-task-program.cjs') as {
  main(id: string, options: Options): Promise<number>
  returnResult(returns: string, output: string): string
  triggerFires(trigger: { match: string; value: string }, output: string): boolean
}
const ID = 'aaaaaaaaaaa1', TRIGGER = 'bbbbbbbbbbb1'
const echo = (text: string, code = 0): string[] => [process.execPath, '-e', `process.stdout.write(${JSON.stringify(text)});process.exit(${code})`]

describe('host task program', { tags: ['unit'] }, () => {
  let root: string, paths: Options['paths']
  const write = (spec: Record<string, unknown>): void => writeFileSync(join(paths.tasks, `${ID}.json`), JSON.stringify({ id: ID, name: 'Check', steps: [], stamped: false, returns: 'string', alert: false, retention: null, triggers: [], refuse: null, ...spec }))
  const runs = (id = ID): Record<string, any>[] => readFileSync(join(paths.logs, `${id}.runs`), 'utf8').trim().split('\n').map(line => JSON.parse(line)) // eslint-disable-line @typescript-eslint/no-explicit-any
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'xp-task-')); paths = { tasks: join(root, 'tasks'), logs: join(root, 'logs') }; mkdirSync(paths.tasks) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('keeps the output in the log and records the run', async () => {
    write({ steps: [{ argv: echo('hello\n') }] })
    expect(await program.main(ID, { paths })).toBe(0)
    expect(readFileSync(join(paths.logs, `${ID}.log`), 'utf8')).toContain('hello\n')
    expect(runs()[0]).toMatchObject({ code: 0, result: 'ok' })
    expect(statSync(join(paths.logs, `${ID}.runs`)).mode & 0o777).toBe(0o600)
  })

  it('fires an include trigger on matching output and not otherwise', async () => {
    const started: string[] = [], options = { paths, start: (unit: string) => { started.push(unit); return true } }
    const triggers = [{ id: TRIGGER, name: 'Stopped', match: 'include', value: 'stopped', target: 'xpanel-task-ccccccccccc1.service' }]
    write({ steps: [{ argv: echo('service stopped\n') }], triggers })
    await program.main(ID, options)
    expect(started).toEqual(['xpanel-task-ccccccccccc1.service'])
    expect(runs()[0]!.fired).toEqual([TRIGGER])
    write({ steps: [{ argv: echo('service running\n') }], triggers })
    await program.main(ID, options)
    expect(started).toHaveLength(1)
    expect(runs(TRIGGER).map(item => item.fired)).toEqual([true, false])
  })

  it('fires nothing after a failed run and mails when asked', async () => {
    const sendmail = vi.fn(), start = vi.fn(() => true)
    write({ steps: [{ argv: echo('stopped\n', 3) }], alert: true, triggers: [{ id: TRIGGER, name: 'T', match: 'include', value: 'stopped', target: 'xpanel-task-ccccccccccc1.service' }] })
    expect(await program.main(ID, { paths, sendmail, start })).toBe(1)
    expect(start).not.toHaveBeenCalled()
    expect(sendmail.mock.calls[0]![0]).toContain('Subject: xPanel task failed: Check')
    expect(runs()[0]).toMatchObject({ code: 3, result: 'failed' })
  })

  it('flags TYPE_MISMATCH when an integer script prints text', async () => {
    write({ steps: [{ argv: echo('not a number\n') }], returns: 'integer' })
    expect(await program.main(ID, { paths })).toBe(1)
    expect(runs()[0]!.result).toBe('TYPE_MISMATCH')
    expect(readFileSync(join(paths.logs, `${ID}.log`), 'utf8')).toContain('TYPE_MISMATCH: declared integer')
    write({ steps: [{ argv: echo('noise\n42\n') }], returns: 'integer' })
    expect(await program.main(ID, { paths })).toBe(0)
  })

  it('checks numbers on the last line only', () => {
    expect(program.returnResult('float', '1.5e3')).toBe('ok')
    expect(program.returnResult('float', '7')).toBe('ok')
    expect(program.returnResult('integer', '1.5')).toBe('TYPE_MISMATCH')
    expect(program.returnResult('string', 'x')).toBe('ok')
  })

  it('matches each trigger type on trimmed output', () => {
    expect(program.triggerFires({ match: 'equal', value: 'ok' }, ' ok\n')).toBe(true)
    expect(program.triggerFires({ match: 'not-equal', value: 'ok' }, 'ok')).toBe(false)
    expect(program.triggerFires({ match: 'exclude', value: 'bad' }, 'fine')).toBe(true)
  })

  it('deletes the oldest copy on the fourth run with retention 3', async () => {
    const dir = join(root, 'copies')
    write({ stamped: true, retention: { dir, keep: 3 }, steps: [{ argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(`${dir}/{stamp}.tar.zst`)},'x')`] }] })
    for (let day = 1; day <= 4; day++) expect(await program.main(ID, { paths, now: () => new Date(Date.UTC(2026, 10, day)) })).toBe(0)
    expect(readdirSync(dir)).toEqual(['20261102T000000000Z.tar.zst', '20261103T000000000Z.tar.zst', '20261104T000000000Z.tar.zst'])
    expect(runs().at(-1)!.removed).toBe(1)
  })

  it('leaves no partial copy of a failed backup, and keeps the good ones', async () => {
    const dir = join(root, 'copies')
    mkdirSync(dir)
    writeFileSync(join(dir, '20261101T000000000Z.tar.zst'), 'good')
    write({ stamped: true, retention: { dir, keep: 1 }, steps: [{ argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(`${dir}/{stamp}.tar.zst`)},'partial');process.exit(1)`] }] })
    expect(await program.main(ID, { paths, now: () => new Date(Date.UTC(2026, 10, 2)) })).toBe(1)
    expect(readdirSync(dir)).toEqual(['20261101T000000000Z.tar.zst'])
  })

  it('reports a refused target and a missing binary as failed runs', async () => {
    write({ refuse: 'site_not_found' })
    expect(await program.main(ID, { paths })).toBe(1)
    expect(readFileSync(join(paths.logs, `${ID}.log`), 'utf8')).toContain('refused: site_not_found')
    write({ steps: [{ argv: ['/nonexistent/binary'] }] })
    expect(await program.main(ID, { paths })).toBe(1)
    expect(readFileSync(join(paths.logs, `${ID}.log`), 'utf8')).toContain('could not start')
  })

  it('refuses an id that is not a task id before touching a file', async () => {
    expect(await program.main('../etc/passwd', { paths })).toBe(2)
    expect(existsSync(paths.logs)).toBe(false)
  })
})
