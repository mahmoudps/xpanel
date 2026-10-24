import { ACCOUNT_FILE_HELPER_PROTOCOL_VERSION } from './account-file-runner.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { fail, isXpanelError, XpanelError } from '@xpanel/core'
import { FakeHostExecutor } from './executor.ts'
import { decodeFileBase64, JailedFileManager, MAX_BINARY_BYTES, MAX_EDIT_BYTES, MAX_FILE_LIST_ENTRIES, NativeAccountFileRunner } from './file-manager.ts'
import type { AccountFileContext, AccountFileRequest, AccountFileRunner, FileEntry, HelperProcessSpawner, TrashItem } from './file-manager.ts'

const account = { username: 'alice', uid: 29101, gid: 29101, home: '/home/alice' }
const timestamp = '2026-10-22T08:00:00.000Z'
const identifier = 'b12c4154-4e6c-4b2c-a2bc-aad60d40705e'
const entry = (path: string, kind: FileEntry['kind'] = 'file', sizeBytes = 3, mode = 0o640): FileEntry => ({
  name: path.split('/').at(-1)!, path, kind, sizeBytes, mode, mtime: timestamp,
})
const trashed = (): TrashItem => ({
  id: identifier, name: 'private.txt', originalPath: 'public_html/private.txt', sizeBytes: 3, deletedAt: timestamp,
})
const code = (expected: string) => (error: unknown): boolean => isXpanelError(error) && error.code === expected

const contractRunner = (response: (request: Readonly<AccountFileRequest>, context: Readonly<AccountFileContext>) => unknown) => {
  const calls: { context: Readonly<AccountFileContext>; request: Readonly<AccountFileRequest> }[] = []
  const runner: AccountFileRunner = {
    async run(context, request) {
      calls.push({ context, request })
      return response(request, context)
    },
  }
  return { runner, calls }
}

