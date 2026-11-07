import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isMain, parseCommandArguments, runCli } from './cli.mjs'
import { requireValue, requirementProfiles, STAGE_ENVIRONMENTS, validateRequirements, validateTargetDocument } from './contracts.mjs'
import { readBoundedFile } from './files.mjs'
import { validateEvidenceBundle } from './runtime.mjs'
import { REQUIRED_PROFILES, sha256 } from './shared.mjs'

/**
 * Generated evidence status surface.
 *
 * This module reads only reviewed requirements and detached EvidenceBundle v1
 * documents (plus their receipt/report manifests). Every supplied entry is
 * validated with the same contracts used by recording and admission. A tool is
 * reported `verified` only when every declared profile has complete, passed
 * acceptance in every tier. Incomplete bundles are reported as `blocked`; they
 * can never be promoted by this surface. It never writes catalog delivery data
 * and it is not itself acceptance evidence.
 */

export const TIER_ORDER = Object.freeze(['implemented', 'integrated', 'verified'])
export const SLOT_ORDER = Object.freeze(TIER_ORDER.flatMap(tier => STAGE_ENVIRONMENTS[tier].map(environment => `${tier}:${environment}`)))

const REVIEWED_REQUIREMENT_MODULES = Object.freeze({
  'server-information': async () => (await import('./server-information-contract.mjs')).SERVER_INFORMATION_REQUIREMENTS,
})

/** Reviewed requirements come from an operator JSON file or an explicit named in-repo inventory. */
export async function resolveReviewedRequirements(input) {
  if (Array.isArray(input)) return validateRequirements(input)
  requireValue(typeof input === 'string' && input.trim() === input && input.length > 0, 'A reviewed requirement inventory is required')
  if (input.endsWith('.json') || /[\\/]/.test(input)) {
    return validateRequirements(JSON.parse(readBoundedFile(resolve(input), { maxBytes: 1024 * 1024 }).toString('utf8')))
  }
  const loader = REVIEWED_REQUIREMENT_MODULES[input]
  requireValue(loader !== undefined, 'Unknown reviewed requirement inventory name')
  return validateRequirements(structuredClone(await loader()))
}

/** A deployed verification target document; all five qualification profiles are required. */
export function readTargetDocument(input) {
  return validateTargetDocument(JSON.parse(readBoundedFile(resolve(input), { maxBytes: 8 * 1024 * 1024 }).toString('utf8')))
}

function readBundle(input, evidenceRoot) {
  const path = resolve(input)
  const bytes = readBoundedFile(path, { maxBytes: 8 * 1024 * 1024 })
  return { path, sha256: sha256(bytes), document: JSON.parse(bytes.toString('utf8')), evidenceRoot }
}

function slotOf(row) {
  return `${row.stage}:${row.environment}`
}

function tierState(slotStates, tier) {
  const required = STAGE_ENVIRONMENTS[tier].map(environment => `${tier}:${environment}`)
  const passed = required.filter(slot => slotStates[slot] === 'passed').length
  if (passed === required.length) return 'complete'
  if (passed === 0 && required.every(slot => slotStates[slot] === 'missing')) return 'missing'
  return `partial ${passed}/${required.length}`
}

/**
 * Validate reviewed requirements, the optional deployment target and every
 * detached bundle, then derive per-profile/per-tier status. All inputs are
 * validated even when the resulting table is incomplete; invalid, mixed, stale
 * or duplicate evidence throws instead of degrading into a report.
 */
