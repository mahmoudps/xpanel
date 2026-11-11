import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { deliveryEvidence, deliveryTarget } from '../packages/catalog/src/data/delivery.ts'
import { specs, tools } from '../packages/catalog/src/data/index.ts'
import { assessDelivery, PROFILE_EXCLUSIONS } from '../packages/catalog/src/delivery.ts'
import { PHASE1_TOOL_PROBES } from '../packages/catalog/src/host-qualification.ts'
import { identifySource, REQUIRED_PROFILES, sha256, SOURCE_ALGORITHM } from './evidence/identity.mjs'
import { computeSourceDigest } from './evidence/shared.mjs'
import { aggregateDelivery, DELIVERY_PATH, publishedSourceFingerprint, renderDeliveryModule } from './qualification-aggregate.mjs'
import { externalDnsCheck, externalTlsCheck } from './qualification-drivers/kit.mjs'
import { auditLogChecks, auditStore } from './qualification-drivers/s6.mjs'
import { QUALIFICATION_INVENTORY, qualificationPlan, qualificationRequirements, RUNNER_SLOTS, slotCheckIds } from './qualification-plan.mjs'
import { dryRun, observation, parseRunnerArguments, receiptsForObservation, ROOT, unitChecks, withRootSession } from './qualification-runner.mjs'

const TOOL = 'audit-log'
const osByProfile: Record<string, { id: string; versionId: string; name: string }> = {
  'ubuntu-22.04': { id: 'ubuntu', versionId: '22.04', name: 'Ubuntu' },
  'ubuntu-24.04': { id: 'ubuntu', versionId: '24.04', name: 'Ubuntu' },
  'almalinux-9': { id: 'almalinux', versionId: '9.6', name: 'AlmaLinux' },
  'rocky-9': { id: 'rocky', versionId: '9.6', name: 'Rocky Linux' },
  'centos-stream-9': { id: 'centos', versionId: '9', name: 'CentOS Stream' },
}
const inScope = tools.filter(tool => tool.status !== 'out-of-scope').map(tool => tool.id)
const clone = <T>(value: T): T => structuredClone(value)
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep) || !path.split(sep).at(-1)!.startsWith('xpanel-qualification-test-')) throw new Error('Unsafe test fixture cleanup')
    rmSync(path, { recursive: true, force: true })
  }
})

function targetDocument({ artifact = 'artifact', delivery = renderDeliveryModule([], null) } = {}) {
  const files = [
    { path: 'apps/api/src/main.ts', bytes: 4, sha256: sha256('main') },
    { path: DELIVERY_PATH, bytes: Buffer.byteLength(delivery), sha256: sha256(delivery) },
    { path: 'pnpm-lock.yaml', bytes: 4, sha256: sha256('lock') },
  ]
  const source = { algorithm: SOURCE_ALGORITHM, commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, node: '26.12.1', files, sourceFingerprint: computeSourceDigest(files), lockfileSha256: sha256('lock') }
  const target = { sourceFingerprint: source.sourceFingerprint, artifactSha256: sha256(artifact), supportedProfiles: [...REQUIRED_PROFILES] }
  const document = { schemaVersion: 1, kind: 'xpanel-artifact-provenance', source: { algorithm: source.algorithm, commit: source.commit, sourceFingerprint: source.sourceFingerprint }, artifact: { sha256: target.artifactSha256, bytes: 8 } }
  return { schemaVersion: 1, kind: 'xpanel-verification-target', target, source, provenance: { sha256: sha256(JSON.stringify(document)), document } }
}
type Target = ReturnType<typeof targetDocument>