describe('account file execution boundary', () => {
  let fixture: string
  let home: string

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'xpanel-files-security-'))
    home = join(fixture, 'home', 'alice')
    await mkdir(join(home, 'public_html'), { recursive: true })
    await writeFile(join(home, 'public_html', 'private.txt'), 'tenant-content-marker')
  })

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('does not return agent-readable content after a denied isolated command', async () => {
    const executor = new FakeHostExecutor()
    executor.failCommand('cat', 13, 'permission denied')
    const options = { account, executor }
    const manager = new JailedFileManager(home, 'unlimited', options)

    await assert.rejects(
      () => manager.readText('public_html/private.txt'),
      (error: unknown) => isXpanelError(error) && error.code === 'PRECONDITION_FAILED',
    )
    assert.equal(executor.executedCommands.length, 0)
    assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
  })

  it.each(['list', 'read', 'write', 'mkdir', 'chmod', 'trash', 'list-trash', 'restore', 'empty-trash'] as const)(
    '%s fails closed without a confined runner', async (operation) => {
      const manager = new JailedFileManager(home, 1, { account })
      const actions = {
        list: () => manager.list(),
        read: () => manager.readText('public_html/private.txt'),
        write: () => manager.writeText('public_html/private.txt', 'changed'),
        mkdir: () => manager.mkdir('public_html/new-directory'),
        chmod: () => manager.chmod('public_html/private.txt', 0o600),
        trash: () => manager.moveToTrash('public_html/private.txt'),
        'list-trash': () => manager.listTrash(),
        restore: () => manager.restoreFromTrash(identifier),
        'empty-trash': () => manager.emptyTrash(),
      }
      await assert.rejects(actions[operation], code('PRECONDITION_FAILED'))
      assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
      await assert.rejects(() => stat(join(home, 'public_html', 'new-directory')), { code: 'ENOENT' })
    },
  )

  it('does not inspect or act on an account-controlled trash manifest', async () => {
    const outside = join(fixture, 'home', 'outside-protected.txt')
    await writeFile(outside, 'outside-marker')
    await mkdir(join(home, '.trash'))
    await writeFile(join(home, '.trash', '.manifest.json'), JSON.stringify({
      items: [{ ...trashed(), id: '../../outside-protected.txt' }],
    }))
    const manager = new JailedFileManager(home, 'unlimited', { account })
    await assert.rejects(() => manager.emptyTrash(), code('PRECONDITION_FAILED'))
    assert.equal(await readFile(outside, 'utf8'), 'outside-marker')
  })

  it('propagates runner denial without a second agent filesystem attempt', async () => {
    const { runner, calls } = contractRunner(() => fail('FORBIDDEN', 'confined operation denied'))
    const manager = new JailedFileManager(home, 1, { account, runner })
    await assert.rejects(() => manager.readText('public_html/private.txt'), code('FORBIDDEN'))
    await assert.rejects(() => manager.writeText('public_html/private.txt', 'changed'), code('FORBIDDEN'))
    await assert.rejects(() => manager.moveToTrash('public_html/private.txt'), code('FORBIDDEN'))
    assert.equal(calls.length, 3)
    assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
  })

  it('uses only typed runner results without duplicating successful operations in the agent', async () => {
    const { runner, calls } = contractRunner((request) => {
      switch (request.op) {
        case 'list': return [entry('public_html/private.txt')]
        case 'read': return { path: request.path, content: 'runner-only', sizeBytes: 11, mtime: timestamp }
        case 'write': return entry(request.path, 'file', Buffer.byteLength(request.content), request.mode)
        case 'mkdir': return entry(request.path, 'directory', 0, request.mode)
        case 'chmod': return entry(request.path, 'file', 3, request.mode)
        case 'trash': return trashed()
        case 'list-trash': return [trashed()]
        case 'restore': return entry('public_html/private.txt')
        case 'empty-trash': return 1
      }
    })
    const manager = new JailedFileManager(home, 1, { account, runner })
    assert.equal((await manager.list('public_html'))[0]?.path, 'public_html/private.txt')
    assert.equal((await manager.readText('public_html/private.txt')).content, 'runner-only')
    await manager.writeText('public_html/private.txt', 'runner-only')
    await manager.mkdir('public_html/new-directory')
    await manager.chmod('public_html/private.txt', 0o600)
    assert.equal((await manager.moveToTrash('public_html/private.txt')).id, identifier)
    assert.equal((await manager.listTrash()).length, 1)
    await manager.restoreFromTrash(identifier)
    assert.equal(await manager.emptyTrash({ olderThanDays: 7 }), 1)
    assert.equal(calls.length, 9)
    assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
    await assert.rejects(() => stat(join(home, 'public_html', 'new-directory')), { code: 'ENOENT' })
  })

  it('round-trips binary uploads through the confined runner and rejects unsafe payloads', async () => {
    const payload = Buffer.from([0, 255, 10, 13, 0x80, 0x7f])
    const encoded = payload.toString('base64')
    const { runner, calls } = contractRunner((request) => {
      if (request.op === 'put-bytes') return entry(request.path, 'file', decodeFileBase64(request.contentBase64).length, request.mode)
      if (request.op === 'get-bytes') return { path: request.path, contentBase64: encoded, sizeBytes: payload.length, mtime: timestamp }
      return undefined
    })
    const manager = new JailedFileManager(home, 1, { account, runner })
    const saved = await manager.putBytes('public_html/pixel.bin', encoded)
    assert.equal(saved.sizeBytes, payload.length)
    assert.equal(saved.kind, 'file')
    const loaded = await manager.getBytes('public_html/pixel.bin')
    assert.deepEqual(decodeFileBase64(loaded.contentBase64), payload)
    assert.equal(calls[0]?.request.op, 'put-bytes')
    assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
    await assert.rejects(() => manager.putBytes('../etc/passwd', encoded), code('FORBIDDEN'))
    await assert.rejects(() => manager.putBytes('public_html/pixel.bin', '@@@@'), code('VALIDATION'))
    await assert.rejects(() => manager.putBytes('public_html/pixel.bin', Buffer.alloc(MAX_BINARY_BYTES + 1).toString('base64')), code('VALIDATION'))
    await assert.rejects(() => manager.getBytes('.trash/secret.bin'), code('FORBIDDEN'))
  })

  it('forwards a frozen identity subset and resource limits', async () => {
    const withUnrelatedData = { ...account, unrelatedSecret: 'never-forward-this' }
    const { runner, calls } = contractRunner(() => [])
    const manager = new JailedFileManager(home, 2, { account: withUnrelatedData, runner })
    withUnrelatedData.username = 'changed'
    await manager.list()
    const call = calls[0]!
    assert.deepEqual(call.context.account, account)
    assert.equal(Object.isFrozen(call.context), true)
    assert.equal(Object.isFrozen(call.context.account), true)
    assert.equal(Object.isFrozen(call.request), true)
    assert.equal(call.context.homeRoot, home)
    assert.equal(call.context.diskQuotaMb, 2)
    assert.equal(call.context.maxEditBytes, MAX_EDIT_BYTES)
    assert.equal(call.context.maxListEntries, MAX_FILE_LIST_ENTRIES)
  })

  it.each(['../../outside', '/etc/passwd', 'a\\b', 'a//b', 'a/../b', 'a/.', 'a/\u0000b', '.trash', '.trash/.manifest.json', 'C:/secret'])(
    'rejects unsafe path %j before calling the runner', async (path) => {
      const { runner, calls } = contractRunner(() => [])
      const manager = new JailedFileManager(home, 'unlimited', { account, runner })
      await assert.rejects(() => manager.readText(path), code('FORBIDDEN'))
      assert.equal(calls.length, 0)
    },
  )

  it.each(['../../outside', '/tmp/file', '', 'not-a-uuid'])(
    'rejects malformed trash identifier %j without runner access', async (id) => {
      const { runner, calls } = contractRunner(() => [])
      const manager = new JailedFileManager(home, 'unlimited', { account, runner })
      await assert.rejects(() => manager.restoreFromTrash(id), code('VALIDATION'))
      assert.equal(calls.length, 0)
    },
  )

  it('rejects unsafe modes, integer overflow and oversized UTF-8 payloads before dispatch', async () => {
    const { runner, calls } = contractRunner(() => undefined)
    const manager = new JailedFileManager(home, 1, { account, runner })
    await assert.rejects(() => manager.writeText('x', 'text', { mode: 0o777 }), code('VALIDATION'))
    await assert.rejects(() => manager.writeText('x', 'text', { mode: 2 ** 32 + 0o640 }), code('VALIDATION'))
    await assert.rejects(() => manager.mkdir('x', 0o777), code('VALIDATION'))
    await assert.rejects(() => manager.chmod('x', 2 ** 32 + 0o700), code('VALIDATION'))
    await assert.rejects(() => manager.writeText('x', 'ك'.repeat(MAX_EDIT_BYTES / 2 + 1)), code('LIMIT_EXCEEDED'))
    assert.equal(calls.length, 0)
  })

  it('rejects text and paths that would change identity during UTF-8 encoding', async () => {
    const { runner, calls } = contractRunner(() => undefined)
    const manager = new JailedFileManager(home, 'unlimited', { account, runner })
    await assert.rejects(() => manager.readText('broken-\ud800'), code('VALIDATION'))
    await assert.rejects(() => manager.writeText('x', '\ud800'), code('VALIDATION'))
    await assert.rejects(() => manager.readText('ك'.repeat(2049)), code('VALIDATION'))
    assert.equal(calls.length, 0)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 36_501])(
    'rejects invalid retention %s before dispatch', async (olderThanDays) => {
      const { runner, calls } = contractRunner(() => 0)
      const manager = new JailedFileManager(home, 'unlimited', { account, runner })
      await assert.rejects(() => manager.emptyTrash({ olderThanDays }), code('VALIDATION'))
      assert.equal(calls.length, 0)
    },
  )

  it.each([
    { path: '../outside', content: 'x', sizeBytes: 1, mtime: timestamp },
    { path: 'public_html/private.txt', content: 'x', sizeBytes: 2, mtime: timestamp },
    { path: 'public_html/private.txt', content: 'x', sizeBytes: 1, mtime: '2026-02-31T08:00:00Z' },
    { path: 'public_html/private.txt', content: 'x', sizeBytes: 1, mtime: timestamp, token: 'must-not-leak' },
    { path: 'public_html/private.txt', content: '\ud800', sizeBytes: 3, mtime: timestamp },
  ])('rejects malformed read responses without exposing their payload', async (response) => {
    const { runner } = contractRunner(() => response)
    const manager = new JailedFileManager(home, 'unlimited', { account, runner })
    await assert.rejects(() => manager.readText('public_html/private.txt'), code('CONFIG_TEST_FAILED'))
  })

  it.each([
    { entries: [entry('different-parent/file.txt')] },
    { entries: [entry('public_html/private.txt'), entry('public_html/private.txt')] },
    { entries: [entry('public_html/nested/file.txt')] },
  ])('rejects escaped, nested or duplicate listing responses', async ({ entries: response }) => {
    const { runner } = contractRunner(() => response)
    const manager = new JailedFileManager(home, 'unlimited', { account, runner })
    await assert.rejects(() => manager.list('public_html'), code('CONFIG_TEST_FAILED'))
  })

  it('rejects corrupted trash identifiers returned by a runner', async () => {
    const { runner } = contractRunner(() => [{ ...trashed(), id: '../../outside-protected.txt' }])
    const manager = new JailedFileManager(home, 'unlimited', { account, runner })
    await assert.rejects(() => manager.listTrash(), code('CONFIG_TEST_FAILED'))
  })

  it.each([entry('public_html/private.txt', 'symlink'), entry('public_html/private.txt', 'file', 3, 0o777)])(
    'rejects unsafe mutation results', async (response) => {
      const { runner } = contractRunner(() => response)
      const manager = new JailedFileManager(home, 'unlimited', { account, runner })
      await assert.rejects(() => manager.chmod('public_html/private.txt', 0o600), code('CONFIG_TEST_FAILED'))
    },
  )

  it.each([
    { uid: 0, gid: 29101 },
    { uid: 29101, gid: 0 },
    { uid: 999, gid: 999 },
    { uid: 65534, gid: 29101 },
    { uid: 29101, gid: 65534 },
  ])('rejects root or system UID/GID %j before creating a manager or dispatching a runner', ({ uid, gid }) => {
    assert.throws(
      () => new JailedFileManager(home, 'unlimited', { account: { ...account, uid, gid } }),
      code('VALIDATION'),
    )
  })
})