export async function buildEvidenceStatus({ requirements, targetDocument, bundlePaths = [], evidenceRoot } = {}) {
  const reviewed = await resolveReviewedRequirements(requirements)
  const deployed = targetDocument === undefined ? undefined : validateTargetDocument(targetDocument)
  requireValue(deployed !== undefined || bundlePaths.length === 0, 'A deployed verification target is required when bundles are supplied')
  requireValue(bundlePaths.length > 0 || evidenceRoot === undefined, 'A receipt directory requires at least one bundle')

  const bundles = bundlePaths.map(input => readBundle(input, evidenceRoot))
  const documents = bundles.map(bundle => validateEvidenceBundle(bundle.document, {
    expectedRequirements: reviewed,
    evidenceRoot: bundle.evidenceRoot,
    requireComplete: false,
    requireAllProfiles: false,
  }))
  for (const document of documents) {
    const target = document.target
    requireValue(documents[0].target.sourceFingerprint === target.sourceFingerprint && documents[0].target.artifactSha256 === target.artifactSha256,
      'Supplied bundles qualify mixed source or artifact targets; they must not be combined')
    if (deployed !== undefined) {
      requireValue(deployed.target.sourceFingerprint === target.sourceFingerprint && deployed.target.artifactSha256 === target.artifactSha256,
        'Evidence bundle is stale: it qualifies a different source or artifact than the deployment target')
      requireValue(target.supportedProfiles.every(profile => deployed.target.supportedProfiles.includes(profile)),
        'Evidence bundle names a qualification profile outside the deployment target')
    }
  }

  const profiles = deployed === undefined ? [...REQUIRED_PROFILES] : [...deployed.target.supportedProfiles]
  const evidence = [], slots = new Set(), receiptIds = new Set()
  for (const document of documents) for (const row of document.evidence) {
    const key = [row.toolId, row.stage, row.environment, row.profile].join(':')
    requireValue(!slots.has(key), 'Duplicate acceptance evidence across supplied bundles')
    slots.add(key); evidence.push(row)
  }
  for (const document of documents) for (const entry of document.receipts) {
    requireValue(!receiptIds.has(entry.receipt.receiptId), 'Duplicate receipt identity across supplied bundles')
    receiptIds.add(entry.receipt.receiptId)
  }

  const rowsByTool = new Map()
  for (const row of evidence) {
    if (!rowsByTool.has(row.toolId)) rowsByTool.set(row.toolId, [])
    rowsByTool.get(row.toolId).push(row)
  }

  const tools = reviewed.map(requirement => {
    const rows = rowsByTool.get(requirement.toolId) ?? []
    const profileRows = requirementProfiles(requirement, { supportedProfiles: profiles }).map(profile => {
      const values = rows.filter(row => row.profile === profile)
      const slotStates = Object.fromEntries(SLOT_ORDER.map(slot => {
        const slotRows = values.filter(row => slotOf(row) === slot)
        const state = slotRows.some(row => row.result === 'passed') ? 'passed' : slotRows.length > 0 ? 'failed' : 'missing'
        return [slot, state]
      }))
      const tiers = Object.fromEntries(TIER_ORDER.map(tier => [tier, tierState(slotStates, tier)]))
      let status = values.length === 0 ? 'researched' : 'blocked'
      for (const tier of TIER_ORDER) { if (tiers[tier] !== 'complete') break; status = tier }
      return { profile, status, tiers, slots: slotStates }
    })
    const status = profileRows.every(profile => profile.status === 'verified')
      ? 'verified'
      : rows.length === 0 ? 'researched' : 'blocked'
    return { toolId: requirement.toolId, status, evidenceRows: rows.length, profiles: profileRows }
  })

  const summary = {
    requirements: tools.length,
    bundles: bundles.length,
    verified: tools.filter(tool => tool.status === 'verified').length,
    blocked: tools.filter(tool => tool.status === 'blocked').length,
    researched: tools.filter(tool => tool.status === 'researched').length,
  }
  return {
    schemaVersion: 1,
    kind: 'xpanel-evidence-status',
    target: deployed === undefined ? null : deployed.target,
    requirements: tools,
    bundles: bundles.map(bundle => ({ path: bundle.path, sha256: bundle.sha256 })),
    summary,
  }
}

const STATUS_MEANING = [
  '`verified` requires complete passed evidence for every declared profile in every tier.',
  '`blocked` means some acceptance evidence exists but at least one profile, tier or environment is incomplete.',
  '`researched` means no detached acceptance evidence exists for the tool.',
]

