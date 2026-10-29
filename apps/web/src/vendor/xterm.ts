import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { TERMINAL_EMULATOR_PATHS } from '../ops-terminal-client.ts'

/**
 * Pinned terminal emulator, read from the locked npm packages (pnpm-lock.yaml) and served unmodified except for the
 * trailing source-map comment. Served from the panel's own origin; no CDN. A file that does not match its pinned
 * SHA-256 stops the web process instead of serving altered code.
 *
 * - xterm.js, xterm.css: @xterm/xterm 5.5.0, MIT (vendor/xterm/LICENSE: The xterm.js authors, SourceLair Private Company, Christopher Jeffrey),
 *   npm integrity sha512-hqJHYaQb5OptNunnyAnkHyM8aCjZ1MEIDTQu1iIbbTD/xops91NB5yq1ZK/dC2JDbVWtF23zUtl9JE2NqwT87A==, files lib/xterm.js and css/xterm.css.
 * - addon-fit.js: @xterm/addon-fit 0.10.0, MIT (vendor/xterm/LICENSE-addon-fit: The xterm.js authors),
 *   npm integrity sha512-UFYkDm4HUahf2lnEyHvio51TNGiLK66mqP2JoATy7hRZeXaGMRDr00JiSF7m63vR5WKATF605yEggJKsw0JpMQ==, file lib/addon-fit.js.
 * The SHA-256 values below are of the served bytes.
 */
const PINNED = Object.freeze({
  'xterm.js': '7a88e46a58847d3f17109e3d48cc8aa056a01997d00ceb76035f63370712d858',
  'addon-fit.js': '3e9ae6f6965ee1269d5574b905cf1bf559c2f44c784255b0034a71387e7719c9',
  'xterm.css': 'ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6',
})
const SOURCES = Object.freeze({ 'xterm.js': '@xterm/xterm/lib/xterm.js', 'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js', 'xterm.css': '@xterm/xterm/css/xterm.css' })
const resolvePackageFile = createRequire(import.meta.url).resolve
const read = (name: keyof typeof PINNED): string => {
  // The source maps are not served, so their trailing reference is dropped before the pin check.
  const body = readFileSync(resolvePackageFile(SOURCES[name]), 'utf8').replace(/\/\/# sourceMappingURL=[^\n]*$/, '')
  if (createHash('sha256').update(body, 'utf8').digest('hex') !== PINNED[name]) throw new Error(`vendored ${name} does not match its pinned SHA-256`)
  return body
}

/** Spread into the web app's public static asset table. */
export const TERMINAL_EMULATOR_ASSETS: Readonly<Record<string, { body: string; contentType: string }>> = Object.freeze({
  [TERMINAL_EMULATOR_PATHS.script]: { body: read('xterm.js'), contentType: 'application/javascript; charset=utf-8' },
  [TERMINAL_EMULATOR_PATHS.fit]: { body: read('addon-fit.js'), contentType: 'application/javascript; charset=utf-8' },
  [TERMINAL_EMULATOR_PATHS.style]: { body: read('xterm.css'), contentType: 'text/css; charset=utf-8' },
})
