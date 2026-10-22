import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, '.tools', 'playwright-browsers')
const report = value => process.stdout.write(`XPANEL_TEST_LAYER=${JSON.stringify(value)}\n`)

export async function browserPreflight() {
  try {
    const expectedNode = (await readFile(join(root, '.node-version'), 'utf8')).trim()
    if (process.versions.node !== expectedNode) return { layer: 'browser', status: 'blocked', reasons: ['The pinned workspace Node runtime is required; use scripts/toolchain.mjs.'], exit_code: 2 }
    const { chromium } = await import('@playwright/test')
    import.meta.resolve('axe-core/axe.min.js')
    const executable = chromium.executablePath()
    if (!existsSync(executable)) return { layer: 'browser', status: 'blocked', reasons: ['Matching Chromium is not installed in the configured browser cache.'], exit_code: 2 }
    const probe = await chromium.launch({ headless: true, executablePath: executable, timeout: 20000 })
    const version = probe.version()
    await probe.close()
    return { layer: 'browser', status: 'ready', browser: 'chromium', browser_version: version, proof_executed: false, reasons: ['Preflight checks availability only; run the suite to obtain browser evidence.'] }
  } catch {
    return { layer: 'browser', status: 'blocked', reasons: ['Pinned browser dependencies and a launchable Chromium are required.'], exit_code: 2 }
  }
}

const state = await browserPreflight()
if (state.status === 'blocked' || process.argv.includes('--preflight')) {
  report(state)
  process.exitCode = state.status === 'blocked' ? 2 : 0
} else {
  report({ layer: 'browser', status: 'running', proof: 'real Chromium; fixture host executor is explicitly fake' })
  const output = resolve(process.env.XPANEL_BROWSER_OUTPUT ?? join(root, 'test-results', 'browser'))
  try {
    const { chromium, expect } = await import('@playwright/test')
    const { runBrowserAcceptance } = await import('../tests/browser/acceptance.mjs')
    const result = await runBrowserAcceptance({ chromium, expect })
    const files = ['tests/browser/acceptance.mjs', 'tests/browser/fixture.mjs', 'scripts/test-browser.mjs', 'apps/web/src/app.ts', 'apps/web/src/surfaces/login.ts', 'apps/web/src/tokens.ts', 'apps/web/src/ws-client.ts', 'apps/web/src/login-client.ts', 'packages/db/src/repos/principals.ts', 'apps/api/src/main.ts', 'apps/api/src/server.ts', 'apps/api/src/auth.ts']
    const fingerprints = await Promise.all(files.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })))
    const passed = result.outcomes.filter(item => item.status === 'passed').length
    const failed = result.outcomes.filter(item => item.status === 'failed').length
    const summary = { schema_version: 1, captured_at: new Date().toISOString(), layer: 'browser', status: failed ? 'failed' : 'passed', runtime: process.version, tests: { total: result.outcomes.length, passed, failed, skipped: 0 }, ...result, files: fingerprints }
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'browser-results.json'), `${JSON.stringify(summary, null, 2)}\n`)
    report({ layer: 'browser', status: summary.status, tests: summary.tests, evidence: join(output, 'browser-results.json') })
    process.exitCode = failed ? 1 : 0
  } catch (error) {
    // Never print raw browser errors: they may include form credentials or enrollment secrets.
    report({ layer: 'browser', status: 'failed', reasons: ['Browser harness or fixture failed before completing its scenarios.'], error_kind: error?.name ?? 'Error' })
    process.exitCode = 1
  }
}
