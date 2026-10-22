import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linuxProofPreflight } from './test-linux-preflight.mjs'
import { testLayerConfig } from './test-layers.mjs'

const [layer = 'portable', ...args] = process.argv.slice(2)
const browserState = { layer: 'browser', status: 'not_run', reasons: ['Separate real Chromium acceptance is available through test:browser; Node HTML tests are not browser proof.'] }
const report = (value) => process.stdout.write(`XPANEL_TEST_LAYER=${JSON.stringify(value)}\n`)

function runVitest(selected) {
  testLayerConfig(selected)
  report({ layer: selected, status: 'running', limits: selected === 'linux' ? 'Kernel primitives and installer dry-run only; not workload isolation or live firewall traffic.' : 'Node tests; HTTP uses request adapters and loopback sockets, and host executors may be fakes.' })
  const vitest = resolve(dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))), 'vitest.mjs')
  const child = spawnSync(process.execPath, [vitest, 'run', ...args.filter(a => a !== '--preflight')], {
    stdio: 'inherit', env: { ...process.env, XPANEL_TEST_LAYER: selected },
  })
  const exitCode = child.status ?? 1
  report({ layer: selected, status: exitCode === 0 ? 'passed' : 'failed', exit_code: exitCode })
  return exitCode
}

function runBrowser(preflight = false) {
  const child = spawnSync(process.execPath, [resolve(import.meta.dirname, 'test-browser.mjs'), ...(preflight ? ['--preflight'] : [])], { stdio: 'inherit', env: process.env })
  return child.status ?? 1
}

if (layer === 'browser') {
  process.exitCode = runBrowser(args.includes('--preflight'))
} else if (layer === 'linux') {
  const state = linuxProofPreflight()
  report(state)
  process.exitCode = state.status === 'blocked' ? 2 : args.includes('--preflight') ? 0 : runVitest('linux')
} else if (layer === 'all') {
  const result = runVitest('portable')
  const browser = runBrowser()
  const linux = linuxProofPreflight()
  report(linux)
  process.exitCode = result || browser || (linux.status === 'blocked' ? 2 : runVitest('linux'))
} else {
  try {
    process.exitCode = runVitest(layer)
    if (layer === 'portable') {
      report({ layer: 'linux', status: 'not_run', reasons: ['Separate explicit disposable-VM qualification is required: test:linux.'] })
      report({ layer: 'browser', status: 'not_run', reasons: browserState.reasons })
    }
  } catch (error) {
    report({ layer, status: 'failed', reasons: [error.message] })
    process.exitCode = 1
  }
}