const passing = (slot: string) => slotCheckIds(TOOL, slot).map((id: string) => ({ id, status: 'passed', observed: { ok: true } }))
const observe = (document: Target, profile: string, slot: string, over: Record<string, unknown> = {}) => observation({
  toolId: TOOL, slot, runId: 'q1', targetDocument: document, profile, osRelease: osByProfile[profile], executor: slot === 'unit' ? 'fake' : 'real',
  startedAt: new Date(Date.now() - 1000).toISOString(), checks: passing(slot), cleanup: { ok: true, errors: [] },
  ...(slot === 'external' ? { observer: { independent: true, identity: 'observer-a' }, hostReport: { sha256: 'c'.repeat(64), runId: 'q1' } } : {}), ...over,
})
const bytesOf = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

/** Complete audit-log evidence on the given profiles, written as raw receipts and reports under a fresh evidence root. */
function evidence(document: Target, profiles: readonly string[] = REQUIRED_PROFILES) {
  const root = mkdtempSync(join(tmpdir(), 'xpanel-qualification-test-'))
  temporary.push(root)
  const requirement = qualificationRequirements([TOOL])[0]
  const receipts: any[] = [], rows: any[] = []
  for (const profile of profiles) for (const slot of Object.keys(RUNNER_SLOTS)) {
    const report = observe(document, profile, slot), reportBytes = bytesOf(report)
    for (const receipt of receiptsForObservation(report, reportBytes, (item: { stage: string; environment: string }) => `${profile}-${item.stage}-${item.environment}.report.json`, document)) {
      const path = `${receipt.receiptId}.receipt.json`, receiptBytes = bytesOf(receipt)
      writeFileSync(join(root, receipt.report.path), reportBytes); writeFileSync(join(root, path), receiptBytes)
      const total = requirement.checks[receipt.environment].length
      receipts.push({ path, sha256: sha256(receiptBytes), bytes: receiptBytes.length, receipt, report: { path: receipt.report.path, sha256: sha256(reportBytes), bytes: reportBytes.length, kind: 'checks-v1', counts: { total, passed: total, failed: 0, skipped: 0 } } })
      rows.push({ toolId: TOOL, stage: receipt.stage, acceptance: receipt.acceptance, result: receipt.result, sourceFingerprint: receipt.sourceFingerprint, artifactSha256: receipt.artifactSha256, environment: receipt.environment, profile, executor: receipt.executor, runArtifact: path, runArtifactSha256: sha256(receiptBytes), observedAt: receipt.finishedAt })
    }
  }
  return { root, receipts, rows }
}
const bundleOf = (document: Target, receipts: any[], rows: any[]) => ({ schemaVersion: 1, kind: 'xpanel-capability-evidence', target: document.target, source: document.source, provenance: document.provenance, requirements: qualificationRequirements([TOOL]), evidence: rows, receipts })

/**
 * Full case names as Vitest reports them: the enclosing describe titles and the test title, joined by spaces. Nesting
 * comes from indentation, the repository's style, so a title under another describe of the same file does not match.
 */
