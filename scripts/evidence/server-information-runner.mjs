import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { isHash, isRecord, profileFromOsRelease, requireValue, validateReceipt } from './contracts.mjs'
import { isMain, parseArguments, runCli, writeDetachedJson } from './cli.mjs'
import { sha256 } from './shared.mjs'
import { readBoundedFile } from './files.mjs'
import { validateSemanticReport } from './reports.mjs'
import { compareServerInformation, SERVER_INFORMATION_ACCEPTANCE, SERVER_INFORMATION_HTTP_IDS, SERVER_INFORMATION_REQUIREMENTS, validateServerInformationOrigin } from './server-information-contract.mjs'
import { readProtectedBytes, readProtectedJson, validateInstalledBinding, verifyInstalledRelease } from './server-information-installed.mjs'
import { authenticatedSession, createQualificationTransport } from './server-information-https.mjs'

function observer(deadline) {
  const nonce = randomBytes(16).toString('hex')
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./server-information-observer.mjs', import.meta.url)), `--nonce=${nonce}`], {
    encoding: 'utf8', timeout: Math.min(12_000, deadline - Date.now()), killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' }, windowsHide: true,
  })
  requireValue(result.status === 0 && result.signal === null && result.error === undefined && result.stderr.length === 0, 'Independent OS observer failed or its cleanup is unconfirmed')
  const observed = JSON.parse(result.stdout)
  requireValue(observed.schemaVersion === 1 && observed.kind === 'xpanel-independent-server-information' && observed.nonce === nonce && observed.observer?.parentPid === process.pid && observed.observer?.pid === result.pid && observed.observer?.uid === 0, 'Independent OS observer identity did not match its launch')
  return observed
}

function credentials(options) {
  requireValue((options.credentialFile === undefined) !== (options.credentialFd === undefined), 'Select exactly one protected credential file or descriptor')
  const value = readProtectedJson({ ...(options.credentialFile === undefined ? { fd: options.credentialFd } : { file: options.credentialFile }), secret: true, maxBytes: 16 * 1024 })
  requireValue(isRecord(value) && typeof value.username === 'string' && value.username.length > 0 && value.username.length <= 253 && typeof value.password === 'string' && value.password.length > 0 && value.password.length <= 8192 && (value.totpCode === undefined || /^\d{6}$/.test(value.totpCode)), 'Protected root login credentials are incomplete')
  requireValue(Object.keys(value).every(key => ['username', 'password', 'totpCode'].includes(key)), 'Protected credential input contains unsupported fields')
  return value
}

function denied(response) { return response.status === 401 && response.data?.code === 'UNAUTHENTICATED' }
function safeResponse(response) { return { status: response.status, code: typeof response.data?.code === 'string' && /^[A-Z_]{1,64}$/.test(response.data.code) ? response.data.code : null } }

