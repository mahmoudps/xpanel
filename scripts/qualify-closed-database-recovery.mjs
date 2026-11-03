// @slow: explicit native qualification on a prepared disposable guest. Not part of the fast lane.
// Draft only. The fixture must already hold a genuine pending upgrade and authenticated coordinator/helper.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, readlink } from 'node:fs/promises'
import { once } from 'node:events'

const ROOT = '/var/lib/xpanel-lifecycle', DATABASE = '/var/lib/xpanel/control.db'
const fixturePath = '/var/lib/xpanel-native-qualification/closed-recovery.json'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0 || process.version !== 'v26.12.1'
  || process.env.XPANEL_NATIVE_QUALIFICATION !== 'closed-database-recovery') throw new Error('explicit disposable native fixture required')
for (const path of ['/var/lib/xpanel-native-qualification', fixturePath]) {
  const info = await lstat(path)
  assert.equal(info.uid, 0); assert.equal(info.gid, 0); assert.equal(info.isSymbolicLink(), false)
  assert.equal(info.mode & 0o7777, path === fixturePath ? 0o600 : 0o700)
}
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'xpanel-disposable-closed-recovery-fixture')
assert.equal(fixture.machineId, (await readFile('/etc/machine-id', 'utf8')).trim())
assert.match(fixture.helperRoot, /^\/opt\/xpanel\/releases\/[0-9]+\.[0-9]+\.[0-9]+$/)
assert.match(fixture.expectedCurrent, /^\/opt\/xpanel\/releases\/[0-9]+\.[0-9]+\.[0-9]+$/)
assert.match(fixture.archiveSha256, /^[a-f0-9]{64}$/)
assert.match(fixture.expectedManifestSha256, /^[a-f0-9]{64}$/)
assert.equal(fixture.nodePath, process.execPath)
const headBefore = await readFile(ROOT + '/HEAD'), barrierBefore = await readFile(ROOT + '/writer-barrier.json')
assert.equal(JSON.parse(headBefore).phase, 'pending')
assert.equal(JSON.parse(barrierBefore).operationId, JSON.parse(headBefore).operationId)
const assertAbsent = async path => { try { await lstat(path); throw new Error('unexpected sidecar') } catch (error) { if (error.code !== 'ENOENT') throw error } }
for (const suffix of ['-wal', '-shm', '-journal']) await assertAbsent(DATABASE + suffix)
const initial = await lstat(DATABASE, { bigint: true })
assert(initial.size < 256n * 1024n * 1024n)
const dbBefore = sha(await readFile(DATABASE))
const run = async operationId => {
  const child = spawn(process.execPath, [fixture.helperRoot + '/scripts/root-operator-entry.mjs', '--kind=recover', '--archive-sha256=' + fixture.archiveSha256, '--operation-id=' + operationId],
    { cwd: fixture.helperRoot, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', size = 0, timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 180000)
  const escalation = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 185000)
  child.stdout.on('data', chunk => { size += chunk.length; if (size > 16384) child.kill('SIGKILL'); else output += chunk })
  child.stderr.on('data', chunk => { size += chunk.length; if (size > 16384) child.kill('SIGKILL') })
  const [code, signal] = await once(child, 'close')
  clearTimeout(timer); clearTimeout(escalation)
  assert.equal(timedOut, false); assert.equal(signal, null)
  return { code, value: output.trim() ? JSON.parse(output) : null }
}

// A foreign inherited DB FD is real even though every owned service may already be stopped.
const retained = await open(DATABASE, constants.O_RDONLY | constants.O_NOFOLLOW)
const blocker = spawn(process.execPath, ['--input-type=module', '-e', "process.stdout.write('HELD\\n');setInterval(()=>{},1000)"],
  { stdio: ['ignore', 'pipe', 'ignore', retained.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
await retained.close()
const blockerClosed = once(blocker, 'close')
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { blocker.kill('SIGKILL'); reject(new Error('descriptor fixture start timed out')) }, 5000)
    blocker.once('error', error => { clearTimeout(timer); reject(error) })
    blocker.stdout.once('data', chunk => { clearTimeout(timer); chunk.toString() === 'HELD\n' ? resolve() : reject(new Error('descriptor fixture changed')) })
    blocker.once('close', () => { clearTimeout(timer); reject(new Error('descriptor fixture ended')) })
  })
  const refused = await run(randomUUID())
  assert.notEqual(refused.code, 0)
  assert.equal(sha(await readFile(DATABASE)), dbBefore)
  assert.deepEqual(await readFile(ROOT + '/HEAD'), headBefore)
  assert.deepEqual(await readFile(ROOT + '/writer-barrier.json'), barrierBefore)
  for (const suffix of ['-wal', '-shm', '-journal']) await assertAbsent(DATABASE + suffix)
} finally { blocker.kill('SIGKILL'); await blockerClosed }

const operationId = randomUUID(), recovered = await run(operationId)
assert.equal(recovered.code, 0); assert.equal(recovered.value.operationId, operationId); assert.equal(recovered.value.phase, 'succeeded')
const head = JSON.parse(await readFile(ROOT + '/HEAD', 'utf8'))
assert.equal(head.phase, 'retired'); assert.equal(head.kind, 'recover'); assert.notEqual(head.operationId, JSON.parse(headBefore).operationId)
await assertAbsent(ROOT + '/writer-barrier.json')
assert.equal(await readlink('/opt/xpanel/current'), fixture.expectedCurrent)
const installed = JSON.parse(await readFile(ROOT + '/installation.json', 'utf8'))
assert.equal(installed.status, 'active'); assert.equal(installed.source.manifestSha256, fixture.expectedManifestSha256)
const terminal = JSON.parse(await readFile(ROOT + '/terminal/' + head.operationId + '.json', 'utf8'))
assert.equal(terminal.operationId, head.operationId)
process.stdout.write(JSON.stringify({ lane: 'native-closed-database-recovery', foreignDescriptorRefusedWithoutDbWrite: true,
  recovered: true, operationId, current: fixture.expectedCurrent }) + '\n')
