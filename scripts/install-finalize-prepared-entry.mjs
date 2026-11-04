import { requireLinuxRoot, readTrustedFile } from './lifecycle-ownership.mjs'
import { parsePreparedReleaseInput } from './prepared-release.mjs'
import { parseBootstrapTrust } from './install-bootstrap.mjs'
import { runNativePreparedInstallFinalization } from './install-finalization-native.mjs'

let enteredNativeFactory = false
try {
  requireLinuxRoot()
  const args = process.argv.slice(2)
  if (args.length !== 2 || !args[0]?.startsWith('--artifact=') || !/^--archive-sha256=[a-f0-9]{64}$/.test(args[1]))
    throw Object.assign(new Error('INSTALL_EMPTY_HELPER_ARGUMENTS_INVALID'), { code: 'INSTALL_EMPTY_HELPER_ARGUMENTS_INVALID' })
  const artifact = parsePreparedReleaseInput({ artifactPath: args[0].slice(11), expectedArchiveSha256: args[1].slice(17) })
  const trust = parseBootstrapTrust(JSON.parse((await readTrustedFile('/etc/xpanel/release-trust.json', { exactMode: 0o600, maxBytes: 8192 })).bytes.toString('utf8')))
  enteredNativeFactory = true
  const result = await runNativePreparedInstallFinalization({ schemaVersion: 1, command: 'install', mode: 'apply', json: true, assumeYes: true,
    artifact: { path: artifact.artifactPath, expectedArchiveSha256: artifact.expectedArchiveSha256, keyId: trust.keyId, signingKeyPath: '/etc/xpanel/release-hmac.key' } })
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = result.exitCode
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'INSTALL_EMPTY_HELPER_UNVERIFIED'
  process.stdout.write(JSON.stringify({ exitCode: enteredNativeFactory ? 6 : 3, code, outcome: enteredNativeFactory ? 'attention' : 'blocked',
    details: { status: enteredNativeFactory ? 'attention' : 'blocked', changed: enteredNativeFactory ? null : false,
    qualified: false, nativeQualified: false, installReady: false } }) + '\n')
  process.exitCode = enteredNativeFactory ? 6 : 3
}