const caseNames = (text: string): string[] => {
  const stack: { indent: number; title: string }[] = [], names: string[] = []
  for (const line of text.split('\n')) {
    const match = /^(\s*)(describe|it|test)\b[^(]*(?:\([^)]*\))?[^(]*\(\s*(['"`])((?:\\.|(?!\3).)*)\3\s*,/.exec(line)
    if (!match) continue
    const indent = match[1]!.length, title = match[4]!.replace(/\\(.)/g, '$1')
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop()
    if (match[2] === 'describe') stack.push({ indent, title })
    else names.push([...stack.map(item => item.title), title].join(' '))
  }
  return names
}

describe('reviewed qualification inventory', { tags: ['unit'] }, () => {
  it('reads a case name only under its own describe', () => {
    const text = "describe('reader', () => {\n  it('reads', () => {})\n})\ndescribe('workspace', { tags: ['unit'] }, () => {\n  it('sends the owner\\'s list', () => {})\n})\n"
    expect(caseNames(text)).toEqual(['reader reads', "workspace sends the owner's list"])
  })

  it('drives only in-scope catalog tools with their exact acceptance criteria and existing unit cases', () => {
    const requirements = qualificationRequirements()
    expect(requirements.map((item: { toolId: string }) => item.toolId)).toEqual(Object.keys(QUALIFICATION_INVENTORY))
    for (const requirement of requirements) {
      expect(inScope).toContain(requirement.toolId)
      expect(requirement.acceptance).toBe(specs.find(spec => spec.id === requirement.toolId)!.acceptance)
      const ids = Object.keys(RUNNER_SLOTS).flatMap(slot => slotCheckIds(requirement.toolId, slot))
      expect(new Set(ids).size).toBe(ids.length)
      for (const item of QUALIFICATION_INVENTORY[requirement.toolId].unit) expect(caseNames(readFileSync(resolve(ROOT, item.file), 'utf8')), `${requirement.toolId}: ${item.file}`).toContain(item.name)
    }
  })

  it('plans every in-scope tool and reports those without a driver as not run', () => {
    const plan = qualificationPlan('host')
    expect(plan.tools.find((item: { toolId: string }) => item.toolId === TOOL)).toEqual({ toolId: TOOL, checks: slotCheckIds(TOOL, 'host'), readiness: PHASE1_TOOL_PROBES[TOOL], requires_qualification_admission: false, shared: false })
    expect(plan.notRun).toHaveLength(inScope.length - plan.tools.length)
    // A driven tool without readiness probes would have its published evidence demoted on every host.
    expect(plan.tools.every((item: { readiness: unknown }) => Array.isArray(item.readiness))).toBe(true)
    expect(plan.notRun.find((item: { toolId: string }) => item.toolId === 'connect-devices')!.readiness).toBeNull()
    expect([...plan.tools, ...plan.notRun].find((item: { toolId: string }) => item.toolId === 'git-version-control')!.readiness).toEqual(['control-plane', 'files', 'systemd'])
    expect(plan.notRun.every((item: { reason: string }) => item.reason === 'no reviewed acceptance driver')).toBe(true)
    expect(qualificationPlan('unit', `${TOOL},connect-devices`).notRun.map((item: { toolId: string }) => item.toolId)).toEqual(['connect-devices'])
    const outOfScope = tools.find(tool => tool.status === 'out-of-scope')!.id
    for (const requested of ['no-such-tool', `${TOOL},${TOOL}`, outOfScope, '']) expect(() => qualificationPlan('host', requested)).toThrow()
    expect(() => qualificationPlan('desktop')).toThrow(/--slot/)
    expect(() => qualificationRequirements(['connect-devices'])).toThrow(/No reviewed qualification driver/)
  })
})

describe('native qualification runner', { tags: ['unit'] }, () => {
  it('dry runs every driver on all four slots and sends nothing', () => {
    const document = targetDocument(), driven = Object.keys(QUALIFICATION_INVENTORY)
    const ubuntuDriven = driven.filter(id => !PROFILE_EXCLUSIONS[id]?.profiles.includes('ubuntu-22.04'))
    for (const slot of Object.keys(RUNNER_SLOTS)) {
      const plan = dryRun(parseRunnerArguments([`--slot=${slot}`, '--target=target.json', '--run-id=q1', '--dry-run']), () => document, () => 'ID=ubuntu\nVERSION_ID="22.04"\n')
      expect(plan).toMatchObject({ status: 'dry_run', proofExecuted: false, notRun: inScope.length - ubuntuDriven.length })
      expect(plan.tools.map((item: { toolId: string }) => item.toolId).sort()).toEqual([...ubuntuDriven].sort())
      expect(plan.tools.filter((item: { readiness: unknown }) => item.readiness === null)).toEqual([])
    }
  })

  it('refuses an incomplete or unsafe invocation and lets a dry run list what is missing', () => {
    const base = ['--slot=host', '--target=target.json', '--run-id=q1']
    expect(() => parseRunnerArguments(base)).toThrow(/Missing --target-sha256/)
    expect(() => parseRunnerArguments(['--slot=desktop', '--target=t', '--run-id=q1', '--dry-run'])).toThrow(/--slot/)
    expect(() => parseRunnerArguments(['--slot=host', '--target=t', `--run-id=${'a'.repeat(61)}`, '--dry-run'])).toThrow(/run ID/)
    expect(() => parseRunnerArguments([...base, '--dry-run', '--target-sha256=abc'])).toThrow(/SHA-256/)
    const document = targetDocument()
    const ubuntuDriven = Object.keys(QUALIFICATION_INVENTORY).filter(id => !PROFILE_EXCLUSIONS[id]?.profiles.includes('ubuntu-22.04'))
    const plan = dryRun(parseRunnerArguments([...base, '--dry-run']), () => document, () => 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\n')
    expect(plan).toMatchObject({ status: 'dry_run', proofExecuted: false, profile: 'ubuntu-22.04', profileInTarget: true, notRun: inScope.length - ubuntuDriven.length })
    expect(plan.tools.find((item: { toolId: string }) => item.toolId === TOOL)).toMatchObject({ toolId: TOOL, checks: slotCheckIds(TOOL, 'host') })
    expect(plan.withoutReadiness).toEqual(inScope.filter(id => PHASE1_TOOL_PROBES[id] === undefined))
    expect(plan.missingOptions).toEqual(['target-sha256', 'binding', 'binding-sha256', 'artifact', 'origin', 'address', 'credential-file', 'output'])
    expect(dryRun(parseRunnerArguments([...base, '--dry-run']), () => document, () => 'ID=debian\nVERSION_ID="12"\n').profile).toBeNull()
  })

  it('backs exactly the reviewed slots of a passed observation with validated receipts', () => {
    const document = targetDocument()
    const report = observe(document, 'rocky-9', 'host'), bytes = bytesOf(report)
    const receipts = receiptsForObservation(report, bytes, (slot: { environment: string }) => `host-${slot.environment}.report.json`, document)
    expect(receipts.map((receipt: any) => [receipt.stage, receipt.environment, receipt.executor, receipt.report.path])).toEqual([['integrated', 'http', 'real', 'host-http.report.json'], ['verified', 'linux', 'real', 'host-linux.report.json']])
    const unit = observe(document, 'rocky-9', 'unit')
    expect(receiptsForObservation(unit, bytesOf(unit), () => 'unit.report.json', document).map((receipt: any) => receipt.executor)).toEqual(['fake'])
    const external = observe(document, 'rocky-9', 'external')
    expect(receiptsForObservation(external, bytesOf(external), () => 'external.report.json', document)[0].observer).toEqual({ independent: true, identity: 'observer-a' })
  })

  it('writes no receipt for a failed, blocked, unclean, fake or altered observation', () => {
    const document = targetDocument(), path = () => 'r.report.json'
    const failed = observe(document, 'rocky-9', 'host', { checks: passing('host').map((item: any, index: number) => index === 2 ? { ...item, status: 'failed' } : item) })
    expect(failed.status).toBe('failed')
    const missing = observe(document, 'rocky-9', 'host', { checks: passing('host').slice(1) })
    expect(missing.status).toBe('blocked')
    const extra = observe(document, 'rocky-9', 'host', { checks: [...passing('host'), { id: 'AL-UNREVIEWED', status: 'passed', observed: {} }] })
    expect(extra).toMatchObject({ status: 'blocked', failure: expect.stringContaining('AL-UNREVIEWED') })
    const unclean = observe(document, 'rocky-9', 'host', { cleanup: { ok: false, errors: ['session'] } })
    expect(unclean.status).toBe('failed')
    for (const report of [failed, missing, extra, unclean]) expect(() => receiptsForObservation(report, bytesOf(report), path, document)).toThrow(/Incomplete observations/)
    const fake = observe(document, 'rocky-9', 'host', { executor: 'fake' })
    expect(() => receiptsForObservation(fake, bytesOf(fake), path, document)).toThrow(/real execution/)
    const report = observe(document, 'rocky-9', 'host')
    expect(() => receiptsForObservation(report, bytesOf({ ...report, profile: 'rocky-9 ' }), path, document)).toThrow(/bytes differ/)
    expect(() => receiptsForObservation(observe(document, 'ubuntu-24.04', 'host', { osRelease: osByProfile['rocky-9'] }), bytesOf(observe(document, 'ubuntu-24.04', 'host', { osRelease: osByProfile['rocky-9'] })), path, document)).toThrow()
  })

  it('maps reviewed unit cases to checks only by exact file and full name in a successful run', () => {
    const cases = QUALIFICATION_INVENTORY[TOOL].unit
    const suite = (items: typeof cases) => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [...new Set(items.map(item => item.file))].map(file => ({ name: resolve(ROOT, file), assertionResults: items.filter(item => item.file === file).map(item => ({ ancestorTitles: [item.name.split(' ').slice(0, 4).join(' ')], title: item.name.split(' ').slice(4).join(' '), status: 'passed', duration: 2 })) })) })
    expect(unitChecks(TOOL, suite(cases), ROOT).map((item: any) => item.status)).toEqual(cases.map(() => 'passed'))
    expect(unitChecks(TOOL, suite(cases.slice(1)), ROOT)[0]).toMatchObject({ status: 'failed', observed: { status: 'missing' } })
    expect(unitChecks(TOOL, { ...suite(cases), success: false }, ROOT).every((item: any) => item.status === 'failed')).toBe(true)
    expect(unitChecks(TOOL, null, ROOT).every((item: any) => item.status === 'failed')).toBe(true)
  })

  it('signs in normally, confirms sign-out by a refused read and never keeps the password', async () => {
    let active = false
    const cookie = '__Host-xwhm_session=abc; Path=/; Secure; HttpOnly; SameSite=Strict'
    const request = async (path: string, options: { cookie?: string } = {}) => {
      if (path === '/api/auth/login') { active = true; return { status: 200, data: { principal: { kind: 'root' }, entryPoint: 'xwhm', csrfToken: 'token', passwordChangeRequired: false }, setCookie: [cookie] } }
      if (path === '/api/auth/logout') { active = false; return { status: 200, data: { ok: true }, setCookie: [] } }
      return options.cookie && active ? { status: 200, data: { entries: [] }, setCookie: [] } : { status: 401, data: { code: 'UNAUTHENTICATED' }, setCookie: [] }
    }
    const login = { username: 'root', password: 'qualification-secret' }
    const result = await withRootSession({ request, login, prefix: 'AL', probe: '/api/audit?limit=1', anonymous: true, run: async (read: any) => [{ id: 'AL-ROWS', status: (await read({ limit: '1' })).status === 200 ? 'passed' : 'failed', observed: {} }] })
    expect(result.checks.map((item: any) => [item.id, item.status])).toEqual([['AL-ANONYMOUS-DENIED', 'passed'], ['AL-ROWS', 'passed'], ['AL-SESSION-REVOKED', 'passed']])
    expect(result).toMatchObject({ cleanup: { ok: true, errors: [] }, failure: null })
    expect(login.password).toBe('')
    const refused = await withRootSession({ request: async (path: string) => path === '/api/auth/login' ? { status: 401, data: { code: 'UNAUTHENTICATED' }, setCookie: [] } : { status: 401, data: { code: 'UNAUTHENTICATED' }, setCookie: [] }, login: { username: 'root', password: 'x' }, prefix: 'AL', probe: '/api/audit?limit=1', anonymous: false, run: async () => [] })
    expect(refused).toMatchObject({ cleanup: { ok: true }, failure: expect.any(String) })
    const leaked = await withRootSession({ request: async (path: string) => path === '/api/auth/login' ? { status: 200, data: { principal: { kind: 'root' }, entryPoint: 'xwhm', csrfToken: 'token', passwordChangeRequired: false }, setCookie: [cookie] } : { status: 200, data: { ok: true, entries: [] }, setCookie: [] }, login: { username: 'root', password: 'x' }, prefix: 'AL', probe: '/api/audit?limit=1', anonymous: false, run: async () => [] })
    expect(leaked.cleanup).toMatchObject({ ok: false, leftovers: { sessions: ['qualification-session-outcome-unknown'] } })
  })
})

const stored = Array.from({ length: 6 }, (_, index) => ({ id: String(6 - index), at: `2026-11-07T00:00:0${6 - index}.000Z`, actor: 'root', action: index % 2 ? 'auth.login' : 'account.create', target: 'server', outcome: 'ok' }))

describe('audit-log acceptance driver', { tags: ['unit'] }, () => {
  const reader = (rows = stored, filters = true) => async (params: Record<string, string>) => {
    const selected = rows.filter(row => (!filters || params.action === undefined || row.action === params.action) && (params.before === undefined || Number(row.id) < Number(params.before)))
    return { status: 200, data: { entries: selected.slice(0, Number(params.limit)).map(row => ({ ...row, detail: {} })) } }
  }
  const oracle = (rows = stored) => ({ maxId, action, limit }: { maxId: string; action?: string; limit: number }) => rows.filter(row => Number(row.id) <= Number(maxId) && (action === undefined || row.action === action)).slice(0, limit)
  const statuses = (checks: any[]) => Object.fromEntries(checks.map(item => [item.id, item.status]))

  it('passes listing, the store comparison, the action filter and the next keyset page', async () => {
    expect(statuses(await auditLogChecks(reader(), 'AL', oracle()))).toEqual({ 'AL-ROWS': 'passed', 'AL-STORED-ROWS': 'passed', 'AL-ACTION-FILTER': 'passed', 'AL-OLDER-PAGE': 'passed' })
    expect(Object.keys(statuses(await auditLogChecks(reader(), 'AL-EXTERNAL')))).toEqual(['AL-EXTERNAL-ROWS', 'AL-EXTERNAL-ACTION-FILTER', 'AL-EXTERNAL-OLDER-PAGE'])
  })

  it('fails a store mismatch or an ignored filter and blocks the older page without enough rows', async () => {
    expect(statuses(await auditLogChecks(reader(), 'AL', oracle(stored.map(row => ({ ...row, outcome: 'denied' })))))['AL-STORED-ROWS']).toBe('failed')
    expect(statuses(await auditLogChecks(reader(stored, false), 'AL', oracle()))['AL-ACTION-FILTER']).toBe('failed')
    expect(statuses(await auditLogChecks(reader(stored.slice(4)), 'AL'))['AL-OLDER-PAGE']).toBe('blocked')
    expect(statuses(await auditLogChecks(async () => ({ status: 500, data: null }), 'AL'))).toEqual({ 'AL-ROWS': 'failed', 'AL-ACTION-FILTER': 'blocked', 'AL-OLDER-PAGE': 'blocked' })
    expect(statuses(await auditLogChecks(async () => ({ status: 200, data: { entries: [{ ...stored[1] }, { ...stored[0] }] } }), 'AL'))['AL-ROWS']).toBe('failed')
  })

  it('observes DNS and the served certificate from outside the host', async () => {
    expect((await externalDnsCheck('X-DNS', 'panel.example.test', '192.0.2.10', async () => [{ address: '198.51.100.1' }, { address: '192.0.2.10' }])).status).toBe('passed')
    expect((await externalDnsCheck('X-DNS', 'panel.example.test', '192.0.2.10', async () => [{ address: '198.51.100.1' }])).status).toBe('failed')
    const socket = (authorized: boolean, event = 'secureConnect') => () => {
      const value = Object.assign(new EventEmitter(), { authorized, destroy: () => {}, getPeerCertificate: () => ({ valid_from: 'Nov  1 00:00:00 2026 GMT', valid_to: 'Jan 30 00:00:00 2027 GMT', issuer: { O: 'Test CA' }, fingerprint256: 'AA:BB' }) })
      setImmediate(() => value.emit(event, event === 'error' ? Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) : undefined))
      return value
    }
    const options = { hostname: 'panel.example.test', port: 443, address: '192.0.2.10', now: Date.parse('2026-11-07T00:00:00Z') }
    expect(await externalTlsCheck('X-TLS', { ...options, open: socket(true) as never })).toMatchObject({ status: 'passed', observed: { issuer: 'Test CA' } })
    expect((await externalTlsCheck('X-TLS', { ...options, open: socket(false) as never })).status).toBe('failed')
    expect((await externalTlsCheck('X-TLS', { ...options, now: Date.parse('2027-02-01T00:00:00Z'), open: socket(true) as never })).status).toBe('failed')
    expect(await externalTlsCheck('X-TLS', { ...options, open: socket(true, 'error') as never })).toMatchObject({ status: 'failed', observed: { code: 'CERT_HAS_EXPIRED' } })
  })
})

describe('audit-log store oracle', { tags: ['feature'] }, () => {
  it('reads the stored rows read-only with the runtime SQLite', () => {
    const root = mkdtempSync(join(tmpdir(), 'xpanel-qualification-test-')); temporary.push(root)
    const path = join(root, 'control.db'), db = new DatabaseSync(path)
    db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, actor TEXT, action TEXT, target TEXT, detail TEXT, outcome TEXT)')
    for (const row of [...stored].reverse()) db.prepare('INSERT INTO audit_log (at, actor, action, target, detail, outcome) VALUES (?, ?, ?, ?, ?, ?)').run(row.at, row.actor, row.action, row.target, '{}', row.outcome)
    db.close()
    const read = auditStore(path)
    expect(read({ maxId: '5', limit: 2 })).toEqual(stored.slice(1, 3))
    expect(read({ maxId: '6', action: 'auth.login', limit: 5 })).toEqual(stored.filter(row => row.action === 'auth.login'))
  })
})

describe('delivery publication', { tags: ['feature'] }, () => {
  it('publishes complete five-profile evidence deterministically and the catalog verifies it', () => {
    const document = targetDocument(), { root, receipts, rows } = evidence(document)
    const result = aggregateDelivery({ targetDocument: document, bundles: [bundleOf(document, receipts, rows)], evidenceRoot: root, sourceFiles: document.source.files })
    expect(result).toMatchObject({ published: [TOOL], omitted: [] })
    const published = result.module.split('\n').filter((line: string) => line.startsWith('  {')).map((line: string) => JSON.parse(line.slice(2, -1)))
    expect(published).toHaveLength(30)
    const tool = tools.find(item => item.id === TOOL)!
    expect(assessDelivery({ ...tool, status: 'researched' }, specs.find(spec => spec.id === TOOL)!, published, document.target).status).toBe('verified')
    const half = Math.floor(receipts.length / 2)
    const split = aggregateDelivery({ targetDocument: document, bundles: [bundleOf(document, receipts.slice(half).reverse(), rows.slice(half)), bundleOf(document, receipts.slice(0, half), rows.slice(0, half).reverse())], evidenceRoot: root, sourceFiles: document.source.files })
    expect(split.module).toBe(result.module)
    const after = document.source.files.map(file => file.path === DELIVERY_PATH ? { ...file, sha256: sha256(result.module) } : file)
    expect(aggregateDelivery({ targetDocument: document, bundles: [bundleOf(document, receipts, rows)], evidenceRoot: root, sourceFiles: after }).module).toBe(result.module)
  })

  it('refuses a mismatched target, a fake executor, a failed result and altered raw evidence', () => {
    const document = targetDocument(), { root, receipts, rows } = evidence(document)
    const run = (bundle: object, over: Record<string, unknown> = {}) => () => aggregateDelivery({ targetDocument: document, bundles: [bundle], evidenceRoot: root, sourceFiles: document.source.files, ...over })
    expect(run(bundleOf(document, receipts, rows), { targetDocument: targetDocument({ artifact: 'other-artifact' }) })).toThrow(/does not match the deployed/)
    for (const [field, value] of [['executor', 'fake'], ['result', 'failed'], ['result', 'not_run']] as const) {
      const changed = clone(receipts), linux = changed.find((entry: any) => entry.receipt.environment === 'linux')
      linux.receipt[field] = value
      expect(run(bundleOf(document, changed, rows))).toThrow(/must pass on a real executor/)
    }
    const report = receipts.find((entry: any) => entry.receipt.environment === 'browser').report.path
    writeFileSync(join(root, report), '{"tampered":true}\n')
    expect(run(bundleOf(document, receipts, rows))).toThrow(/missing or corrupted/)
  })

  it('refuses missing profiles, duplicate slots, unreviewed requirements and source drift', () => {
    const document = targetDocument(), { root, receipts, rows } = evidence(document)
    const run = (bundles: object[], over: Record<string, unknown> = {}) => () => aggregateDelivery({ targetDocument: document, bundles, evidenceRoot: root, sourceFiles: document.source.files, ...over })
    const keep = (entry: any) => (entry.receipt?.profile ?? entry.profile) !== 'centos-stream-9'
    expect(run([bundleOf(document, receipts.filter(keep), rows.filter(keep))])).toThrow(/nothing can be published/)
    const bundle = bundleOf(document, receipts, rows)
    expect(run([bundle, bundle])).toThrow(/Duplicate receipt identity across bundles/)
    expect(run([{ ...bundle, requirements: [{ ...bundle.requirements[0], acceptance: 'The page renders.' }] }])).toThrow(/differ from the reviewed/)
    expect(run([{ ...bundle, requirements: [{ ...bundle.requirements[0], profiles: REQUIRED_PROFILES.slice(0, 4) }] }])).toThrow(/differ from the reviewed/)
    const drift = document.source.files.map(file => file.path === 'apps/api/src/main.ts' ? { ...file, sha256: sha256('changed') } : file)
    expect(run([bundle], { sourceFiles: drift })).toThrow(/differs from the qualified source/)
    const stale = targetDocument({ delivery: renderDeliveryModule(rows, document.target) })
    expect(run([bundle], { targetDocument: stale, sourceFiles: stale.source.files })).toThrow(/empty delivery publication/)
    expect(run([])).toThrow(/At least one evidence bundle/)
  })
})

describe('shipped delivery publication', { tags: ['unit'] }, () => {
  it('is exactly the rendered module and every published tool is verified by the catalog', () => {
    expect(renderDeliveryModule(deliveryEvidence, deliveryTarget)).toBe(readFileSync(resolve(ROOT, DELIVERY_PATH), 'utf8'))
    for (const toolId of new Set(deliveryEvidence.map(row => row.toolId))) {
      const tool = tools.find(item => item.id === toolId)!
      expect(assessDelivery({ ...tool, status: 'researched' }, specs.find(spec => spec.id === toolId)!, deliveryEvidence, deliveryTarget).status).toBe('verified')
    }
  })

})

// Hashes the whole executable source; it runs only once a publication exists.
describe.runIf(deliveryTarget !== null)('published delivery source binding', { tags: ['feature'] }, () => {
  it('qualifies this exact source apart from the publication itself', () => {
    expect(publishedSourceFingerprint(identifySource(ROOT, { requireClean: false }).files)).toBe(deliveryTarget!.sourceFingerprint)
  })
})