/** No fake transport/observer injection or request-controlled qualification bypass is supported. */
export async function qualifyServerInformation(options) {
  const startedAt = new Date().toISOString(), deadline = Date.now() + 60_000
  requireValue(process.platform === 'linux' && process.getuid() === 0 && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(options.runId), 'A bounded trusted Linux qualification invocation is required')
  const targetDocument = readProtectedJson({ file: options.targetFile, expectedSha256: options.targetSha256 })
  const binding = readProtectedJson({ file: options.bindingFile, expectedSha256: options.bindingSha256 })
  requireValue(isHash(options.targetSha256) && isHash(options.bindingSha256), 'Independently reviewed target and installation pins are required')
  validateInstalledBinding(binding, targetDocument)
  const origin = validateServerInformationOrigin(options.origin)
  requireValue(binding.origin === origin && binding.address === options.address, 'HTTPS origin/address differs from the reviewed installed binding')
  const ca = options.caFile === undefined ? undefined : readProtectedBytes({ file: options.caFile, maxBytes: 1024 * 1024 })
  const request = createQualificationTransport({ origin, address: options.address, ca, deadline })
  const checks = new Map(), add = (id, passed, observed) => checks.set(id, { id, status: passed ? 'passed' : 'failed', observed })
  const cleanup = { ok: false, errors: [], leftovers: { sessions: [] } }
  const requestEvidence = []
  let session, loginCredentials, before, after, installedBefore, installedAfter, failure = null, loginAttempted = false, noSessionConfirmed = false
  try {
    installedBefore = verifyInstalledRelease({ binding, targetDocument, artifact: options.artifact, deadline })
    add('SI-INSTALLED-IDENTITY', true, { sourceFingerprint: installedBefore.sourceFingerprint, artifactSha256: installedBefore.artifactSha256, manifestSha256: installedBefore.manifestSha256, inventoryFiles: installedBefore.inventoryFiles, qualificationAdmission: installedBefore.qualificationAdmission })
    before = observer(deadline)
    requireValue(before.localAddresses.includes(options.address) && before.observer.bootId === installedBefore.bootId && before.observer.mountNamespace === installedBefore.roles.agent.mountNamespace && before.observer.pid !== installedBefore.roles.agent.pid && before.observer.pid !== installedBefore.roles.api.pid, 'Independent observer is outside the measured host/agent namespace')
    add('SI-OBSERVER-INDEPENDENT', true, { implementation: before.observer.implementation, namespace: before.observer.mountNamespace, separateProcess: true, location: 'same-host', bootId: before.observer.bootId })
    requireValue(targetDocument.target.supportedProfiles.includes(before.profile) && before.profile === binding.profile && profileFromOsRelease(before.osRelease) === before.profile, 'Observed OS profile is not the reviewed target profile')
    add('SI-OS-PROFILE', true, { profile: before.profile, osRelease: before.osRelease })
    const anonymous = await request('/api/server/info')
    add('SI-ANONYMOUS-DENIED', denied(anonymous), safeResponse(anonymous)); requestEvidence.push({ operation: 'anonymous GET server information', ...safeResponse(anonymous) })
    const forged = await request('/api/server/info', { forged: true })
    add('SI-FORGED-PRINCIPAL-DENIED', denied(forged), safeResponse(forged)); requestEvidence.push({ operation: 'anonymous GET with forged principal headers', ...safeResponse(forged) })
    loginCredentials = credentials(options)
    loginAttempted = true
    const login = await request('/api/auth/login', { method: 'POST', body: loginCredentials })
    noSessionConfirmed = [401, 422, 429].includes(login.status) && login.setCookie.length === 0
    // Capture a secure cookie even when normal post-login admission fails, so it can be revoked.
    const issued = login.setCookie.find(value => /^__Host-xwhm_session=[A-Za-z0-9_-]+;/.test(value))
    if (issued) session = { cookie: issued.split(';')[0], csrf: typeof login.data?.csrfToken === 'string' ? login.data.csrfToken : '' }
    session = authenticatedSession(login)
    before = observer(deadline)
    const measured = await request('/api/server/info', session)
    after = observer(deadline)
    add('SI-API-ROOT-READ', measured.status === 200 && isRecord(measured.data), { status: measured.status, principalKind: login.data.principal.kind, entryPoint: login.data.entryPoint, path: '/api/server/info' })
    requireValue(after.profile === binding.profile && before.profile === binding.profile && before.observer.mountNamespace === installedBefore.roles.agent.mountNamespace && after.observer.mountNamespace === installedBefore.roles.agent.mountNamespace && before.observer.bootId === installedBefore.bootId && after.observer.bootId === installedBefore.bootId, 'OS observer identity changed during measurement')
    for (const check of compareServerInformation(measured.data, before, after)) checks.set(check.id, check)
  } catch {
    failure = 'Qualification could not complete its bound source/authentication/OS observation checks.'
  } finally {
    if (session) {
      try {
        const logout = await request('/api/auth/logout', { method: 'POST', cookie: session.cookie, csrf: session.csrf })
        const revoked = await request('/api/server/info', { cookie: session.cookie })
        const okay = logout.status === 200 && logout.data?.ok === true && denied(revoked)
        add('SI-SESSION-REVOKED', okay, { logoutStatus: logout.status, subsequentRead: safeResponse(revoked) })
        cleanup.ok = okay
        if (!okay) { cleanup.errors.push('Created qualification session revocation was not confirmed.'); cleanup.leftovers.sessions.push('qualification-session-outcome-unknown') }
      } catch { cleanup.errors.push('Created qualification session cleanup did not complete.'); cleanup.leftovers.sessions.push('qualification-session-outcome-unknown') }
    } else if (!loginAttempted || noSessionConfirmed) { cleanup.ok = true }
    else { cleanup.errors.push('Authentication may have created a session whose revocation is unconfirmed.'); cleanup.leftovers.sessions.push('qualification-session-outcome-unknown') }
    if (loginCredentials) { loginCredentials.password = ''; if (loginCredentials.totpCode !== undefined) loginCredentials.totpCode = '' }
  }
  try {
    installedAfter = verifyInstalledRelease({ binding, targetDocument, artifact: options.artifact, deadline })
    requireValue(installedBefore?.sourceFingerprint === installedAfter.sourceFingerprint && JSON.stringify(installedBefore.roles) === JSON.stringify(installedAfter.roles), 'Installed source or measured processes changed')
  } catch { failure = 'Installed release/process identity could not be confirmed after qualification.'; add('SI-INSTALLED-IDENTITY', false, { reason: 'The final installed source/process binding did not match.' }) }
  for (const id of SERVER_INFORMATION_HTTP_IDS) if (!checks.has(id)) checks.set(id, { id, status: 'blocked', observed: { reason: 'Required observation was not completed.' } })
  const outcomes = SERVER_INFORMATION_HTTP_IDS.map(id => checks.get(id))
  const passed = failure === null && cleanup.ok && outcomes.every(check => check.status === 'passed')
  return {
    schemaVersion: 1, kind: 'xpanel-server-information-observation', status: passed ? 'passed' : failure !== null || outcomes.some(check => check.status === 'blocked') ? 'blocked' : 'failed', proofExecuted: true,
    runId: options.runId, startedAt, finishedAt: new Date().toISOString(), toolId: 'server-information', acceptance: SERVER_INFORMATION_ACCEPTANCE,
    target: targetDocument.target, sourceAlgorithm: targetDocument.source.algorithm, commit: targetDocument.source.commit,
    profile: before?.profile ?? null, host: before ? { osRelease: before.osRelease } : null,
    runtime: { node: process.version, platform: process.platform, profile: before?.profile ?? null },
    coveredSlots: passed ? [{ stage: 'integrated', environment: 'http' }, { stage: 'verified', environment: 'linux' }] : [],
    notRunSlots: [{ stage: 'implemented', environment: 'unit' }, { stage: 'integrated', environment: 'browser' }, { stage: 'verified', environment: 'browser' }, { stage: 'verified', environment: 'external' }],
    checks: outcomes, cleanup, requestEvidence, failure,
    observerContext: before && after ? { before: before.observer, after: after.observer, sameHostIndependentProcess: true, externalEnvironmentClaimed: false } : null,
    fixtureEffects: ['Ordinary login/session-revocation and audit records only; no hosting data, accounts or services changed.'],
    limits: ['No browser, unit, external-location, database-integrity or other capability acceptance is established.', 'Root-controlled fixture preparation and actual normal admission are separate from operation proof.', 'The ordinary configured MFA policy is unchanged.'],
  }
}

