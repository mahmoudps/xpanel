import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statfsSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { isHash, isRecord, profileFromOsRelease, requireValue, validateReceipt, validateTargetDocument } from './evidence/contracts.mjs'
import { isMain, parseCommandArguments, readJson, runCli, writeDetachedJson } from './evidence/cli.mjs'
import { identifySource, readBoundedFile, sha256 } from './evidence/identity.mjs'
import { validateSemanticReport } from './evidence/reports.mjs'
import { validateServerInformationOrigin } from './evidence/server-information-contract.mjs'
import { authenticatedSession, createQualificationTransport } from './evidence/server-information-https.mjs'
import { readProtectedBytes, readProtectedJson, validateInstalledBinding, verifyInstalledRelease } from './evidence/server-information-installed.mjs'
import { parseObservedOsRelease } from './evidence/server-information-observer.mjs'
import { credentials as readCredentials } from './evidence/server-information-runner.mjs'
import { DRIVER_MODULES, DRIVERS } from './qualification-drivers/index.mjs'
import { ACCOUNT_CREATE, ACTOR_ENTRY, apiClient, createFixture, entryOrigin, externalDnsCheck, externalTlsCheck, failureCause, netClient, pageChecks, runDriver, runTag, siteClient } from './qualification-drivers/kit.mjs'
import { QUALIFICATION_INVENTORY, qualificationPlan, qualificationRequirements, RUNNER_SLOTS, slotCheckIds } from './qualification-plan.mjs'

export const ROOT = resolve(import.meta.dirname, '..')
const SESSION_PATHS = ['/api/auth/login', '/api/auth/logout']
const NEGATIVE_AUTH_TOOLS = new Set([
  'manage-account-suspension', 'terminate-accounts', 'password-modification', 'xwhm-two-factor-auth',
  'email-account-manage', 'account-preferences', 'password-security', 'manage-team', 'user-manager',
  'two-factor-auth', 'webmail-signin', 'webmail-two-factor', 'force-password-change',
  'restart-imap', 'forwarders', 'domain-forwarders', 'autoresponders', 'spam-filters', 'webmail-autoresponder',
])
const RUNNER_INPUTS = ['scripts/qualification-runner.mjs', ...DRIVER_MODULES, 'scripts/qualification-plan.mjs', 'packages/catalog/src/delivery.ts']
const ENTRY_PORT = { xpanel: 2083, xmail: 2096 }
const WRITE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
/** The runner's own requests on an actor's transport: anonymous probe, sign-in, catalog, sign-out and the revoked read. */
export const SESSION_REQUESTS = 5
/** A driver declares only its own requests; the session around it must not spend them, or sign-out is never confirmed. */
export const transportBudget = driver => driver.requests + SESSION_REQUESTS

export { DRIVERS }

const SLOT_OPTIONS = {
  unit: ['target-sha256', 'output'],
  host: ['target-sha256', 'binding', 'binding-sha256', 'artifact', 'origin', 'address', 'credential-file', 'output'],
  browser: ['target-sha256', 'binding', 'binding-sha256', 'artifact', 'origin', 'address', 'credential-file', 'output'],
  external: ['target-sha256', 'binding', 'binding-sha256', 'origin', 'credential-file', 'observer', 'host-report', 'host-report-sha256', 'output'],
}

export function parseRunnerArguments(argv) {
  const args = parseCommandArguments(argv, {
    values: ['slot', 'tools', 'target', 'target-sha256', 'binding', 'binding-sha256', 'artifact', 'origin', 'address', 'credential-file', 'ca-file', 'db', 'observer', 'host-report', 'host-report-sha256', 'run-id', 'output', 'fixture-domain-suffix'],
    flags: ['dry-run'], required: ['slot', 'target', 'run-id'],
  })
  requireValue(Object.hasOwn(SLOT_OPTIONS, args.slot), 'Use --slot=unit, host, browser or external')
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(args['run-id']), 'Use a run ID of at most 60 letters, digits, dashes and underscores')
  if (!args['dry-run']) for (const name of SLOT_OPTIONS[args.slot]) requireValue(args[name] !== undefined, `Missing --${name}`)
  for (const name of ['target-sha256', 'binding-sha256', 'host-report-sha256']) requireValue(args[name] === undefined || isHash(args[name]), `--${name} must be a SHA-256 pin`)
  requireValue(args['fixture-domain-suffix'] === undefined || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(args['fixture-domain-suffix']), 'The fixture domain suffix must be a plain domain name')
  requireValue(args.observer === undefined || /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(args.observer), 'The observer identity must be a short plain name')
  return { ...args, tools: args.tools ?? 'all' }
}

