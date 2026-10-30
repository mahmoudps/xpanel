import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'
import { inspectAcceptanceCoverage } from './acceptance-coverage.mjs'

// ---------------------------------------------------------------------------
// Types for Q03/Q04 Governance Artifacts
// ---------------------------------------------------------------------------

interface MappedGate {
  readonly id: string
  readonly name: string
  readonly releaseBlocking: boolean
  readonly scenarios: readonly string[]
}

interface MappedFaultClass {
  readonly id: string
  readonly name: string
  readonly injectionMechanism: string
  readonly expectedRecovery: string
  readonly coveredScenarios: readonly string[]
  readonly portableHarness: string
}

interface MappedScenario {
  readonly id: string
  readonly gate: string
  readonly packages: readonly string[]
  readonly priority: 'P0' | 'P1' | 'P2'
  readonly environments: readonly ('U' | 'H' | 'B' | 'V' | 'E')[]
  readonly title: string
  readonly independentOracle: string
  readonly harnesses: readonly string[]
  readonly faultClassIds: readonly string[]
  readonly portablePrimitiveVerified: boolean
  readonly evidenceAssessment: 'declarative_unaccepted'
  readonly independentAcceptance: false
  readonly verificationStatus:
    | 'primitive_verified'
    | 'portable_verified'
    | 'pending_live_service_proof'
    | 'pending_pilot'
}

interface AcceptanceScenarioMappingDoc {
  readonly schemaVersion: number
  readonly ownerPackages: readonly string[]
  readonly sourceDocument: string
  readonly statusTaxonomy: Readonly<Record<string, string>>
  readonly gates: readonly MappedGate[]
  readonly faultMatrix: readonly MappedFaultClass[]
  readonly scenarios: readonly MappedScenario[]
}