describe('NativeAccountFileRunner protocol v2 and child process boundaries', () => {
  let fixture: string
  let home: string

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'xpanel-native-runner-'))
    home = join(fixture, 'home', 'alice')
    await mkdir(join(home, 'public_html'), { recursive: true })
    await writeFile(join(home, 'public_html', 'private.txt'), 'tenant-content-marker')
  })

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true })
  })

  it('preserves maximum binary upload and download inside the supervised protocol request and response budgets', async () => {
    const payload = Buffer.alloc(MAX_BINARY_BYTES, 255).toString('base64')
    const runner = new NativeAccountFileRunner({
      binaryPath: '/opt/xpanel/bin/xpanel-account-files',
      requireCgroup: true,
      cgroupPathForAccount: current => `/sys/fs/cgroup/xpanel.slice/xpanel-${current.uid}.slice`,
      spawner: async ({ stdinPayload }) => {
        const parsed = JSON.parse(stdinPayload) as { protocolVersion: number; context: { workerUnit: string }; request: AccountFileRequest }
        assert.equal(parsed.protocolVersion, ACCOUNT_FILE_HELPER_PROTOCOL_VERSION)
        assert.match(parsed.context.workerUnit, /^xpanel-files-29101-[0-9a-f]{32}\.service$/)
        if (parsed.request.op === 'put-bytes') {
          assert.ok(Buffer.byteLength(stdinPayload) > 2 * 1024 * 1024)
          assert.ok(Buffer.byteLength(stdinPayload) < 4 * 1024 * 1024)
          assert.equal(decodeFileBase64(parsed.request.contentBase64).byteLength, MAX_BINARY_BYTES)
        }
        const result = parsed.request.op === 'get-bytes'
          ? { path: parsed.request.path, contentBase64: payload, sizeBytes: MAX_BINARY_BYTES, mtime: timestamp }
          : entry('public_html/maximum.bin', 'file', MAX_BINARY_BYTES)
        return { exitCode: 0, signal: null, pid: 9001, stderr: '', stdout: JSON.stringify({
          protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION, ok: true, op: parsed.request.op,
          worker: { pid: 4001, uid: account.uid, gid: account.gid, cgroup: `/xpanel.slice/xpanel-${account.uid}.slice/${parsed.context.workerUnit}` }, result,
        }) }
      },
    })
    const manager = new JailedFileManager(home, 512, { account, runner })
    assert.equal((await manager.putBytes('public_html/maximum.bin', payload)).sizeBytes, MAX_BINARY_BYTES)
    const downloaded = await manager.getBytes('public_html/maximum.bin')
    assert.equal(downloaded.sizeBytes, MAX_BINARY_BYTES)
    assert.equal(downloaded.contentBase64, payload)
  })

  const nodeScriptSpawner = (script: string): HelperProcessSpawner => ({
    stdinPayload,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
  }) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ['-e', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let stdoutOversize = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      timer.unref?.()
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes > maxStdoutBytes) {
          stdoutOversize = true
          child.kill('SIGKILL')
          return
        }
        stdoutChunks.push(Buffer.from(chunk))
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes < maxStderrBytes) stderrChunks.push(Buffer.from(chunk))
        stderrBytes += chunk.length
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(stdinPayload, 'utf8')
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer)
        if (stdoutOversize) {
          rejectPromise(new XpanelError('CONFIG_TEST_FAILED', 'confined file helper output exceeded maximum response size'))
          return
        }
        if (timedOut) {
          rejectPromise(new XpanelError('SERVICE_UNAVAILABLE', 'confined file helper timed out and was terminated'))
          return
        }
        resolvePromise({
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          pid: child.pid ?? 1234,
        })
      })
    })

  it('validates every confined file operation over the protocol v2 JSON envelope and records worker telemetry', async () => {
    const receivedPayloads: Record<string, unknown>[] = []
    const runner = new NativeAccountFileRunner({
      binaryPath: '/opt/xpanel/bin/xpanel-account-files',
      cgroupPathForAccount: (acc) => `/sys/fs/cgroup/xpanel.slice/xpanel-${acc.uid}.slice`,
      requireCgroup: true,
      spawner: async ({ stdinPayload }) => {
        const parsed = JSON.parse(stdinPayload) as {
          protocolVersion: number
          context: { uid: number; gid: number; cgroupPath: string }
          request: AccountFileRequest
        }
        receivedPayloads.push(parsed)
        const req = parsed.request
        let result: unknown
        switch (req.op) {
          case 'list':
            result = [entry('public_html/private.txt')]
            break
          case 'read':
            result = { path: req.path, content: 'helper-read', sizeBytes: 11, mtime: timestamp }
            break
          case 'write':
            result = entry(req.path, 'file', Buffer.byteLength(req.content, 'utf8'), req.mode)
            break
          case 'put-bytes':
            result = entry(req.path, 'file', decodeFileBase64(req.contentBase64).length, req.mode)
            break
          case 'get-bytes':
            result = { path: req.path, contentBase64: Buffer.from([0, 255]).toString('base64'), sizeBytes: 2, mtime: timestamp }
            break
          case 'mkdir':
            result = entry(req.path, 'directory', 0, req.mode)
            break
          case 'chmod':
            result = entry(req.path, 'file', 3, req.mode)
            break
          case 'trash':
            result = trashed()
            break
          case 'list-trash':
            result = [trashed()]
            break
          case 'restore':
            result = entry('public_html/private.txt')
            break
          case 'empty-trash':
            result = 1
            break
        }
        return {
          exitCode: 0,
          signal: null,
          pid: 4410,
          stderr: '',
          stdout: `${JSON.stringify({
            protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
            ok: true,
            op: req.op,
            worker: {
              pid: 4410,
              uid: parsed.context.uid,
              gid: parsed.context.gid,
              cgroup: '/xpanel.slice/xpanel-29101.slice',
            },
            result,
          })}\n`,
        }
      },
    })

    const manager = new JailedFileManager(home, 512, { account, runner })
    assert.equal((await manager.list('public_html'))[0]?.path, 'public_html/private.txt')
    assert.equal((await manager.readText('public_html/private.txt')).content, 'helper-read')
    assert.equal((await manager.writeText('public_html/private.txt', 'updated')).sizeBytes, 7)
    assert.equal((await manager.putBytes('public_html/pixel.bin', Buffer.from([0, 255]).toString('base64'))).sizeBytes, 2)
    assert.equal((await manager.getBytes('public_html/pixel.bin')).sizeBytes, 2)
    assert.equal((await manager.mkdir('public_html/sub')).kind, 'directory')
    assert.equal((await manager.chmod('public_html/private.txt', 0o600)).mode, 0o600)
    assert.equal((await manager.moveToTrash('public_html/private.txt')).id, identifier)
    assert.equal((await manager.listTrash()).length, 1)
    assert.equal((await manager.restoreFromTrash(identifier)).path, 'public_html/private.txt')
    assert.equal(await manager.emptyTrash({ olderThanDays: 3 }), 1)

    assert.equal(receivedPayloads.length, 11)
    assert.equal(runner.observations.length, 11)
    assert.equal(runner.lastObservation?.uid, account.uid)
    assert.equal(runner.lastObservation?.gid, account.gid)
    assert.equal(runner.lastObservation?.cgroup, '/xpanel.slice/xpanel-29101.slice')
    assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
  })

  it.each([
    {
      label: 'protocol version mismatch',
      stdout: JSON.stringify({
        protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION + 1,
        ok: true,
        op: 'read',
        worker: { pid: 100, uid: 29101, gid: 29101, cgroup: '/' },
        result: { path: 'public_html/private.txt', content: 'x', sizeBytes: 1, mtime: timestamp },
      }),
    },
    {
      label: 'malformed JSON',
      stdout: '{not-valid-json',
    },
    {
      label: 'empty output',
      stdout: '   ',
    },
    {
      label: 'operation mismatch',
      stdout: JSON.stringify({
        protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
        ok: true,
        op: 'write',
        worker: { pid: 100, uid: 29101, gid: 29101, cgroup: '/' },
        result: { path: 'public_html/private.txt', content: 'x', sizeBytes: 1, mtime: timestamp },
      }),
    },
    {
      label: 'worker UID remained root (0)',
      stdout: JSON.stringify({
        protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
        ok: true,
        op: 'read',
        worker: { pid: 100, uid: 0, gid: 29101, cgroup: '/' },
        result: { path: 'public_html/private.txt', content: 'x', sizeBytes: 1, mtime: timestamp },
      }),
    },
    {
      label: 'worker UID mismatch',
      stdout: JSON.stringify({
        protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
        ok: true,
        op: 'read',
        worker: { pid: 100, uid: 29102, gid: 29101, cgroup: '/' },
        result: { path: 'public_html/private.txt', content: 'x', sizeBytes: 1, mtime: timestamp },
      }),
    },
    {
      label: 'worker cgroup slice mismatch',
      stdout: JSON.stringify({
        protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
        ok: true,
        op: 'read',
        worker: { pid: 100, uid: 29101, gid: 29101, cgroup: '/user.slice' },
        result: { path: 'public_html/private.txt', content: 'x', sizeBytes: 1, mtime: timestamp },
      }),
    },
  ])('rejects $label with CONFIG_TEST_FAILED without root fallback', async ({ stdout }) => {
    const runner = new NativeAccountFileRunner({
      binaryPath: '/opt/xpanel/bin/xpanel-account-files',
      cgroupPathForAccount: (acc) => `/sys/fs/cgroup/xpanel.slice/xpanel-${acc.uid}.slice`,
      requireCgroup: true,
      spawner: async () => ({ exitCode: 0, signal: null, pid: 100, stdout, stderr: '' }),
    })
    const manager = new JailedFileManager(home, 'unlimited', { account, runner })
    await assert.rejects(() => manager.readText('public_html/private.txt'), code('CONFIG_TEST_FAILED'))
    assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
  })

  it.each([
    { helperCode: 'FORBIDDEN', errno: 40, errnoName: 'ELOOP', expected: 'FORBIDDEN' },
    { helperCode: 'FORBIDDEN', errno: 18, errnoName: 'EXDEV', expected: 'FORBIDDEN' },
    { helperCode: 'LIMIT_EXCEEDED', errno: 122, errnoName: 'EDQUOT', expected: 'LIMIT_EXCEEDED' },
    { helperCode: 'LIMIT_EXCEEDED', errno: 28, errnoName: 'ENOSPC', expected: 'LIMIT_EXCEEDED' },
    { helperCode: 'NOT_FOUND', errno: 2, errnoName: 'ENOENT', expected: 'NOT_FOUND' },
    { helperCode: 'CONFLICT', errno: 17, errnoName: 'EEXIST', expected: 'CONFLICT' },
    { helperCode: 'PRECONDITION_FAILED', errno: 38, errnoName: 'ENOSYS', expected: 'PRECONDITION_FAILED' },
    { helperCode: 'VALIDATION', errno: 22, errnoName: 'EINVAL', expected: 'VALIDATION' },
  ])('maps helper error $helperCode ($errnoName) to $expected without fallback', async ({ helperCode, errno, errnoName, expected }) => {
    const runner = new NativeAccountFileRunner({
      binaryPath: '/opt/xpanel/bin/xpanel-account-files',
      spawner: async () => ({
        exitCode: 0,
        signal: null,
        pid: 512,
        stderr: '',
        stdout: JSON.stringify({
          protocolVersion: ACCOUNT_FILE_HELPER_PROTOCOL_VERSION,
          ok: false,
          op: 'write',
          worker: { pid: 512, uid: account.uid, gid: account.gid, cgroup: '/xpanel.slice/xpanel-29101.slice' },
          error: { code: helperCode, errno, errnoName, message: `kernel rejected write: ${errnoName}` },
        }),
      }),
    })
    const manager = new JailedFileManager(home, 10, { account, runner })
    await assert.rejects(
      () => manager.writeText('public_html/private.txt', 'must-not-write'),
      (err: unknown) => isXpanelError(err) && err.code === expected && err.detail.errnoName === errnoName,
    )
    assert.equal(await readFile(join(home, 'public_html', 'private.txt'), 'utf8'), 'tenant-content-marker')
  })

  it('terminates a child process that exceeds maxStdoutBytes', async () => {
    const runner = new NativeAccountFileRunner({
      binaryPath: '/opt/xpanel/bin/xpanel-account-files',
      maxStdoutBytes: 2048,
      spawner: nodeScriptSpawner('process.stdout.write("x".repeat(16384))'),
    })
    const manager = new JailedFileManager(home, 'unlimited', { account, runner })
    await assert.rejects(() => manager.readText('public_html/private.txt'), code('CONFIG_TEST_FAILED'))
  })

  it('terminates a hanging child process when timeoutMs expires', async () => {
    const runner = new NativeAccountFileRunner({
      binaryPath: '/opt/xpanel/bin/xpanel-account-files',
      timeoutMs: 100,
      spawner: nodeScriptSpawner('setTimeout(() => {}, 10000)'),
    })
    const manager = new JailedFileManager(home, 'unlimited', { account, runner })
    await assert.rejects(() => manager.readText('public_html/private.txt'), code('SERVICE_UNAVAILABLE'))
  })
})