/** Dry run: validates inputs and lists the plan; it makes no request, signs nobody in and writes nothing. */
export function dryRun(args, readTarget = path => readJson(path), readOsRelease = () => readFileSync('/etc/os-release', 'utf8')) {
  const targetDocument = validateTargetDocument(readTarget(args.target))
  let profile = null
  try { profile = profileFromOsRelease(parseObservedOsRelease(readOsRelease())) } catch { /* Not a qualification profile host: reported as null. */ }
  const plan = qualificationPlan(args.slot, args.tools, profile ?? undefined)
  return {
    status: 'dry_run', proofExecuted: false, slot: args.slot, runId: args['run-id'], profile,
    profileInTarget: profile !== null && targetDocument.target.supportedProfiles.includes(profile),
    target: targetDocument.target, missingOptions: SLOT_OPTIONS[args.slot].filter(name => args[name] === undefined),
    receiptsPerTool: plan.receipts, tools: plan.tools, notRun: plan.notRun.length, notRunTools: plan.notRun.map(item => item.toolId),
    ...(plan.excludedByProfile === undefined ? {} : { excludedByProfile: plan.excludedByProfile }),
    // Evidence for these would be demoted by host readiness; they need a probe entry before qualification.
    withoutReadiness: [...plan.tools, ...plan.notRun].filter(item => item.readiness === null).map(item => item.toolId),
  }
}

/** The kernel's own figures, read in the host slot only: an oracle independent of the product, like the audit store. */
const hostOracle = { disk: path => {
  const info = statfsSync(path), size = info.bsize
  return { totalBytes: info.blocks * size, usedBytes: (info.blocks - info.bfree) * size, availableBytes: info.bavail * size }
} }

const denied = response => response.status === 401 && response.data?.code === 'UNAUTHENTICATED'
const safeResponse = response => ({ status: response.status, code: typeof response.data?.code === 'string' && /^[A-Z_]{1,64}$/.test(response.data.code) ? response.data.code : null })
const check = (id, passed, observed) => ({ id, status: passed ? 'passed' : 'failed', observed })

/** Normal root sign-in, the driver's reads, then sign-out confirmed by a refused read; credentials never enter evidence. */
export async function withRootSession({ request, login, prefix, probe, anonymous, run, entryPoint = 'xwhm' }) {
  const checks = [], cleanup = { ok: false, errors: [], leftovers: { sessions: [] } }
  let session, attempted = false, noSession = false, failure = null
  try {
    if (anonymous) { const response = await request(probe); checks.push(check(`${prefix}-ANONYMOUS-DENIED`, denied(response), safeResponse(response))) }
    attempted = true
    const response = await request('/api/auth/login', { method: 'POST', body: login })
    noSession = [401, 422, 429].includes(response.status) && response.setCookie.length === 0
    // Keep a cookie that admission refused afterwards, so it is still revoked below.
    const issued = response.setCookie.find(value => new RegExp(`^__Host-${entryPoint}_session=[A-Za-z0-9_-]+;`).test(value))
    if (issued) session = { cookie: issued.split(';')[0], csrf: typeof response.data?.csrfToken === 'string' ? response.data.csrfToken : '' }
    session = authenticatedSession(response, entryPoint)
    checks.push(...await run(params => request(`${probe.split('?')[0]}?${new URLSearchParams(params)}`, session), session))
  } catch (error) { failure = `The authenticated acceptance reads did not complete.${failureCause(error)}` }
  finally {
    if (session) {
      try {
        const logout = await request('/api/auth/logout', { method: 'POST', cookie: session.cookie, csrf: session.csrf })
        const revoked = await request(probe, { cookie: session.cookie })
        cleanup.ok = logout.status === 200 && denied(revoked)
        checks.push(check(`${prefix}-SESSION-REVOKED`, cleanup.ok, { logoutStatus: logout.status, subsequentRead: safeResponse(revoked) }))
      } catch { /* Reported through cleanup below. */ }
      if (!cleanup.ok) { cleanup.errors.push('Qualification session revocation was not confirmed.'); cleanup.leftovers.sessions.push('qualification-session-outcome-unknown') }
    } else if (!attempted || noSession) cleanup.ok = true
    else { cleanup.errors.push('Sign-in may have created a session whose revocation is unconfirmed.'); cleanup.leftovers.sessions.push('qualification-session-outcome-unknown') }
    login.password = ''
    if (login.totpCode !== undefined) login.totpCode = ''
  }
  return { checks, cleanup, failure }
}

