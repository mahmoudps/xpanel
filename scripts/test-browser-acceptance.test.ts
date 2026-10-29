import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { BROWSER_ACCEPTANCE, REQUIRED_IDS, SHARD_COUNT, validateManifest } from './browser-acceptance-manifest.mjs'
import { aggregateReceipts, buildPlan, manifestHash, parseOptions, runShard, sourceIdentity, readSourceBytes } from './browser-acceptance-runner.mjs'

const identity = { commit: 'a'.repeat(40), source_sha256: 'b'.repeat(64), source_files: 19 }
const fixtures: string[] = []
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-browser-runner-test-'))
  fixtures.push(root)
  await writeFile(join(root, '.node-version'), process.versions.node)
  return root
}
afterEach(async () => {
  for (const path of fixtures.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep) || !path.split(sep).at(-1)!.startsWith('xpanel-browser-runner-test-')) throw Error('Unsafe test fixture cleanup')
    await rm(path, { recursive: true, force: false })
  }
})
const receipts = () => [1, 2, 3].map(shard => ({
  schema_version: 1, scope: 'browser-command-partition', execution_kind: 'process', run_id: 'ci-1', shard, shard_count: SHARD_COUNT,
  ...identity, manifest_sha256: manifestHash(), node: process.version, platform: process.platform, arch: process.arch, source_unchanged: true, status: 'passed', duration_ms: 123,
  steps: BROWSER_ACCEPTANCE.filter(entry => entry.shard === shard).map(entry => ({ id: entry.id, status: 'passed', exit_code: 0, signal: null, error_kind: null, duration_ms: 10 })),
}))

