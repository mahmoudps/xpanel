// EL builds a few modules from pinned source (scripts/el-source-builds.sh), which no package dependency protects.
// After a dnf transaction touches what they depend on, this hook leaves a marker for the agent's minute timer: a build
// takes minutes and must not hold dnf, and the hook runs after the transaction, so it never sees half-updated headers.

import type { RenderedFile } from '@xpanel/core'

export const SOURCE_BUILD_DIR = '/var/lib/xpanel/source-builds'
export const SOURCE_BUILD_MARKER = `${SOURCE_BUILD_DIR}/update-seen`
export const SOURCE_BUILD_HOOK = '/etc/dnf/plugins/post-transaction-actions.d/xpanel-source-builds.action'
/** httpd and Dovecot carry the module ABIs; gd, libpng and zlib are what Webalizer links, Perl is what AWStats loads. */
const WATCHED: readonly string[] = ['httpd*', 'dovecot*', 'gd*', 'libpng*', 'zlib*', 'perl*']

/** The plugin reads package_filter:transaction_state:command and runs each distinct command once per transaction. */
export const renderSourceBuildHook = (): RenderedFile => ({
  path: SOURCE_BUILD_HOOK,
  content: `# Managed by xPanel: asks the agent to re-check its source-built modules after these packages change.\n${WATCHED.map(filter => `${filter}:in:/usr/bin/touch ${SOURCE_BUILD_MARKER}\n`).join('')}`,
  mode: 0o644,
  owner: 'root',
  group: 'root',
})