/** Signs in each actor the driver uses, runs it once inside those sessions, then revokes them; cleanup covers both. */
export async function driveTool(driver, toolId, { prefix, anonymous, requestFor, loginFor, tag, fixture, site, net, address, host }) {
  const actors = [driver.as, ...driver.also]
  let driven = { checks: [], cleanup: { ok: false, errors: [] }, failure: null }, admission = 'none'
  const nest = async (index, clients) => {
    const actor = actors[index], outer = index === 0
    const session = await withRootSession({
      request: requestFor(actor), login: loginFor(actor), entryPoint: ACTOR_ENTRY[actor], anonymous: outer && anonymous,
      prefix: outer ? prefix : `${prefix}-${actor.toUpperCase()}`, probe: outer ? driver.probe : '/api/auth/me',
      run: async (_read, opened) => {
        const client = { ...clients, [actor]: apiClient(requestFor(actor), opened) }
        if (index + 1 < actors.length) return nest(index + 1, client).then(result => result.checks)
        const catalog = await client[driver.as].get('/api/catalog')
        const open = Array.isArray(catalog.data?.tools) ? catalog.data.tools.find(item => item?.id === driver.gate) : undefined
        admission = open?.delivery?.admission === 'qualification' ? 'qualification' : 'none'
        driven = await runDriver(driver, { clients: client, prefix, tag, fixture, site, net, address, host, requestFor, admitted: open !== undefined })
        return driven.checks
      },
    })
    return session
  }
  const session = await nest(0, {})
  const leftovers = [...(session.cleanup.leftovers?.sessions ?? []), ...(driven.cleanup.leftovers?.objects ?? [])]
  return { checks: session.checks, admission, failure: session.failure ?? driven.failure,
    cleanup: { ok: session.cleanup.ok && driven.cleanup.ok, errors: [...session.cleanup.errors, ...driven.cleanup.errors], leftovers: { sessions: session.cleanup.leftovers?.sessions ?? [], objects: leftovers.filter(item => !(session.cleanup.leftovers?.sessions ?? []).includes(item)) } } }
}

/** One checks-v1 observation per tool and slot. Missing checks stay blocked; unexpected ones block the report. */
export function observation({ toolId, slot, runId, targetDocument, profile, osRelease, executor, startedAt, checks, cleanup, failure = null, observer, hostReport, admission }) {
  const expected = slotCheckIds(toolId, slot), byId = new Map(checks.map(item => [item.id, item]))
  const unexpected = checks.filter(item => !expected.includes(item.id)).map(item => item.id)
  const outcomes = expected.map(id => byId.get(id) ?? { id, status: 'blocked', observed: { reason: 'Required observation was not completed.' } })
  const problem = failure ?? (unexpected.length > 0 ? `Driver reported checks outside the reviewed inventory: ${unexpected.join(', ')}` : null)
  const passed = problem === null && cleanup.ok === true && outcomes.every(item => item.status === 'passed')
  const requirement = qualificationRequirements([toolId])[0]
  return {
    schemaVersion: 1, kind: 'xpanel-qualification-observation', status: passed ? 'passed' : problem !== null || outcomes.some(item => item.status === 'blocked') ? 'blocked' : 'failed', proofExecuted: true,
    runId, toolId, acceptance: requirement.acceptance, slot, coveredSlots: passed ? RUNNER_SLOTS[slot] : [],
    target: targetDocument.target, sourceAlgorithm: targetDocument.source.algorithm, commit: targetDocument.source.commit,
    profile, host: { osRelease }, runtime: { node: process.version, platform: process.platform, profile }, executor,
    ...(observer === undefined ? {} : { observer }), ...(hostReport === undefined ? {} : { hostReport }), ...(admission === undefined ? {} : { admission }),
    startedAt, finishedAt: new Date().toISOString(), checks: outcomes, cleanup, failure: problem,
  }
}

