import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { specs, tools } from '../packages/catalog/src/data/index.ts'
import { assessDelivery, requiredProfiles } from '../packages/catalog/src/delivery.ts'
import { isMain, parseCommandArguments, readJson, runCli } from './evidence/cli.mjs'
import { requireValue, STAGE_ENVIRONMENTS, validateTargetDocument } from './evidence/contracts.mjs'
import { identifySource } from './evidence/identity.mjs'
import { validateEvidenceBundle } from './evidence/runtime.mjs'
import { computeSourceDigest, sha256 } from './evidence/shared.mjs'
import { qualificationRequirements } from './qualification-plan.mjs'

export const DELIVERY_PATH = 'packages/catalog/src/data/delivery.ts'
const ROW_FIELDS = ['toolId', 'stage', 'environment', 'profile', 'acceptance', 'result', 'executor', 'sourceFingerprint', 'artifactSha256', 'runArtifact', 'runArtifactSha256', 'observedAt']
const SLOTS = Object.entries(STAGE_ENVIRONMENTS).flatMap(([stage, environments]) => environments.map(environment => ({ stage, environment })))

/** The exact delivery module for a publication; the empty publication is the file every candidate ships. */
export function renderDeliveryModule(evidence, target) {
  const rows = evidence.length === 0 ? '[]' : `[\n${evidence.map(row => `  ${JSON.stringify(row)},`).join('\n')}\n]`
  return `import type { CapabilityEvidence, VerificationTarget } from '../types.ts'\n\n/** Declarations in the previous catalog were not executable acceptance results. */\nexport const deliveryEvidence: readonly CapabilityEvidence[] = ${rows}\nexport const deliveryTarget: VerificationTarget | null = ${target === null ? 'null' : JSON.stringify({ sourceFingerprint: target.sourceFingerprint, artifactSha256: target.artifactSha256, supportedProfiles: target.supportedProfiles })}\n`
}

/** The publication is the only change after qualification: the source with an empty delivery module must be the qualified one. */
export function publishedSourceFingerprint(files) {
  const empty = sha256(renderDeliveryModule([], null))
  return computeSourceDigest(files.map(file => file.path === DELIVERY_PATH ? { ...file, sha256: empty } : file))
}

/**
 * Deterministic publication of complete native qualification for one release. Every bundle is fully re-validated
 * (receipts, raw reports, real executors, passed results, one target); a tool is published only with every slot on
 * every profile it requires, and only if the catalog's own assessment then reports it verified.
 */
export function aggregateDelivery({ targetDocument, bundles, evidenceRoot, sourceFiles }) {
  validateTargetDocument(targetDocument)
  const target = targetDocument.target
  requireValue(targetDocument.source.files.find(file => file.path === DELIVERY_PATH)?.sha256 === sha256(renderDeliveryModule([], null)), 'The qualified source must ship the empty delivery publication')
  requireValue(publishedSourceFingerprint(sourceFiles) === target.sourceFingerprint, 'The publication checkout differs from the qualified source beyond the delivery publication')
  requireValue(Array.isArray(bundles) && bundles.length > 0, 'At least one evidence bundle is required')
  const rows = new Map(), receiptIds = new Set()
  for (const bundle of bundles) {
    requireValue(Array.isArray(bundle?.requirements), 'Unsupported detached evidence bundle')
    const reviewed = qualificationRequirements(bundle.requirements.map(item => item?.toolId))
    requireValue(JSON.stringify(bundle.requirements) === JSON.stringify(reviewed), 'Bundle requirements differ from the reviewed qualification inventory')
    const valid = validateEvidenceBundle(bundle, { expectedTarget: target, expectedRequirements: reviewed, evidenceRoot, requireComplete: false, requireAllProfiles: true })
    requireValue(valid.source.commit === targetDocument.source.commit, 'Bundle source commit differs from the target')
    for (const entry of valid.receipts) { requireValue(!receiptIds.has(entry.receipt.receiptId), 'Duplicate receipt identity across bundles'); receiptIds.add(entry.receipt.receiptId) }
    for (const row of valid.evidence) {
      const key = [row.toolId, row.stage, row.environment, row.profile].join(':')
      requireValue(!rows.has(key), 'Duplicate acceptance slot across bundles')
      rows.set(key, Object.fromEntries(ROW_FIELDS.map(field => [field, row[field]])))
    }
  }
  const published = [], omitted = [], evidence = []
  for (const toolId of [...new Set([...rows.values()].map(row => row.toolId))].sort()) {
    const profiles = requiredProfiles(toolId, target)
    const missing = profiles.flatMap(profile => SLOTS.filter(slot => !rows.has([toolId, slot.stage, slot.environment, profile].join(':'))).map(slot => `${profile}/${slot.stage}/${slot.environment}`))
    if (missing.length > 0) { omitted.push({ toolId, missing }); continue }
    const toolRows = profiles.flatMap(profile => SLOTS.map(slot => rows.get([toolId, slot.stage, slot.environment, profile].join(':'))))
    const tool = tools.find(item => item.id === toolId), spec = specs.find(item => item.id === toolId)
    const definition = { ...tool, status: tool.status === 'out-of-scope' ? 'out-of-scope' : 'researched' }
    requireValue(assessDelivery(definition, spec, toolRows, target).status === 'verified', `The catalog does not assess ${toolId} as verified from its complete evidence`)
    published.push(toolId); evidence.push(...toolRows)
  }
  requireValue(published.length > 0, 'No tool has complete evidence on every profile it requires; nothing can be published')
  return { module: renderDeliveryModule(evidence, target), published, omitted }
}

if (isMain(import.meta.url)) await runCli(() => {
  const args = parseCommandArguments(process.argv.slice(2), { values: ['root', 'target', 'evidence-root', 'output'], repeatable: ['bundle'], flags: ['check'], required: ['target', 'bundle', 'evidence-root'] })
  requireValue((args.output === undefined) !== (args.check === undefined), 'Use exactly one of --output=<delivery.ts> or --check')
  const root = resolve(args.root ?? '.')
  const result = aggregateDelivery({
    targetDocument: readJson(args.target, { maxBytes: 8 * 1024 * 1024 }), bundles: args.bundle.map(path => readJson(path, { maxBytes: 8 * 1024 * 1024 })),
    evidenceRoot: args['evidence-root'], sourceFiles: identifySource(root).files,
  })
  const summary = { published: result.published, omitted: result.omitted }
  if (args.check) {
    const current = readFileSync(resolve(root, DELIVERY_PATH), 'utf8') === result.module
    process.stdout.write(`${JSON.stringify({ status: current ? 'current' : 'stale', ...summary })}\n`)
    if (!current) process.exitCode = 1
    return
  }
  writeFileSync(resolve(args.output), result.module)
  process.stdout.write(`${JSON.stringify({ status: 'written', output: resolve(args.output), ...summary })}\n`)
})