export function receiptsForServerInformation(report, targetDocument, reportPath, reportBytes) {
  requireValue(report.status === 'passed' && report.proofExecuted === true && report.coveredSlots.length === 2 && report.checks.every(check => check.status === 'passed') && report.cleanup.ok === true, 'Incomplete observations cannot create capability receipts')
  requireValue(JSON.stringify(report.coveredSlots) === JSON.stringify([{ stage: 'integrated', environment: 'http' }, { stage: 'verified', environment: 'linux' }]), 'This adapter covers only actual HTTP and Linux observation slots')
  validateSemanticReport(report, 'checks-v1', SERVER_INFORMATION_HTTP_IDS)
  requireValue(JSON.stringify(JSON.parse(reportBytes.toString('utf8'))) === JSON.stringify(report), 'Receipt report bytes differ from the validated observation')
  return report.coveredSlots.map(slot => {
    const receipt = {
      schemaVersion: 1, kind: 'xpanel-capability-acceptance', runId: report.runId,
      receiptId: `${report.runId}-${report.profile.replaceAll('.', '_')}-${slot.stage}-${slot.environment}`,
      toolId: 'server-information', acceptance: SERVER_INFORMATION_ACCEPTANCE, coverage: 'full-acceptance', ...slot,
      profile: report.profile, sourceAlgorithm: report.sourceAlgorithm, sourceFingerprint: report.target.sourceFingerprint,
      sourceBefore: report.target.sourceFingerprint, sourceAfter: report.target.sourceFingerprint, artifactSha256: report.target.artifactSha256, commit: report.commit,
      result: 'passed', executor: 'real', startedAt: report.startedAt, finishedAt: report.finishedAt,
      runtime: report.runtime, host: report.host, cleanup: report.cleanup,
      report: { kind: 'checks-v1', path: reportPath(slot), sha256: sha256(reportBytes) },
    }
    validateReceipt(receipt, targetDocument, SERVER_INFORMATION_REQUIREMENTS)
    return receipt
  })
}

if (isMain(import.meta.url)) await runCli(async () => {
  const args = parseArguments(process.argv.slice(2), ['root', 'target', 'target-sha256', 'binding', 'binding-sha256', 'artifact', 'origin', 'address', 'credential-file', 'credential-fd', 'ca-file', 'run-id', 'output'], ['root', 'target', 'target-sha256', 'binding', 'binding-sha256', 'artifact', 'origin', 'address', 'run-id', 'output'])
  const report = await qualifyServerInformation({ targetFile: args.target, targetSha256: args['target-sha256'], bindingFile: args.binding, bindingSha256: args['binding-sha256'], artifact: args.artifact, origin: args.origin, address: args.address, credentialFile: args['credential-file'], credentialFd: args['credential-fd'] === undefined ? undefined : Number(args['credential-fd']), caFile: args['ca-file'], runId: args['run-id'] })
  const output = writeDetachedJson(args.root, args.output, report, args.artifact)
  const receiptOutputs = []
  if (report.status === 'passed') {
    const targetDocument = readProtectedJson({ file: args.target, expectedSha256: args['target-sha256'] })
    const bytes = readBoundedFile(output), prefix = output.replace(/\.json$/, '')
    const receipts = receiptsForServerInformation(report, targetDocument, slot => `${basename(prefix)}-${slot.environment}.report.json`, bytes)
    for (const receipt of receipts) {
      writeDetachedJson(args.root, `${prefix}-${receipt.environment}.report.json`, report, args.artifact)
      receiptOutputs.push(writeDetachedJson(args.root, `${prefix}-${receipt.environment}.receipt.json`, receipt, args.artifact))
    }
  }
  process.stdout.write(JSON.stringify({ status: report.status, scope: 'server-information HTTP/Linux only', profile: report.profile, coveredSlots: report.coveredSlots, output, receiptOutputs }) + '\n')
  if (report.status !== 'passed') process.exitCode = 2
})
