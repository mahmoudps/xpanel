import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseIssuedLifecycleAuditJournal } from './lifecycle-issued-audit.mjs'

// Protocol regression, not native qualification. Execute the real publication/file
// functions and the pinned OLD admission functions against a power-loss filesystem seam.
// The seam grants no production capability, starts no service and opens no SQLite file.
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const declarations = (text: string, names: string[]) => {
  const ast = ts.createSourceFile('fixture.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  return names.map(name => {
    const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    if (!node) throw new Error('Missing actual function ' + name)
    return node.getText(ast).replace(/^export /, '')
  }).join('\n')
}
const bind = (body: string, exports: string[], dependencies: Record<string, unknown>) =>
  new Function(...Object.keys(dependencies), body + '\nreturn {' + exports.join(',') + '}')(...Object.values(dependencies))
const managedText = source('./lifecycle-managed-files.mjs'), nativeText = source('./lifecycle-root-safety.mjs')
const oldText = source('./fixtures/lifecycle-admission-legacy.txt'), issuedText = source('./lifecycle-issued-audit.mjs')
const managedNames = ['syncManagedDirectory', 'captureManagedFile', 'managedPathAbsent', 'replaceManagedFile']
const managedBodies = declarations(managedText, managedNames)
const denialBody = declarations(nativeText, ['persistInitialInstallationBeforeAudit'])
  .replace("await import('./lifecycle-admission.mjs')", 'admission')
const issueBody = declarations(issuedText, ['writeIssuedLifecycleAuditJournal'])
  .replace("await import('./lifecycle-root-safety.mjs')", 'native')
const oldNames = ['parseLifecycleBarrier', 'readLifecycleBarrier', 'assertLifecycleWritesAllowed', 'admittedWriter']
const oldBodies = declarations(oldText, oldNames)
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
const ROOT = '/var/lib/xpanel-lifecycle', barrier = ROOT + '/writer-barrier.json'
const id = '11111111-1111-4111-8111-111111111111', principal = '22222222-2222-4222-8222-222222222222'