/** Receipts for every slot a passed report backs, each bound to its own copy of the report bytes and validated. */
export function receiptsForObservation(report, reportBytes, reportPathFor, targetDocument) {
  requireValue(report?.kind === 'xpanel-qualification-observation' && report.status === 'passed' && report.cleanup?.ok === true
    && JSON.stringify(report.coveredSlots) === JSON.stringify(RUNNER_SLOTS[report.slot]), 'Incomplete observations cannot create capability receipts')
  requireValue(report.slot === 'unit' ? ['real', 'fake'].includes(report.executor) : report.executor === 'real', 'Only real execution backs a non-unit receipt')
  validateSemanticReport(report, 'checks-v1', slotCheckIds(report.toolId, report.slot))
  requireValue(JSON.stringify(JSON.parse(reportBytes.toString('utf8'))) === JSON.stringify(report), 'Receipt report bytes differ from the validated observation')
  const requirements = qualificationRequirements([report.toolId])
  return report.coveredSlots.map(({ stage, environment }) => {
    const receipt = {
      schemaVersion: 1, kind: 'xpanel-capability-acceptance', runId: report.runId,
      receiptId: `${report.runId}-${report.toolId}-${report.profile.replaceAll('.', '_')}-${stage}-${environment}`,
      toolId: report.toolId, acceptance: report.acceptance, coverage: 'full-acceptance', stage, environment, profile: report.profile,
      sourceAlgorithm: report.sourceAlgorithm, sourceFingerprint: report.target.sourceFingerprint, sourceBefore: report.target.sourceFingerprint,
      sourceAfter: report.target.sourceFingerprint, artifactSha256: report.target.artifactSha256, commit: report.commit,
      result: 'passed', executor: report.executor, startedAt: report.startedAt, finishedAt: report.finishedAt,
      runtime: report.runtime, host: report.host, cleanup: report.cleanup, ...(report.observer === undefined ? {} : { observer: report.observer }),
      report: { kind: 'checks-v1', path: reportPathFor({ stage, environment }), sha256: sha256(reportBytes) },
    }
    validateReceipt(receipt, targetDocument, requirements)
    return receipt
  })
}

/** Reviewed unit checks against a Vitest JSON report; a case passes only by its exact file and full name. */
export function unitChecks(toolId, vitest, root) {
  const cases = Array.isArray(vitest?.testResults) ? vitest.testResults.flatMap(suite => (Array.isArray(suite.assertionResults) ? suite.assertionResults : [])
    .map(test => ({ file: relative(root, suite.name ?? '').split(sep).join('/'), name: [...(test.ancestorTitles ?? []), test.title].join(' '), status: test.status, duration: test.duration ?? null }))) : []
  const run = vitest?.success === true && vitest.numFailedTests === 0 && (vitest.numFailedTestSuites ?? 0) === 0
  return QUALIFICATION_INVENTORY[toolId].unit.map(item => {
    const found = cases.filter(test => test.file === item.file && test.name === item.name)
    return check(item.id, run && found.length === 1 && found[0].status === 'passed', { file: item.file, name: item.name, status: found[0]?.status ?? 'missing', matches: found.length, durationMs: found[0]?.duration ?? null })
  })
}

function hostIdentity(binding, targetDocument) {
  const osRelease = parseObservedOsRelease(readFileSync('/etc/os-release', 'utf8'))
  const profile = profileFromOsRelease(osRelease)
  requireValue(targetDocument.target.supportedProfiles.includes(profile) && (binding === undefined || binding.profile === profile), 'This host is not the reviewed target profile')
  return { osRelease, profile }
}

/** A newer runner cannot qualify an older artifact: its own inputs must match the frozen target manifest. */
function verifyRunnerInputs(targetDocument) {
  for (const path of RUNNER_INPUTS) {
    const expected = targetDocument.source.files.find(file => file.path === path)
    requireValue(expected !== undefined, 'The qualification runner is absent from the frozen source manifest')
    requireValue(readProtectedBytes({ file: resolve(ROOT, path), expectedSha256: expected.sha256, maxBytes: 1024 * 1024 }).length === expected.bytes, 'The qualification runner differs from the frozen source manifest')
  }
}

