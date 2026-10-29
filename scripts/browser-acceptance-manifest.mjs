/** One canonical command inventory. Shard numbers are stable, not calculated from case counts. */
export const SHARD_COUNT = 3
export const REQUIRED_IDS = Object.freeze('application phase1 navigation login mail-layout mail-compose accounts technical-values resource-usage shell-motion shell-exception native-controls ip-allocation mail-refresh mfa composed native-workflows extensions forwarders email-filters file-workspace account-contact domain-workspace database-workspace mail-folder-workspace mail-contacts-workspace'.split(' '))
const view = (id, shard, file, prefix) => ({ id, shard, command: ['node', 'tests/browser/' + file + '.mjs'], env: {}, output: { kind: 'directory', prefix } })
export const BROWSER_ACCEPTANCE = Object.freeze([
  { id: 'application', shard: 3, command: ['pnpm', 'test:browser'], env: {}, output: { kind: 'environment', key: 'XPANEL_BROWSER_OUTPUT', prefix: 'browser' } },
  view('phase1', 2, 'phase1-acceptance', 'phase1-ui'),
  view('navigation', 3, 'navigation-acceptance', 'navigation-ui'),
  view('login', 2, 'login-surface-acceptance', 'login-ui'),
  view('mail-layout', 3, 'mail-layout-acceptance', 'mail-layout'),
  { id: 'mail-compose', shard: 3, command: ['node', 'tests/browser/mail-compose-functional.mjs'], env: {}, output: { kind: 'file', prefix: 'mail-compose-functional', flag: '--out' } },
  view('accounts', 2, 'accounts-acceptance', 'accounts-ui'),
  view('technical-values', 2, 'technical-values-acceptance', 'technical-values'),
  view('resource-usage', 3, 'resource-usage-acceptance', 'resource-usage'),
  view('shell-motion', 3, 'shell-motion-acceptance', 'shell-motion'),
  view('shell-exception', 3, 'shell-motion-exception-acceptance', 'shell-motion-exception'),
  view('native-controls', 2, 'native-control-states-acceptance', 'native-control-states'),
  view('ip-allocation', 3, 'ip-allocation-acceptance', 'ip-allocation'),
  { id: 'mail-refresh', shard: 3, command: ['pnpm', 'exec', 'vitest', 'run', 'apps/web/src/xmail-live-refresh.test.ts', '--maxWorkers=1'], env: { XPANEL_REQUIRE_BROWSER_TESTS: '1' }, output: { kind: 'vitest', prefix: 'mail-refresh' } },
  view('mfa', 3, 'mfa-runtime-acceptance', 'mfa-runtime'),
  view('composed', 1, 'composed-acceptance', 'composed-ui'),
  { id: 'account-contact', shard: 1, command: ['node', 'tests/browser/completion-account-contact.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_ACCOUNT_CONTACT_OUTPUT', prefix: 'account-contact' } },
  { id: 'domain-workspace', shard: 2, command: ['node', 'tests/browser/completion-domain-workspace.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_DOMAIN_WORKSPACE_OUTPUT', prefix: 'domain-workspace' } },
  { id: 'database-workspace', shard: 2, command: ['node', 'tests/browser/completion-database-workspace.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_DATABASE_WORKSPACE_OUTPUT', prefix: 'database-workspace' } },
  { id: 'mail-folder-workspace', shard: 3, command: ['node', 'tests/browser/completion-mail-folder-workspace.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_MAIL_FOLDER_WORKSPACE_OUTPUT', prefix: 'mail-folder-workspace' } },
  { id: 'mail-contacts-workspace', shard: 3, command: ['node', 'tests/browser/completion-mail-contacts.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_MAIL_CONTACTS_OUTPUT', prefix: 'mail-contacts-workspace' } },
  view('native-workflows', 2, 'native-workflows-acceptance', 'native-workflows'),
  view('extensions', 2, 'extensions-acceptance', 'extensions-ui'),
  { id: 'forwarders', shard: 3, command: ['node', 'tests/browser/completion-forwarders.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_FORWARDERS_OUTPUT', prefix: 'forwarders' } },
  { id: 'email-filters', shard: 3, command: ['node', 'tests/browser/completion-email-filters.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_FILTERS_OUTPUT', prefix: 'email-filters' } },
  { id: 'file-workspace', shard: 3, command: ['node', 'tests/browser/completion-file-workspace.mjs'], env: {}, output: { kind: 'environment', key: 'XPANEL_FILE_WORKSPACE_OUTPUT', prefix: 'file-workspace' } },
].map(entry => Object.freeze({ ...entry, command: Object.freeze(entry.command), env: Object.freeze(entry.env), output: Object.freeze(entry.output) })))

export function validateManifest(entries = BROWSER_ACCEPTANCE) {
  if (!Array.isArray(entries) || entries.length !== REQUIRED_IDS.length) throw new Error('Acceptance inventory is incomplete')
  const seen = new Set(), outputs = new Set()
  for (const entry of entries) {
    if (!REQUIRED_IDS.includes(entry.id) || seen.has(entry.id)) throw new Error('Unknown or duplicate acceptance ID')
    seen.add(entry.id)
    if (!Number.isInteger(entry.shard) || entry.shard < 1 || entry.shard > SHARD_COUNT) throw new Error('Invalid acceptance shard')
    if (!Array.isArray(entry.command) || !['node', 'pnpm'].includes(entry.command[0]) || !entry.command.every(arg => typeof arg === 'string' && arg.length > 0)) throw new Error('Invalid acceptance command')
    if (!entry.output || !['directory', 'file', 'vitest', 'environment'].includes(entry.output.kind) || !/^[a-z0-9-]+$/.test(entry.output.prefix) || outputs.has(entry.output.prefix)) throw new Error('Invalid or duplicate acceptance output')
    outputs.add(entry.output.prefix)
  }
  if (REQUIRED_IDS.some(id => !seen.has(id)) || Array.from({ length: SHARD_COUNT }, (_, i) => i + 1).some(shard => !entries.some(entry => entry.shard === shard))) throw new Error('Acceptance coverage is incomplete')
  return { entries: entries.length, shards: SHARD_COUNT, assignments: Array.from({ length: SHARD_COUNT }, (_, i) => entries.filter(entry => entry.shard === i + 1).map(entry => entry.id)) }
}
