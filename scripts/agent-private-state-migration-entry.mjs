import { withExistingPreparedRelease } from './prepared-release.mjs'
import { parseAgentPrivateStateMigrationArgs, runAgentPrivateStateMigration } from './agent-private-state-migration.mjs'

let enteredNativeFactory = false
try {
  const request = parseAgentPrivateStateMigrationArgs(process.argv.slice(2))
  const result = await withExistingPreparedRelease(request.artifact, prepared => {
    enteredNativeFactory = true
    return runAgentPrivateStateMigration(prepared, request)
  })
  // Only this boundary follows successful authenticated archive/FD retirement.
  // The external operator must still join the actual child and unit terminal.
  const retired = { ...result, archiveScopeRetired: true, terminalVerified: false,
    status: result.status === 'effect_verified' ? 'verified_complete' : result.status }
  process.stdout.write(JSON.stringify(retired) + '\n')
  if (!['verified_complete', 'already_private', 'legacy_pending'].includes(retired.status)) process.exitCode =
    ['attention', 'attention_incomplete', 'effect_observed_retirement_unconfirmed'].includes(retired.status) ? 6 : 3
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'AGENT_PRIVATE_STATE_UNVERIFIED'
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'xpanel-agent-private-state-result', status: enteredNativeFactory ? 'attention' : 'blocked', code,
    changed: enteredNativeFactory ? null : false, previousEffectsUnknown: true, preserveRetainedRecords: true,
    sqlAuditVerified: false, durableJobCreated: false, installationFinalized: false, releaseUpgraded: false, nativeCapabilityAcceptance: false }) + '\n')
  process.exitCode = enteredNativeFactory ? 6 : 3
}