export function formatStatusMarkdown(status) {
  const target = status.target === null
    ? 'none supplied (targetless view; no tool can be verified)'
    : `source \`${status.target.sourceFingerprint}\`, artifact \`${status.target.artifactSha256}\`, profiles ${status.target.supportedProfiles.map(profile => `\`${profile}\``).join(', ')}`
  const lines = [
    '# Detached evidence status',
    '',
    'Generated by `scripts/evidence/status.mjs` from reviewed requirements and detached `EvidenceBundle` v1 inputs. This view is not acceptance evidence and does not change the shipped catalog delivery data.',
    '',
    `- Reviewed requirements: ${status.summary.requirements}`,
    `- Detached bundles: ${status.summary.bundles}`,
    ...status.bundles.map(bundle => `  - \`${bundle.sha256}\` ${bundle.path}`),
    `- Deployment target: ${target}`,
    `- Tool status: ${status.summary.verified} verified, ${status.summary.blocked} blocked, ${status.summary.researched} researched`,
    '',
    ...STATUS_MEANING.map(line => `- ${line}`),
    '',
    '## Tool status',
    '',
    '| Tool | Status | Profiles verified | Evidence rows |',
    '|---|---|---:|---:|',
    ...status.requirements.map(tool => {
      const verified = tool.profiles.filter(profile => profile.status === 'verified').length
      return `| ${tool.toolId} | ${tool.status} | ${verified}/${tool.profiles.length} | ${tool.evidenceRows} |`
    }),
    '',
    '## Profile and tier status',
    '',
    `| Tool | Profile | Claim | ${TIER_ORDER.map(tier => `${tier} (${STAGE_ENVIRONMENTS[tier].join(', ')})`).join(' | ')} |`,
    '|---|---|---|' + TIER_ORDER.map(() => '---').join('|') + '|',
    ...status.requirements.flatMap(tool => tool.profiles.map(profile => `| ${tool.toolId} | ${profile.profile} | ${profile.status} | ${TIER_ORDER.map(tier => profile.tiers[tier]).join(' | ')} |`)),
    '',
    '## Acceptance slots',
    '',
    `| Tool | Profile | ${SLOT_ORDER.join(' | ')} |`,
    '|---|---|' + SLOT_ORDER.map(() => '---').join('|') + '|',
    ...status.requirements.flatMap(tool => tool.profiles.map(profile => `| ${tool.toolId} | ${profile.profile} | ${SLOT_ORDER.map(slot => profile.slots[slot]).join(' | ')} |`)),
    '',
  ]
  return lines.join('\n')
}

/** CI gate: only a fully verified table passes. Invalid, mixed or stale inputs throw before this point. */
export function checkEvidenceStatus(status) {
  const notVerified = status.requirements.filter(tool => tool.status !== 'verified').map(tool => tool.toolId)
  return {
    status: notVerified.length === 0 ? 'passed' : 'not-verified',
    verified: status.summary.verified,
    notVerified,
    bundles: status.summary.bundles,
  }
}

function writeStatusOutput(output, text) {
  const path = resolve(output)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}

if (isMain(import.meta.url)) await runCli(async () => {
  const args = parseCommandArguments(process.argv.slice(2), {
    values: ['requirements', 'target', 'evidence-root', 'format', 'output'],
    repeatable: ['bundle'],
    flags: ['check'],
    required: ['requirements'],
  })
  const format = args.format ?? 'markdown'
  requireValue(['markdown', 'json'].includes(format), 'Use --format=markdown or --format=json')
  const status = await buildEvidenceStatus({
    requirements: args.requirements,
    targetDocument: args.target === undefined ? undefined : readTargetDocument(args.target),
    bundlePaths: args.bundle ?? [],
    evidenceRoot: args['evidence-root'],
  })
  if (args.check) {
    requireValue(args.output === undefined, '--check is read-only and cannot be combined with --output')
    const result = checkEvidenceStatus(status)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.notVerified.length > 0) process.exitCode = 1
    return
  }
  const text = format === 'json' ? `${JSON.stringify(status, null, 2)}\n` : formatStatusMarkdown(status)
  if (args.output === undefined) process.stdout.write(text)
  else process.stdout.write(`${JSON.stringify({ status: 'written', output: writeStatusOutput(args.output, text), ...status.summary })}\n`)
})