type Entry = { bytes: Buffer; mode: number; inode: number; directory?: boolean }
async function attempt(crashAt: number, renameSurvives: boolean) {
  let sequence = 0, inode = 3, boundary = 0, crashed = false, enteredGuard = false, appended = false
  let named = new Map<string, Entry>([[ROOT, { bytes: Buffer.alloc(0), mode: 0o700, inode: 1, directory: true }]])
  let durable = new Map(named)
  const checkpoint = (label: string, effect: () => void) => {
    const step = () => { if (++boundary === crashAt) { crashed = true; throw new Error('crash:' + label) } }
    step(); effect(); step()
  }
  const missing = () => fail('ENOENT')
  const entry = (path: string) => named.get(path) ?? missing()
  const stat = (value: Entry) => ({ uid: 0n, gid: 0n, dev: 1n, ino: BigInt(value.inode), mode: BigInt(value.mode), size: BigInt(value.bytes.length),
    isSymbolicLink: () => false, isFile: () => !value.directory, isDirectory: () => !!value.directory })
  const lstat = async (path: string) => stat(entry(path))
  const assertOwnedFile = async (expected: {path:string;inode:string;mode:number;sha256:string}) => {
    const value = entry(expected.path)
    if (String(value.inode) !== expected.inode || value.mode !== expected.mode || sha(value.bytes) !== expected.sha256) fail('changed')
  }
  const withTrustedDirectory = async (_path: string, callback: (pin: {verify:()=>Promise<void>}) => unknown) => callback({ verify: async () => {} })
  const withTrustedFile = async (path: string, options: {exactMode:number}, callback: (pin:{bytes:Buffer})=>unknown) => {
    const value = entry(path); if (value.mode !== options.exactMode) fail('mode')
    return callback({ bytes: value.bytes })
  }
  const open = async (path: string, flags: number, mode?: number) => {
    if (flags & constants.O_CREAT) { if (named.has(path)) fail('EEXIST'); named.set(path, { bytes: Buffer.alloc(0), mode: mode!, inode: inode++ }) }
    const value = entry(path)
    return {
      chown: async () => {}, chmod: async (next: number) => { value.mode = next }, close: async () => {}, stat: async () => stat(value),
      writeFile: async (bytes: Buffer) => { value.bytes = Buffer.from(bytes) },
      sync: async () => checkpoint((value.directory ? 'directory-fsync:' : 'file-fsync:') + path, () => {
        if (value.directory) durable = new Map([...named].map(([key, item]) => [key, { ...item, bytes: Buffer.from(item.bytes) }]))
      }),
    }
  }
  const rename = async (from: string, to: string) => checkpoint('rename:' + to, () => {
    named.set(to, entry(from)); named.delete(from)
    if (renameSurvives) durable = new Map([...named].map(([key, value]) => [key, { ...value, bytes: Buffer.from(value.bytes) }]))
  })
  const managed = bind(managedBodies, managedNames, { constants, requireLinuxRoot: () => {}, fail, lstat, open, rename,
    dirname: (path: string) => path.slice(0, path.lastIndexOf('/')), randomUUID: () => String(++sequence),
    managedBytesHash: sha, withTrustedDirectory, assertOwnedFile,
    readTrustedFile: async (path: string) => ({ info: stat(entry(path)), bytes: entry(path).bytes, sha256: sha(entry(path).bytes) }) })
  const origin = { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: principal }
  const binding = { purpose: 'host.lifecycle.intent', jobId: id, requestFingerprint: 'a'.repeat(64), action: 'lifecycle.upgrade', principalId: principal }
  const job = { id, referenceCode: 'XP-JOB-2026-000001', kind: binding.action, actor: 'root', detail: { lifecycleIntent: binding } }
  const headValue = { sequence: 4, phase: 'retired', operationId: principal }, headBytes = JSON.stringify(headValue) + '\n'
  const head = { value: headValue, bytes: headBytes, hash: sha(headBytes) }
  const initial: { phase:string;capability:object;dbHandle:{db:object};dbProof:{principal:{username:string}};origin:typeof origin;
    issuedFence?:{bytes:Buffer;entry:{sha256:string}};plannedInstallation?:{entry:{sha256:string}} } =
    { phase: 'writable', capability: {}, dbHandle: { db: {} }, dbProof: { principal: { username: 'root' } }, origin }
  const denial = bind(denialBody, ['persistInitialInstallationBeforeAudit'], { ROOT, sha, Buffer, fail,
    assertLifecycleBootstrapHeld: async () => {}, admission: { assertLifecycleBootstrapExclusivePhysicalHeld: async () => {} },
    assertHostOperationGuardHeld: async () => {}, bindingFor: () => ({}), getDurableJob: async () => job,
    initialInstallationValue: async () => ({ operationId: id, kind: 'xpanel-initial-upgrade-admission' }),
    replaceManagedFile: managed.replaceManagedFile, assertOwnedFile })
  let context: Record<string, unknown>
  const issuance = bind(issueBody, ['writeIssuedLifecycleAuditJournal'], { ROOT: ROOT + '/issued-audit', Buffer, requireLinuxRoot: () => {},
    native: { assertLifecycleAuditIssuanceHeld: async () => {}, getLifecycleAuditIssuanceInfo: () => context! }, parseIssuedLifecycleAuditJournal,
    ensureManagedPrivateDirectory: async (path: string) => { named.set(path, { bytes: Buffer.alloc(0), mode: 0o700, inode: inode++, directory: true }) },
    replaceManagedFile: managed.replaceManagedFile, managedPathAbsent: managed.managedPathAbsent, captureManagedFile: managed.captureManagedFile,
    parseSelector: () => { throw new Error('fixture begins without prior selector') } })
  try {
    await denial.persistInitialInstallationBeforeAudit(initial, {}, job, binding, {}, head)
    enteredGuard = true
    context = { job: { id, reference: job.referenceCode }, origin, intentBinding: binding,
      parentHead: { value: headValue, bytes: headBytes, sha256: head.hash }, parentBarrier: null,
      fence: { value: JSON.parse(initial.issuedFence!.bytes.toString()), bytes: initial.issuedFence!.bytes.toString(), sha256: initial.issuedFence!.entry.sha256 },
      baseline: { operationId: id, path: ROOT + '/admission-' + id + '.json', sha256: initial.plannedInstallation!.entry.sha256 },
      helper: { releaseRoot: '/opt/xpanel/releases/0.2.0', archiveSha256: 'b'.repeat(64) }, coordinatorReceiptSha256: 'c'.repeat(64),
      issuer: { pid: 123, start: '456', bootId: principal, coordinatorUnit: 'xpanel-lifecycle.service' },
      accountLifetimeSha256: 'd'.repeat(64), sourceImages: [initial.plannedInstallation!.entry], issuedAt: '2026-11-03T00:00:00.000Z' }
    await issuance.writeIssuedLifecycleAuditJournal({}, { schemaVersion: 1, purpose: 'issued-lifecycle-append', binding, origin })
    appended = true
  } catch (error) { if (!crashed) throw error }
  // Crash drops volatile rename state. Both allowed persistence outcomes are exercised.
  named = durable
  const store = new AsyncLocalStorage()
  const old = bind('let activeWriters=0;\n' + oldBodies, ['admittedWriter'], { LIFECYCLE_ROOT: ROOT, LIFECYCLE_BARRIER: barrier,
    LIFECYCLE_LOCK: ROOT + '/writer.lock', UUID: /^[a-f0-9-]{36}$/, SHA: /^[a-f0-9]{64}$/, fail, lstat, withTrustedDirectory, withTrustedFile,
    installExclusiveScope: store, exclusiveScope: store, writerScope: store, withKernelLock: async (_exclusive: boolean, work:()=>unknown) => work() })
  let oldAuditEntered = false
  try { await old.admittedWriter(async () => { oldAuditEntered = true }) } catch { /* Barrier denial is the expected refusal. */ }
  if (named.has(barrier)) expect(oldAuditEntered).toBe(false)
  if (enteredGuard || appended || named.has(ROOT + '/issued-audit/LATEST')) {
    expect(named.has(barrier)).toBe(true); expect(oldAuditEntered).toBe(false)
  }
  return boundary
}

describe('old writer denial across issued audit publication crashes', () => {
  it('fences the exact legacy admission before guard/plan publication at every fsync and rename boundary', async () => {
    expect(sha(oldText)).toBe('2137ac7f18bd889ecad1fea94ccffe2fb614c1327179c0953a73f315f7d2f3b1')
    const boundaries = await attempt(0, false)
    expect(boundaries).toBeGreaterThan(0)
    for (let crash = 1; crash <= boundaries; crash++) {
      await attempt(crash, false)
      await attempt(crash, true)
    }
  })
})