function installed(options, targetDocument) {
  const binding = readProtectedJson({ file: options.binding, expectedSha256: options['binding-sha256'] })
  validateInstalledBinding(binding, targetDocument)
  const origin = validateServerInformationOrigin(options.origin)
  requireValue(binding.origin === origin && (options.address === undefined || binding.address === options.address), 'HTTPS origin/address differs from the reviewed installed binding')
  return { binding, origin }
}

function runVitestFiles(files, targetDocument) {
  const before = identifySource(ROOT)
  requireValue(before.sourceFingerprint === targetDocument.target.sourceFingerprint && before.commit === targetDocument.source.commit, 'This checkout is not the target source')
  const temporary = mkdtempSync(join(tmpdir(), 'xpanel-qualification-unit-'))
  try {
    const output = join(temporary, 'vitest.json')
    const result = spawnSync(process.execPath, [resolve(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', ...files, '--reporter=json', `--outputFile=${output}`], {
      cwd: ROOT, stdio: 'ignore', timeout: 1_800_000, killSignal: 'SIGKILL', windowsHide: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary, CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8' },
    })
    const report = result.error === undefined && result.signal === null ? JSON.parse(readBoundedFile(output, { maxBytes: 64 * 1024 * 1024 }).toString('utf8')) : null
    const unchanged = identifySource(ROOT).sourceFingerprint === before.sourceFingerprint
    return { report, failure: unchanged ? null : 'Source changed during the unit run.' }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

async function runTool(slot, toolId, options, environment) {
  const driver = DRIVERS[toolId], startedAt = new Date().toISOString(), deadline = Date.now() + Math.max(driver.deadlineMs, 600_000)
  const base = { toolId, slot, runId: options['run-id'], targetDocument: environment.targetDocument, profile: environment.profile, osRelease: environment.osRelease, startedAt }
  if (slot === 'unit') {
    const batched = environment.unitBatch ?? runVitestFiles([...new Set(QUALIFICATION_INVENTORY[toolId].unit.map(item => item.file))], environment.targetDocument)
    return observation({ ...base, executor: 'fake', checks: unitChecks(toolId, batched.report, ROOT), cleanup: { ok: true, errors: [] }, failure: batched.failure })
  }
  const { binding, origin, targetDocument, fixture } = environment
  const rootLogin = () => readCredentials({ credentialFile: options['credential-file'] })
  const ca = options['ca-file'] === undefined ? undefined : readProtectedBytes({ file: options['ca-file'], maxBytes: 1024 * 1024 })
  const actorOrigin = actor => ACTOR_ENTRY[actor] === 'xwhm' ? origin : entryOrigin(origin, ENTRY_PORT[ACTOR_ENTRY[actor]])
  const actorLogin = actor => actor === 'root' ? rootLogin() : actor === 'owner'
    ? { username: fixture?.username ?? '', password: fixture?.password ?? '' } : { username: fixture?.mailbox?.address ?? '', password: fixture?.mailbox?.password ?? '' }
  if (driver.needs.length > 0 && (fixture === null || fixture === undefined || (driver.needs.includes('mailbox') && fixture.mailbox === null))) {
    return observation({ ...base, executor: 'real', checks: [], cleanup: { ok: true, errors: [] }, failure: 'The run-scoped account fixture could not be created.' })
  }
  if (environment.sharedStopped && driver.restores.length > 0 && slot !== 'browser') {
    return observation({ ...base, executor: 'real', checks: [], cleanup: { ok: true, errors: [] }, failure: 'An earlier shared-state restore was not confirmed, so this run stopped changing shared state.' })
  }
  if (slot === 'browser') {
    const installedBefore = verifyInstalledRelease({ binding, targetDocument, artifact: options.artifact, deadline: Date.now() + 180_000 })
    const pageActor = driver.page?.actor ?? driver.as, login = actorLogin(pageActor)
    let result = { checks: [], signedOut: false }, failure = null, context
    try {
      const browser = await environment.getBrowser()
      context = await browser.newContext({ locale: 'en-US' })
      const page = await context.newPage()
      page.setDefaultTimeout(15_000)
      page.setDefaultNavigationTimeout(15_000)
      let guard
      try {
        result = await Promise.race([
          driver.browser ? driver.browser({ page, origin, credentials: login }) : pageChecks(driver, { page, origin: actorOrigin(pageActor), credentials: login }),
          new Promise((_, reject) => { guard = setTimeout(() => reject(Object.assign(new Error('Browser check timed out after 45000ms'), { name: 'TimeoutError' })), 45_000); guard.unref() }),
        ])
      } finally {
        clearTimeout(guard)
      }
    } catch (error) {
      failure = `The browser acceptance did not complete.${failureCause(error)}`
      await environment.resetBrowserIfDisconnected?.()
    } finally {
      await context?.close().catch(() => {})
      login.password = ''
      if (login.totpCode !== undefined) login.totpCode = ''
    }
    const installedAfter = verifyInstalledRelease({ binding, targetDocument, artifact: options.artifact, deadline: Date.now() + 180_000 })
    if (JSON.stringify(installedBefore.roles) !== JSON.stringify(installedAfter.roles)) failure = 'Installed release or measured processes changed during the run.'
    const cleanup = result.signedOut ? { ok: true, errors: [] } : { ok: false, errors: ['Browser session sign-out was not confirmed.'], leftovers: { sessions: ['qualification-session-outcome-unknown'] } }
    return observation({ ...base, executor: 'real', checks: result.checks, cleanup, failure })
  }
  const address = slot === 'external' ? binding.address : options.address
  const transports = {}
  const requestFor = actor => transports[actor] ??= createQualificationTransport({ origin: actorOrigin(actor), address, ca, deadline, methods: WRITE_METHODS, maxBody: 4 * 1024 * 1024, acceptText: true, requestTimeoutMs: 180_000, maxRequests: transportBudget(driver),
    allow: path => SESSION_PATHS.includes(path) || path === '/api/auth/me' || path === '/api/catalog' || driver.paths.test(path) || path === driver.probe || driver.restores.includes(path) })
  const drive = (prefix, anonymous) => driver.run === undefined
    ? withRootSession({ request: requestFor('root'), login: rootLogin(), prefix, probe: driver.probe, anonymous, run: read => slot === 'host' ? driver.host(read, { db: options.db ?? '/var/lib/xpanel/control.db' }) : driver.external(read) })
    : driveTool(driver, toolId, { prefix, anonymous, requestFor, loginFor: actorLogin, tag: runTag(`${options['run-id']}-${slot}`), fixture, site: siteClient({ address, deadline }), net: netClient({ address, deadline }), address, ...(slot === 'host' ? { host: hostOracle } : {}) })
  if (slot === 'host') {
    const installedBefore = verifyInstalledRelease({ binding, targetDocument, artifact: options.artifact, deadline: Date.now() + 180_000 })
    const session = await drive(driver.prefix, true)
    const installedAfter = verifyInstalledRelease({ binding, targetDocument, artifact: options.artifact, deadline: Date.now() + 180_000 })
    const changed = JSON.stringify(installedBefore.roles) !== JSON.stringify(installedAfter.roles)
    return observation({ ...base, executor: 'real', admission: session.admission, checks: [check(`${driver.prefix}-OS-PROFILE`, true, { profile: environment.profile, osRelease: environment.osRelease }), ...session.checks], cleanup: session.cleanup, failure: changed ? 'Installed release or measured processes changed during the run.' : session.failure })
  }
  const url = new URL(actorOrigin(driver.as)), prefix = `${driver.prefix}-EXTERNAL`
  const network = [await externalDnsCheck(`${prefix}-DNS`, url.hostname, binding.address), await externalTlsCheck(`${prefix}-TLS`, { hostname: url.hostname, port: Number(url.port || 443), address: binding.address })]
  const session = await drive(prefix, false)
  return observation({ ...base, executor: 'real', admission: session.admission, observer: environment.observer, hostReport: environment.hostReport, checks: [...network, ...session.checks], cleanup: session.cleanup, failure: session.failure })
}

/** The observer is a different machine than the measured host, and its host evidence comes from a passed host report. */
function externalEnvironment(options, binding, targetDocument) {
  const bytes = readProtectedBytes({ file: options['host-report'], expectedSha256: options['host-report-sha256'] })
  const report = JSON.parse(bytes.toString('utf8'))
  requireValue(report?.kind === 'xpanel-qualification-observation' && report.slot === 'host' && report.status === 'passed' && report.profile === binding.profile
    && JSON.stringify(report.target) === JSON.stringify(targetDocument.target) && isRecord(report.host?.osRelease) && profileFromOsRelease(report.host.osRelease) === binding.profile, 'A passed host report for this target profile is required')
  const localAddresses = Object.values(networkInterfaces()).flat().map(item => item?.address)
  requireValue(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== binding.bootId && !localAddresses.includes(binding.address), 'The external observer must run outside the measured host')
  return { profile: binding.profile, osRelease: report.host.osRelease, observer: { independent: true, identity: options.observer }, hostReport: { sha256: sha256(bytes), runId: report.runId } }
}

export async function runQualification(options) {
  requireValue(process.platform === 'linux' && process.getuid() === 0, 'Native qualification runs as root on a Linux qualification host')
  const targetDocument = readProtectedJson({ file: options.target, expectedSha256: options['target-sha256'] })
  validateTargetDocument(targetDocument)
  requireValue(process.version === `v${targetDocument.source.node}`, 'Qualification requires the pinned Node runtime')
  verifyRunnerInputs(targetDocument)
  let environment = { targetDocument }
  if (options.slot === 'unit') environment = { ...environment, ...hostIdentity(undefined, targetDocument) }
  else {
    const { binding, origin } = installed(options, targetDocument)
    environment = { ...environment, binding, origin, ...(options.slot === 'external' ? externalEnvironment(options, binding, targetDocument) : hostIdentity(binding, targetDocument)) }
  }
  const plan = qualificationPlan(options.slot, options.tools, environment.profile)
  if (options.slot === 'unit' && plan.tools.length > 0) {
    const unitFiles = [...new Set(plan.tools.flatMap(({ toolId }) => QUALIFICATION_INVENTORY[toolId].unit.map(item => item.file)))]
    environment = { ...environment, unitBatch: runVitestFiles(unitFiles, targetDocument) }
  }
  const fixtureSession = async work => {
    const { origin } = environment, address = options.slot === 'external' ? environment.binding.address : options.address
    const ca = options['ca-file'] === undefined ? undefined : readProtectedBytes({ file: options['ca-file'], maxBytes: 1024 * 1024 })
    const request = createQualificationTransport({ origin, address, ca, deadline: Date.now() + 600_000, methods: WRITE_METHODS, maxBody: 4 * 1024 * 1024, requestTimeoutMs: 180_000, maxRequests: 30 + ACCOUNT_CREATE.requests, allow: path => path.startsWith('/api/') })
    let outcome
    const session = await withRootSession({ request, login: readCredentials({ credentialFile: options['credential-file'] }), prefix: 'FIXTURE', probe: '/api/auth/me', anonymous: false, run: async (_read, opened) => { outcome = await work(apiClient(request, opened)); return [] } })
    return { outcome, session }
  }
  const clearRunnerIp = async root => {
    const policy = await root.get('/api/server/sec/sign-in')
    const clientIp = policy.data?.client?.address
    if (typeof clientIp === 'string' && clientIp.length > 0) await root.post('/api/server/sec/sign-in/unlock', { ip: clientIp })
  }
  const needs = plan.tools.flatMap(({ toolId }) => DRIVERS[toolId].needs)
  let fixtureLeftovers = null
  if (options.slot !== 'unit' && needs.length > 0) {
    const created = await fixtureSession(async root => {
      await clearRunnerIp(root)
      return createFixture(root, { tag: runTag(`${options['run-id']}-${options.slot}`), domainSuffix: options['fixture-domain-suffix'], mailbox: needs.includes('mailbox') }).catch(error => {
        // A fixture the API may have accepted and whose removal is not confirmed is a leftover: the slot reports it.
        if (error?.fixtureCleanup?.ok !== true) fixtureLeftovers = { username: error?.fixtureCleanup?.username ?? null, errors: error?.fixtureCleanup?.errors ?? ['The fixture cleanup did not complete.'] }
        return null
      })
    })
    environment = { ...environment, fixture: created.outcome ?? null }
  }
  let sharedBrowser = null
  if (options.slot === 'browser') {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(ROOT, '.tools/playwright-browsers')
    const targetAddress = environment.binding.address.includes(':') ? `[${environment.binding.address}]` : environment.binding.address
    const actorOrigin = actor => ACTOR_ENTRY[actor] === 'xwhm' ? environment.origin : entryOrigin(environment.origin, ENTRY_PORT[ACTOR_ENTRY[actor]])
    const resolverRules = [...new Set([environment.origin, actorOrigin('owner'), actorOrigin('mailbox')].map(item => `MAP ${new URL(item).hostname} ${targetAddress}`))].join(', ')
    environment = {
      ...environment,
      getBrowser: async () => {
        if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser
        const { chromium } = await import('@playwright/test')
        sharedBrowser = await chromium.launch({ headless: true, timeout: 20_000, args: [`--host-resolver-rules=${resolverRules}`] })
        return sharedBrowser
      },
      resetBrowserIfDisconnected: async () => {
        if (sharedBrowser && !sharedBrowser.isConnected()) {
          await sharedBrowser.close().catch(() => {})
          sharedBrowser = null
        }
      },
    }
  }
  const outputs = [], passed = []
  try {
    for (const { toolId, shared } of plan.tools) {
      const report = await runTool(options.slot, toolId, options, environment)
      if (shared && report.cleanup?.ok !== true) environment = { ...environment, sharedStopped: true }
      if ((options.slot === 'host' || options.slot === 'external') && NEGATIVE_AUTH_TOOLS.has(toolId)) await fixtureSession(clearRunnerIp)
      const name = `${options['run-id']}-${toolId}-${report.profile.replaceAll('.', '_')}-${options.slot}`
      const written = writeDetachedJson(ROOT, join(options.output, `${name}.report.json`), report)
      const output = { toolId, status: report.status, report: written, receipts: [] }
      outputs.push(output)
      if (report.status === 'passed') passed.push({ report, written, name, output })
    }
  } finally {
    await sharedBrowser?.close().catch(() => {})
  }
  // A receipt says the run cleaned up, so none exists until the shared fixture is confirmed gone.
  const fixtureGone = environment.fixture ? (await fixtureSession(async root => {
    await clearRunnerIp(root)
    return environment.fixture.destroy(root)
  })).outcome : null
  const leftovers = fixtureLeftovers ?? (environment.fixture && fixtureGone?.ok !== true ? { username: environment.fixture.username, errors: fixtureGone?.errors ?? ['The fixture cleanup did not complete.'] } : null)
  if (leftovers === null) for (const { report, written, name, output } of passed) {
    const pathFor = slot => `${name}-${slot.stage}-${slot.environment}.report.json`
    const receipts = receiptsForObservation(report, readBoundedFile(written), pathFor, targetDocument)
    // The evidence recorder binds each receipt to its own report file; every copy holds the same observation bytes.
    for (const receipt of receipts) writeDetachedJson(ROOT, join(options.output, receipt.report.path), report)
    output.receipts = receipts.map(receipt => writeDetachedJson(ROOT, join(options.output, `${receipt.receiptId}.receipt.json`), receipt))
  }
  return { status: leftovers === null && outputs.every(item => item.status === 'passed') ? 'passed' : 'incomplete', slot: options.slot, profile: environment.profile, tools: outputs, notRun: plan.notRun.length, ...(leftovers ? { fixtureLeftovers: leftovers } : {}) }
}

if (isMain(import.meta.url)) await runCli(async () => {
  const options = parseRunnerArguments(process.argv.slice(2))
  if (options['dry-run']) { process.stdout.write(`${JSON.stringify(dryRun(options), null, 2)}\n`); return }
  const result = await runQualification(options)
  process.stdout.write(`${JSON.stringify({ ...result, tools: result.tools.map(item => ({ ...item, report: basename(item.report), receipts: item.receipts.map(path => basename(path)) })) }, null, 2)}\n`)
  if (result.status !== 'passed') process.exitCode = 2
})
