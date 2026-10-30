import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MariaDbServiceAdapter, mariadbSocketForFamily } from './mariadb.ts'
import type { MariaDbCommandInput, MariaDbCommandResult } from './mariadb.ts'

const roots: string[] = []
const directory = async () => { const root = await mkdtemp(join(tmpdir(), 'xpanel-db-proof-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const admin = async () => ({ exists: true, isFile: true, isSymlink: false, uid: 0, gid: 0, mode: 0o600, size: 64, content: '[client]\nuser=root\n' })
const success = (stdout = ''): MariaDbCommandResult => ({ ok: true, exitCode: 0, stdout, stderr: '' })
const sha = (content: string) => createHash('sha256').update(content).digest('hex')

describe('MariaDB backup and admin preconditions', () => {
  it('selects the installed socket by OS family and preserves trusted explicit overrides', () => {
    expect(mariadbSocketForFamily('debian')).toBe('/run/mysqld/mysqld.sock')
    expect(mariadbSocketForFamily('rhel')).toBe('/var/lib/mysql/mysql.sock')
    expect(mariadbSocketForFamily('rhel', '/run/custom-mariadb/admin.sock')).toBe('/run/custom-mariadb/admin.sock')
    expect(mariadbSocketForFamily('debian', null)).toBeNull()
    expect(() => mariadbSocketForFamily('rhel', '/run/../etc/socket')).toThrow()
  })
  it.each([
    { isFile: false }, { isSymlink: true }, { uid: 1000 }, { gid: 1000 }, { mode: 0o640 },
  ])('rejects unsafe credential metadata %j without starting a client', async override => {
    let commands = 0
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: async () => ({ ...await admin(), ...override }), commandRunner: async () => { commands++; return success() } })
    await expect(adapter.query(['SELECT 1'])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(commands).toBe(0)
  })
  it('does not accept a successful runner receipt without a real dump file', async () => {
    const root = await directory(), outputPath = join(root, 'dump.sql')
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: admin, commandRunner: async () => ({ ...success(), bytesProcessed: 3, sha256: sha('sql') }) })
    await expect(adapter.streamLogicalDump({ database: 'alice_db', username: 'alice', outputPath })).rejects.toBeDefined()
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks actual staged bytes before publishing a dump', async () => {
    const root = await directory(), outputPath = join(root, 'dump.sql'), content = 'CREATE TABLE account_data (id int);\n'
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: admin, commandRunner: async input => {
      await writeFile(input.stdoutFilePath!, content, { flag: 'wx', mode: 0o600 })
      return { ...success(), bytesProcessed: Buffer.byteLength(content), sha256: sha(content) }
    } })
    expect(await adapter.streamLogicalDump({ database: 'alice_db', username: 'alice', outputPath })).toMatchObject({ sha256: sha(content), sizeBytes: Buffer.byteLength(content) })
    expect(await readFile(outputPath, 'utf8')).toBe(content)
  })
  it('rejects fabricated dump hashes and preserves an existing backup', async () => {
    const root = await directory(), outputPath = join(root, 'dump.sql')
    await writeFile(outputPath, 'previous backup')
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: admin, commandRunner: async input => {
      await writeFile(input.stdoutFilePath!, 'actual dump', { flag: 'wx' })
      return { ...success(), sha256: sha('different bytes') }
    } })
    await expect(adapter.streamLogicalDump({ database: 'alice_db', username: 'alice', outputPath })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    expect(await readFile(outputPath, 'utf8')).toBe('previous backup')
  })
  it.each(['missing', 'directory', 'wrong-hash', 'empty'])('rejects %s restore input before database mutation', async kind => {
    const root = await directory(), inputPath = kind === 'directory' ? root : join(root, 'input.sql')
    if (kind === 'wrong-hash' || kind === 'empty') await writeFile(inputPath, kind === 'empty' ? '' : 'SQL')
    let commands = 0
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: admin, commandRunner: async () => { commands++; return success() } })
    await expect(adapter.streamLogicalRestore({ username: 'alice', targetDatabase: 'alice_db', inputPath, ...(kind === 'wrong-hash' ? { expectedSha256: sha('other') } : {}) }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(commands).toBe(0)
  })
  it('reports a digest of actual restored bytes when no expected digest was supplied', async () => {
    const root = await directory(), inputPath = join(root, 'input.sql'), content = 'CREATE TABLE fixture (id int);\n'
    await writeFile(inputPath, content)
    const calls: MariaDbCommandInput[] = []
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: admin, commandRunner: async input => {
      calls.push(input)
      return success(input.stdinSql?.includes('VERSION') ? '10.11.8-MariaDB\n' : '')
    } })
    const result = await adapter.streamLogicalRestore({ username: 'alice', targetDatabase: 'alice_db', inputPath, verifyBeforeCutover: false })
    expect(result.verifiedSha256).toBe(sha(content))
    expect(result.verifiedSha256).not.toBe(sha(inputPath))
    expect(calls.some(call => call.stdinFilePath === inputPath)).toBe(true)
  })
  it('marks a restore outcome unknown if input changes during client execution', async () => {
    const root = await directory(), inputPath = join(root, 'input.sql')
    await writeFile(inputPath, 'initial SQL')
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: admin, commandRunner: async input => {
      if (input.stdinFilePath) await writeFile(inputPath, 'changed SQL')
      return success(input.stdinSql?.includes('VERSION') ? '10.11.8-MariaDB\n' : '')
    } })
    await expect(adapter.streamLogicalRestore({ username: 'alice', targetDatabase: 'alice_db', inputPath, verifyBeforeCutover: false }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
  })
  it('does not turn an input pipeline failure into a successful restore', async () => {
    const root = await directory(), inputPath = join(root, 'input.sql')
    await writeFile(inputPath, 'initial SQL')
    const adapter = new MariaDbServiceAdapter({ adminConfigInspector: admin, commandRunner: async input => {
      if (input.stdinFilePath) throw new Error('input stream failed')
      return success(input.stdinSql?.includes('VERSION') ? '10.11.8-MariaDB\n' : '')
    } })
    await expect(adapter.streamLogicalRestore({ username: 'alice', targetDatabase: 'alice_db', inputPath, verifyBeforeCutover: false }))
      .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })
})
