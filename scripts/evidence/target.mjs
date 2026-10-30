import { resolve } from 'node:path'
import { assertDetachedOutput, assertSameSource, hashArtifact, identifySource, readBoundedFile, REQUIRED_PROFILES, sha256 } from './identity.mjs'
import { isHash, requireValue, validateArtifactProvenance, validateTargetDocument } from './contracts.mjs'
import { isMain, parseArguments, runCli, writeDetachedJson } from './cli.mjs'

export function createVerificationTarget({ root, artifact, provenancePath, provenanceSha256, supportedProfiles = REQUIRED_PROFILES }) {
  root = resolve(root)
  assertDetachedOutput(root, artifact)
  const source = identifySource(root)
  const artifactIdentity = hashArtifact(artifact)
  requireValue(isHash(provenanceSha256), 'An independently reviewed packaging provenance digest is required')
  const provenanceBytes = readBoundedFile(provenancePath)
  requireValue(sha256(provenanceBytes) === provenanceSha256, 'Packaging provenance digest mismatch')
  const provenance = JSON.parse(provenanceBytes.toString('utf8'))
  validateArtifactProvenance(provenance, source, artifactIdentity.sha256, artifactIdentity.bytes)
  assertSameSource(source, identifySource(root))
  return validateTargetDocument({
    schemaVersion: 1, kind: 'xpanel-verification-target', createdAt: new Date().toISOString(),
    source, artifact: { bytes: artifactIdentity.bytes }, provenance: { sha256: provenanceSha256, document: provenance },
    target: { sourceFingerprint: source.sourceFingerprint, artifactSha256: artifactIdentity.sha256, supportedProfiles: [...supportedProfiles] },
  })
}

if (isMain(import.meta.url)) await runCli(() => {
  const args = parseArguments(process.argv.slice(2), ['root', 'artifact', 'provenance', 'provenance-sha256', 'output'], ['root', 'artifact', 'provenance', 'provenance-sha256', 'output'])
  const document = createVerificationTarget({ ...args, provenancePath: args.provenance, provenanceSha256: args['provenance-sha256'] })
  const output = writeDetachedJson(args.root, args.output, document, args.artifact)
  process.stdout.write(JSON.stringify({ status: 'target-created', output, target: document.target }) + '\n')
})
