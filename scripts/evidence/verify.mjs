import { verifyEvidenceBundle } from './runtime.mjs'
import { isMain, parseArguments, readJson, runCli } from './cli.mjs'
export { assertTrustedMetadata, loadTrustedEvidenceBundle, verifyEvidenceBundle } from './runtime.mjs'

if (isMain(import.meta.url)) await runCli(() => {
  const args = parseArguments(process.argv.slice(2), ['bundle', 'target', 'requirements', 'evidence-root'], ['bundle', 'target', 'requirements', 'evidence-root'])
  const result = verifyEvidenceBundle(readJson(args.bundle, { maxBytes: 8 * 1024 * 1024 }), { expectedTarget: readJson(args.target).target, expectedRequirements: readJson(args.requirements), evidenceRoot: args['evidence-root'] })
  process.stdout.write(JSON.stringify({ status: 'verified', evidence: result.evidence.length, profiles: result.target.supportedProfiles }) + '\n')
})