interface ParsedMatrixRow {
  readonly id: string
  readonly gate: string
  readonly packages: readonly string[]
  readonly priority: string
  readonly environments: readonly string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT_DIR = resolve(import.meta.dirname, '..')

function parseAcceptanceMatrixMarkdown(markdown: string): ParsedMatrixRow[] {
  const lines = markdown.split(/\r?\n/)
  let currentGate = ''
  const rows: ParsedMatrixRow[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    const gateMatch = /^###\s+(G[0-7]):/.exec(trimmed)
    if (gateMatch) {
      currentGate = gateMatch[1]!
      continue
    }

    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').map((c) => c.trim())
    // Table format: | A01 | B01, B03 | P1 | actor/action | oracle | envCell | guardrails |
    const idCell = cells[1]?.replace(/\*/g, '').trim() ?? ''
    if (!/^A\d{2}$/.test(idCell)) continue

    const packages = (cells[2] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    const priority = (cells[3] ?? '').replace(/\*/g, '').trim()
    const envCell = cells[6] ?? ''
    const environments = Array.from(new Set(envCell.match(/\b[UHBVE]\b/g) ?? []))

    rows.push({
      id: idCell,
      gate: currentGate,
      packages,
      priority,
      environments,
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Q03 & Q04 Acceptance Mapping, Fault Matrix, Runbooks & Release Governance', () => {
  it('verifies 1:1 parity between docs/planning/ACCEPTANCE-MATRIX.md and docs/planning/acceptance-scenario-mapping.json across A01-A60', async () => {
    const [matrixMd, mappingRaw] = await Promise.all([
      readFile(resolve(ROOT_DIR, 'docs/planning/ACCEPTANCE-MATRIX.md'), 'utf8'),
      readFile(resolve(ROOT_DIR, 'docs/planning/acceptance-scenario-mapping.json'), 'utf8'),
    ])

    const parsedMatrix = parseAcceptanceMatrixMarkdown(matrixMd)
    assert.equal(parsedMatrix.length, 60, 'ACCEPTANCE-MATRIX.md must contain 60 scenario rows A01-A60')

    const mapping = JSON.parse(mappingRaw) as AcceptanceScenarioMappingDoc
    assert.equal(mapping.schemaVersion, 1)
    assert.equal(mapping.scenarios.length, 60, 'acceptance-scenario-mapping.json must map all 60 scenarios')

    // Verify sequential IDs A01..A60 and exact match against ACCEPTANCE-MATRIX.md
    for (let i = 0; i < 60; i++) {
      const expectedId = `A${String(i + 1).padStart(2, '0')}`
      const mdRow = parsedMatrix[i]!
      const mapped = mapping.scenarios[i]!

      assert.equal(mdRow.id, expectedId)
      assert.equal(mapped.id, expectedId)
      assert.equal(mapped.gate, mdRow.gate, `gate mismatch on ${expectedId}`)
      assert.deepEqual(mapped.packages, mdRow.packages, `packages mismatch on ${expectedId}`)
      assert.equal(mapped.priority, mdRow.priority, `priority mismatch on ${expectedId}`)
      assert.deepEqual(
        mapped.environments,
        mdRow.environments,
        `environments mismatch on ${expectedId}`,
      )
      assert.ok(mapped.title.trim().length >= 10, `title too short on ${expectedId}`)
      assert.ok(
        mapped.independentOracle.trim().length >= 20,
        `independentOracle too short on ${expectedId}`,
      )
      assert.ok(mapped.harnesses.length >= 1, `missing harness mapping on ${expectedId}`)
    }

    // Verify gate index G0..G7 matches scenario gates
    assert.equal(mapping.gates.length, 8)
    for (const gate of mapping.gates) {
      assert.equal(gate.releaseBlocking, true)
      const scenariosInGate = mapping.scenarios
        .filter((s) => s.gate === gate.id)
        .map((s) => s.id)
      assert.deepEqual(gate.scenarios, scenariosInGate, `gate ${gate.id} scenario list mismatch`)
    }
  })

  it('enforces the fault injection matrix (F01-F06) and honest verification status taxonomy', async () => {
    const mappingRaw = await readFile(
      resolve(ROOT_DIR, 'docs/planning/acceptance-scenario-mapping.json'),
      'utf8',
    )
    const mapping = JSON.parse(mappingRaw) as AcceptanceScenarioMappingDoc

    // Verify status taxonomy keys
    assert.deepEqual(Object.keys(mapping.statusTaxonomy).sort(), [
      'pending_live_service_proof',
      'pending_pilot',
      'portable_verified',
      'primitive_verified',
    ])

    // Verify all 6 fault classes F01..F06 exist and cross-reference scenarios accurately
    assert.deepEqual(
      mapping.faultMatrix.map((f) => f.id),
      ['F01', 'F02', 'F03', 'F04', 'F05', 'F06'],
    )
    const scenariosById = new Map(mapping.scenarios.map((s) => [s.id, s]))

    for (const fault of mapping.faultMatrix) {
      assert.ok(fault.injectionMechanism.length >= 20)
      assert.ok(fault.expectedRecovery.length >= 20)
      assert.ok(fault.coveredScenarios.length >= 1)
      for (const scenId of fault.coveredScenarios) {
        const scen = scenariosById.get(scenId)
        assert.ok(scen, `fault ${fault.id} references unknown scenario ${scenId}`)
        assert.ok(
          scen.faultClassIds.includes(fault.id),
          `scenario ${scenId} must list ${fault.id} in faultClassIds`,
        )
      }
    }

    // Verify honest status reporting:
    // - A60 must be 'pending_pilot'
    // - Any scenario requiring 'V' or 'E' (except A60) must be 'pending_live_service_proof'
    // - Scenarios requiring only subsets of {'U', 'H', 'B'} must be 'portable_verified'
    for (const scen of mapping.scenarios) {
      assert.equal(scen.portablePrimitiveVerified, false, 'source mapping cannot claim execution of a primitive')
      assert.equal(scen.evidenceAssessment, 'declarative_unaccepted')
      assert.equal(scen.independentAcceptance, false)
      if (scen.id === 'A60') {
        assert.equal(
          scen.verificationStatus,
          'pending_pilot',
          'A60 (30-60 day pilot) must be marked pending_pilot',
        )
      } else if (scen.environments.includes('V') || scen.environments.includes('E')) {
        assert.equal(
          scen.verificationStatus,
          'pending_live_service_proof',
          `${scen.id} requires live VM/external observer (${scen.environments.join(',')}) and must be pending_live_service_proof`,
        )
      } else {
        assert.equal(
          scen.verificationStatus,
          'portable_verified',
          `${scen.id} uses portable environments (${scen.environments.join(',')}) and must be portable_verified`,
        )
      }
    }

    // All scenario and fault references need existing substantive declaration anchors.
    // This structural result never substitutes for execution or independent acceptance.
    const coverage = inspectAcceptanceCoverage(ROOT_DIR)
    assert.deepEqual(coverage.issues, [])
    assert.equal(coverage.scenarios, 60)
    assert.equal(coverage.faults, 6)
    assert.equal(coverage.independentlyAccepted, 0)
  })

  it('verifies all 10 required operational runbooks in docs/operations/runbooks.md and enforces zero embedded secrets (A59)', async () => {
    const [runbooksMd, mappingRaw] = await Promise.all([
      readFile(resolve(ROOT_DIR, 'docs/operations/runbooks.md'), 'utf8'),
      readFile(resolve(ROOT_DIR, 'docs/planning/acceptance-scenario-mapping.json'), 'utf8'),
    ])

    const requiredRunbookIds = [
      'install',
      'first-login-and-mfa',
      'secret-rotation',
      'backup',
      'restore-and-disaster-recovery',
      'upgrade',
      'rollback',
      'disk-full-recovery',
      'agent-outage-triage',
      'certificate-expiry-and-mail-queue-recovery',
    ] as const

    for (const id of requiredRunbookIds) {
      assert.match(
        runbooksMd,
        new RegExp(`\\*\\*Runbook ID\\*\\*:\\s*\`${id}\``),
        `missing required operational runbook '${id}' in docs/operations/runbooks.md`,
      )
    }

    // Verify each runbook has Preconditions, Execution Steps, and Verification Oracle sections
    const preconditionsCount = (runbooksMd.match(/^### Preconditions$/gm) ?? []).length
    const executionStepsCount = (runbooksMd.match(/^### Execution Steps$/gm) ?? []).length
    const oracleCount = (runbooksMd.match(/^### Verification Oracle$/gm) ?? []).length

    assert.equal(preconditionsCount, 10, 'all 10 runbooks must include ### Preconditions')
    assert.equal(executionStepsCount, 10, 'all 10 runbooks must include ### Execution Steps')
    assert.equal(oracleCount, 10, 'all 10 runbooks must include ### Verification Oracle')

    // Verify Release Governance section is present and documents the 4 verification statuses
    assert.match(runbooksMd, /## Release Governance & Honest Verification Status Policy/)
    assert.match(runbooksMd, /`primitive_verified`/)
    assert.match(runbooksMd, /`portable_verified`/)
    assert.match(runbooksMd, /`pending_live_service_proof`/)
    assert.match(runbooksMd, /`pending_pilot`/)

    // Secret scan across both governance documents
    const combinedText = `${runbooksMd}\n${mappingRaw}`
    const forbiddenSecretPatterns: readonly { name: string; pattern: RegExp }[] = [
      { name: 'PEM private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?KEY-----/ },
      { name: 'Embedded Argon2 hash', pattern: /\$argon2(?:id|i|d)\$v=\d+\$/ },
      { name: 'AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
      { name: 'GitHub PAT', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
      { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/ },
    ]

    for (const check of forbiddenSecretPatterns) {
      assert.doesNotMatch(
        combinedText,
        check.pattern,
        `forbidden secret pattern (${check.name}) detected in Q03/Q04 documentation`,
      )
    }
  })
})
