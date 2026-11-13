import { readdirSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, relative, sep } from 'node:path'
import { defineConfig } from 'vitest/config'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import { testLayerConfig } from './scripts/test-layers.mjs'
import TestLaneReporter from './scripts/test-lane-reporter.mjs'

const root = import.meta.dirname
const selectedLayer = process.env.XPANEL_TEST_LAYER
const layer = testLayerConfig(selectedLayer)
const JSDOM_ENV_PATTERN = /@vitest-environment\s+jsdom\b/
const JSDOM_THREAD_ONLY_FILES = new Set(['apps/web/src/approved-account-creation-client.test.ts'])
const JSDOM_VM_ONLY_FILES = new Set([
  'apps/web/src/mail-compose-editor-client.test.ts',
  'apps/web/src/mail-contacts-tools-client.test.ts',
])
const FORKS_ONLY_PATTERN = /\bprocess\.(?:chdir|umask)\b/
const FORKS_ONLY_FILES = new Set<string>()
const FORKS_SHARED_FILES = new Set([
  'apps/web/src/themes/contract.test.ts',
  'apps/web/src/themes/v2-controller-conformance.test.ts',
])
const HAS_NAMESPACE_IMPORT = /\bimport\s+\*\s+as\b/
const STRICT_ISOLATED_PATTERN = /\bvi\.(?:mock|doMock|stubEnv)\b|setStateOwnershipDepsForTests|completeOperationalMigrations|markOperationalMigrationsApplied|\bprocess\.env\.[A-Za-z0-9_]+\s*=(?!=)|\bdelete\s+process\.env\.|\b(?:setLocalePolicy|installLocaleOverrides|installRuntimeLocale|registerLocale|installSavedLanguages|handlePanelLanguagesRoute)\b/
const NODE_EXTRA_ISOLATED_PATTERN = /@vitest-environment\s+(?!node\b)|builtinEnvironments|\bglobalThis\s+as\b|\bglobalThis\.[A-Za-z0-9_$]+\s*=(?!=)|Object\.defineProperty\(\s*globalThis|Reflect\.set\(\s*globalThis|delete\s+globalThis\./

const needsModuleIsolation = (src: string): boolean =>
  STRICT_ISOLATED_PATTERN.test(src) || (/\bvi\.spyOn\b/.test(src) && HAS_NAMESPACE_IMPORT.test(src))

const HEAVY_HEAD_FILES = new Set([
  'apps/web/src/themes/v2-controller-conformance.test.ts',
  'apps/api/src/ui-preferences-integration.test.ts',
  'apps/api/src/web-boundary.test.ts',
  'apps/api/src/mfa-runtime-policy.test.ts',
  'apps/web/src/whm-firewall-import-revision.test.ts',
  'apps/web/src/mail-calendar-view-client.test.ts',
  'apps/api/src/account-mutation-security.test.ts',
  'apps/api/src/completion-domain-workspace-security.test.ts',
  'apps/api/src/completion-security-email-filters.test.ts',
  'apps/api/src/completion-mail-vacation-security.test.ts',
  'apps/api/src/mailbox-inbox.test.ts',
  'apps/api/src/completion-mail-contacts-security.test.ts',
  'apps/api/src/entry-points-security.test.ts',
  'apps/api/src/mounted-routes.test.ts',
  'apps/web/src/whm-php-client.test.ts',
  'apps/web/src/whm-backups-client.test.ts',
  'apps/web/src/accounts-actions.test.ts',
  'apps/web/src/transfer-selected-theme-client.test.ts',
  'apps/web/src/whm-finite-template-preflight.test.ts',
  'apps/web/src/whm-backup-destinations-client.test.ts',
  'apps/web/src/whm-backups-operations.test.ts',
  'apps/api/src/panel-languages.test.ts',
  'apps/agent/src/systemd-file-worker.test.ts',
  'apps/api/src/completion-database-state-security.test.ts',
  'apps/web/src/account-filters-templates.test.ts',
  'scripts/test-install-package-profile.test.ts',
  'apps/web/src/form-state-census.test.ts',
])
const PROJECT_ORDER: Record<string, number> = { forks: 0, isolated: 1, 'jsdom-vm': 2, 'forks-shared': 3, jsdom: 4, shared: 5 }

class ProjectPrioritySequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const baseSorted = await super.sort(files)
    const baseRank = new Map(baseSorted.map((spec, idx) => [spec, idx]))
    return [...baseSorted].sort((a, b) => {
      const pDiff = (PROJECT_ORDER[a.project.name] ?? 9) - (PROJECT_ORDER[b.project.name] ?? 9)
      if (pDiff !== 0) return pDiff
      const relA = relative(root, a.moduleId).split(sep).join('/')
      const relB = relative(root, b.moduleId).split(sep).join('/')
      const hDiff = (HEAVY_HEAD_FILES.has(relA) ? 0 : 1) - (HEAVY_HEAD_FILES.has(relB) ? 0 : 1)
      if (hDiff !== 0) return hDiff
      return (baseRank.get(a) ?? 0) - (baseRank.get(b) ?? 0)
    })
  }
}

const isLinuxTest = (rel: string): boolean =>
  rel === 'apps/agent/src/linux-isolation.test.ts' || rel === 'apps/agent/src/executor-linux.test.ts' || rel.endsWith('.linux.test.ts')
const isHttpTest = (rel: string): boolean =>
  rel.startsWith('apps/api/src/') || rel === 'apps/agent/src/boundary-security.test.ts'
const inSelectedLayer = (rel: string): boolean => {
  if (selectedLayer === 'linux') return isLinuxTest(rel)
  if (selectedLayer === 'http') return isHttpTest(rel)
  if (isLinuxTest(rel)) return false
  if (selectedLayer === 'unit') return !isHttpTest(rel)
  return true
}