describe('canonical browser acceptance partitions', () => {
  it('covers the original 18 commands and all completion workspaces exactly once', () => {
    expect(validateManifest().entries).toBe(26)
    expect(REQUIRED_IDS).toHaveLength(26)
    const plans = [1, 2, 3].map(shard => buildPlan(shard, 'ci-1'))
    expect(plans.flatMap(plan => plan.steps.map(step => step.id)).sort()).toEqual([...REQUIRED_IDS].sort())
    expect(new Set(plans.flatMap(plan => plan.steps.map(step => step.output))).size).toBe(26)
    expect(plans[0]!.steps.map(step => step.id)).toEqual(['composed', 'account-contact'])
    const entries = Object.fromEntries(BROWSER_ACCEPTANCE.map(entry => [entry.id, entry]))
    expect(entries.application!.command).toEqual(['pnpm', 'test:browser'])
    expect(entries['mail-refresh']!.command).toEqual(['pnpm', 'exec', 'vitest', 'run', 'apps/web/src/xmail-live-refresh.test.ts', '--maxWorkers=1'])
    expect(entries['mail-refresh']!.env).toEqual({ XPANEL_REQUIRE_BROWSER_TESTS: '1' })
    expect(BROWSER_ACCEPTANCE.filter(entry => entry.command[0] === 'node').map(entry => entry.command[1]).sort()).toEqual([
      'accounts-acceptance', 'completion-account-contact', 'completion-domain-workspace', 'completion-database-workspace', 'completion-mail-folder-workspace', 'completion-mail-contacts', 'completion-email-filters', 'completion-file-workspace', 'completion-forwarders', 'composed-acceptance', 'extensions-acceptance', 'ip-allocation-acceptance',
      'login-surface-acceptance', 'mail-compose-functional', 'mail-layout-acceptance', 'mfa-runtime-acceptance',
      'native-control-states-acceptance', 'native-workflows-acceptance', 'navigation-acceptance', 'phase1-acceptance',
      'resource-usage-acceptance', 'shell-motion-acceptance', 'shell-motion-exception-acceptance', 'technical-values-acceptance',
    ].map(name => 'tests/browser/' + name + '.mjs').sort())
    for (const entry of BROWSER_ACCEPTANCE.filter(entry => entry.command[0] === 'node')) expect(entry.command).toHaveLength(2)
    for (const entry of BROWSER_ACCEPTANCE.filter(entry => entry.id !== 'mail-refresh')) expect(entry.env).toEqual({})
    const steps = plans.flatMap(plan => plan.steps)
    expect(steps.find(step => step.id === 'mail-layout')!.command.at(-1)).toMatch(/^--output=test-results\//)
    expect(steps.find(step => step.id === 'application')!.env.XPANEL_BROWSER_OUTPUT).toContain('shard-3')
    expect(steps.find(step => step.id === 'forwarders')!.env.XPANEL_FORWARDERS_OUTPUT).toContain('shard-3')
    expect(steps.find(step => step.id === 'email-filters')!.env.XPANEL_FILTERS_OUTPUT).toContain('shard-3')
    expect(steps.find(step => step.id === 'file-workspace')!.env.XPANEL_FILE_WORKSPACE_OUTPUT).toContain('shard-3')
    expect(steps.find(step => step.id === 'account-contact')!.env.XPANEL_ACCOUNT_CONTACT_OUTPUT).toContain('shard-1')
    expect(steps.find(step => step.id === 'mail-compose')!.command.at(-2)).toBe('--out')
    expect(steps.find(step => step.id === 'mail-refresh')!.command.at(-2)).toBe('--reporter=json')
  })
  it.each([
    (entries: any[]) => entries.slice(1),
    (entries: any[]) => { entries[1] = entries[0]; return entries },
    (entries: any[]) => { entries[0].id = 'unknown'; return entries },
    (entries: any[]) => { entries[0].shard = 4; return entries },
    (entries: any[]) => { entries[1].output.prefix = entries[0].output.prefix; return entries },
  ])('rejects omitted, duplicate and malformed inventory', mutate => {
    expect(() => validateManifest(mutate(clone(BROWSER_ACCEPTANCE)))).toThrow()
  })
  it.each(['../escape', 'a/b', 'a\\b', '.', 'a b', ''])('rejects unsafe output run IDs: %s', runId => {
    expect(() => buildPlan(1, runId)).toThrow()
  })
  it.each([['--shard=0/3'], ['--shard=1/4'], ['--shard=1/3', '--shard=2/3'], ['--run-id=../x'], ['--unknown'], ['--aggregate=x', '--list']])('rejects unsupported CLI selection: %j', args => {
    expect(() => parseOptions(args)).toThrow()
  })
  it('validates coverage in a dry CLI without starting browsers or creating output', () => {
    const child = spawnSync(process.execPath, [resolve(import.meta.dirname, 'browser-acceptance-runner.mjs'), '--validate'], { encoding: 'utf8', windowsHide: true })
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'coverage_validated', proof_executed: false, entries: 26, shards: 3 })
  })
  it('serializes commands, isolates fixture environments and refuses overwritten evidence', async () => {
    const root = await fixture(), plan = buildPlan(2, 'unit-serial', root)
    let active = 0, peak = 0
    const temporary: string[] = []
    const execute = async (step: any, env: NodeJS.ProcessEnv) => {
      active++; peak = Math.max(active, peak); temporary.push(env.TEMP!)
      expect(env.TMP).toBe(env.TEMP); expect(env.TMPDIR).toBe(env.TEMP)
      await new Promise<void>(done => setImmediate(done))
      await mkdir(step.output, { recursive: true })
      active--
      return { exit_code: 0, signal: null, error_kind: null }
    }
    const result = await runShard(plan, { root, execute, identityReader: () => identity })
    expect(result.status).toBe('passed')
    expect(result.execution_kind).toBe('test-double')
    expect(peak).toBe(1)
    expect(new Set(temporary).size).toBe(plan.steps.length)
    expect(result.steps.every((step: any) => step.status === 'passed' && step.duration_ms >= 0)).toBe(true)
    expect(JSON.parse(await readFile(join(plan.directory, 'partition-receipt.json'), 'utf8')).steps).toHaveLength(plan.steps.length)
    await expect(runShard(plan, { root, execute, identityReader: () => identity })).rejects.toThrow()
  })
  it.each([{ exit_code: 1, signal: null }, { exit_code: null, signal: 'SIGTERM' }, { exit_code: 0, signal: null }])('fails on unsuccessful exit or absent evidence and records remaining not_run: %j', async outcome => {
    const root = await fixture(), plan = buildPlan(3, 'unit-fail', root)
    let calls = 0
    const receipt = await runShard(plan, { root, identityReader: () => identity, execute: async () => { calls++; return outcome } })
    expect(calls).toBe(1)
    expect(receipt.status).toBe('failed')
    expect(receipt.steps[0].status).toBe('failed')
    expect(receipt.steps.slice(1).every((step: any) => step.status === 'not_run' && step.exit_code === null)).toBe(true)
  })
  it('hashes only regular source files contained inside the checkout', async () => {
    const root = await fixture()
    expect(readSourceBytes(root, '.node-version').toString()).toBe(process.versions.node)
    expect(() => readSourceBytes(root, '.')).toThrow()
    expect(() => readSourceBytes(root, '../outside')).toThrow()
  })
  it('exercises real aggregate CLI file IO with explicitly synthetic structural receipts', async () => {
    // Metadata/parser fixture only: no browser command executes and these receipts are never uploaded.
    const directory = await fixture()
    const actual = sourceIdentity()
    const items = receipts().map(receipt => ({ ...receipt, ...actual }))
    for (const item of items) {
      const output = join(directory, 'shard-' + item.shard)
      await mkdir(output)
      await writeFile(join(output, 'partition-receipt.json'), JSON.stringify(item))
    }
    const env = { ...process.env }
    delete env.GITHUB_STEP_SUMMARY
    const command = [resolve(import.meta.dirname, 'browser-acceptance-runner.mjs'), '--aggregate=' + directory, '--run-id=ci-1']
    const child = spawnSync(process.execPath, command, { encoding: 'utf8', windowsHide: true, env })
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'passed', commands: 26, ...actual })
    await rm(join(directory, 'shard-1', 'partition-receipt.json'))
    expect(spawnSync(process.execPath, command, { encoding: 'utf8', windowsHide: true, env }).status).toBe(1)
  })
  it('accepts only the complete same-source successful three-shard union', () => {
    expect(aggregateReceipts(receipts(), { runId: 'ci-1', identity })).toMatchObject({ status: 'passed', commands: 26, shards: 3 })
  })
  it.each([
    (items: any[]) => items.slice(1),
    (items: any[]) => { items[1] = items[0]; return items },
    (items: any[]) => { items[0].run_id = 'wrong'; return items },
    (items: any[]) => { items[0].source_sha256 = 'c'.repeat(64); return items },
    (items: any[]) => { items[0].commit = 'c'.repeat(40); return items },
    (items: any[]) => { items[0].manifest_sha256 = 'c'.repeat(64); return items },
    (items: any[]) => { items[0].node = 'v0.0.0'; return items },
    (items: any[]) => { items[0].platform = 'wrong-platform'; return items },
    (items: any[]) => { items[0].arch = 'wrong-arch'; return items },
    (items: any[]) => { items[0].source_unchanged = false; return items },
    (items: any[]) => { items[0].status = 'running'; return items },
    (items: any[]) => { items[0].execution_kind = 'test-double'; return items },
    (items: any[]) => { items[1].steps.pop(); return items },
    (items: any[]) => { items[1].steps[0] = items[0].steps[0]; return items },
    (items: any[]) => { items[0].steps[0].status = 'not_run'; return items },
    (items: any[]) => { items[0].steps[0].exit_code = null; return items },
    (items: any[]) => { items[0].steps[0].signal = 'SIGTERM'; return items },
    (items: any[]) => { items[0].steps[0].duration_ms = -1; return items },
  ])('fails closed on incomplete, stale, duplicate, interrupted or fabricated receipt metadata', mutate => {
    expect(() => aggregateReceipts(mutate(clone(receipts())), { runId: 'ci-1', identity })).toThrow()
  })
})