function partitionLayerFiles(): { forkFiles: string[]; forkSharedFiles: string[]; jsdomVmFiles: string[]; jsdomSharedFiles: string[]; isolatedFiles: string[]; sharedFiles: string[] } {
  if (selectedLayer === 'linux') return { forkFiles: [], forkSharedFiles: [], jsdomVmFiles: [], jsdomSharedFiles: [], isolatedFiles: [], sharedFiles: [] }
  const forkFiles: string[] = []
  const forkSharedFiles: string[] = []
  const jsdomVmFiles: string[] = []
  const jsdomSharedFiles: string[] = []
  const isolatedFiles: string[] = []
  const sharedFiles: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.pnpm-store' || entry.name === '.git' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.test.ts')) continue
      const rel = relative(root, full).split(sep).join('/')
      if (!/^(?:apps|packages)\/[^/]+\/src\/.+\.test\.ts$|^scripts\/test-[^/]+\.test\.ts$/.test(rel)) continue
      if (!inSelectedLayer(rel)) continue
      const src = readFileSync(full, 'utf8')
      if (FORKS_SHARED_FILES.has(rel)) forkSharedFiles.push(rel)
      else if (FORKS_ONLY_FILES.has(rel) || FORKS_ONLY_PATTERN.test(src)) forkFiles.push(rel)
      else if (JSDOM_ENV_PATTERN.test(src)) {
        if (JSDOM_VM_ONLY_FILES.has(rel)) jsdomVmFiles.push(rel)
        else if (JSDOM_THREAD_ONLY_FILES.has(rel) || needsModuleIsolation(src)) isolatedFiles.push(rel)
        else jsdomSharedFiles.push(rel)
      } else if (needsModuleIsolation(src) || NODE_EXTRA_ISOLATED_PATTERN.test(src)) isolatedFiles.push(rel)
      else sharedFiles.push(rel)
    }
  }
  for (const top of ['packages', 'apps', 'scripts']) walk(join(root, top))
  forkFiles.sort()
  forkSharedFiles.sort()
  jsdomVmFiles.sort()
  jsdomSharedFiles.sort()
  isolatedFiles.sort()
  sharedFiles.sort()
  return { forkFiles, forkSharedFiles, jsdomVmFiles, jsdomSharedFiles, isolatedFiles, sharedFiles }
}

const { forkFiles, forkSharedFiles, jsdomVmFiles, jsdomSharedFiles, isolatedFiles, sharedFiles } = partitionLayerFiles()
const activeProjects = selectedLayer === 'linux' ? [] : [
  ...(forkFiles.length > 0 ? [{ extends: true as const, test: { name: 'forks', pool: 'forks' as const, isolate: true, execArgv: ['--max-old-space-size=4096'], include: forkFiles, exclude: layer.exclude } }] : []),
  ...(forkSharedFiles.length > 0 ? [{ extends: true as const, test: { name: 'forks-shared', pool: 'forks' as const, isolate: false, execArgv: ['--max-old-space-size=4096', '--max-semi-space-size=64'], runner: './scripts/vitest-node-shared-runner.ts', experimental: { viteModuleRunner: false, nodeLoader: false }, include: forkSharedFiles, exclude: layer.exclude } }] : []),
  ...(jsdomVmFiles.length > 0 ? [{ extends: true as const, test: { name: 'jsdom-vm', pool: 'vmThreads' as const, environment: 'jsdom', include: jsdomVmFiles, exclude: layer.exclude } }] : []),
  ...(jsdomSharedFiles.length > 0 ? [{ extends: true as const, test: { name: 'jsdom', pool: 'threads' as const, isolate: false, environment: 'jsdom', runner: './scripts/vitest-jsdom-runner.ts', experimental: { viteModuleRunner: false, nodeLoader: false }, include: jsdomSharedFiles, exclude: layer.exclude } }] : []),
  ...(isolatedFiles.length > 0 ? [{ extends: true as const, test: { name: 'isolated', pool: 'threads' as const, isolate: true, include: isolatedFiles, exclude: layer.exclude } }] : []),
  ...(sharedFiles.length > 0 ? [{ extends: true as const, test: { name: 'shared', pool: 'threads' as const, isolate: false, runner: './scripts/vitest-node-shared-runner.ts', experimental: { viteModuleRunner: false, nodeLoader: false }, include: sharedFiles, exclude: layer.exclude } }] : []),
]
const useProjects = activeProjects.length > 1

export default defineConfig({
  test: {
    ...(useProjects ? { exclude: layer.exclude } : layer),
    environment: 'node',
    sequence: { sequencer: ProjectPrioritySequencer },
    tags: [
      { name: 'slow', description: 'Explicit expensive case, excluded only from the fast lane.' },
      { name: 'visual', description: 'Real computed browser geometry.' },
      { name: 'unit', description: 'Pure logic, no database or framework boot, under 100 ms.' },
      { name: 'feature', description: 'One application behavior with isolated state, under 1 s.' },
      { name: 'journey', description: 'One slow end-to-end business flow.' },
    ],
    strictTags: true,
    allowOnly: process.env.XPANEL_TEST_LANE ? false : undefined,
    reporters: process.env.XPANEL_TEST_LANE ? ['default', new TestLaneReporter()] : ['default'],
    setupFiles: ['./scripts/vitest-i18n-setup.ts'],
    maxWorkers: Math.min(availableParallelism(), 5),
    testTimeout: 30_000,
    ...(useProjects ? { projects: activeProjects } : activeProjects.length === 1 ? activeProjects[0]!.test : {}),
  },
})
