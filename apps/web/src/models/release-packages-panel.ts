import '../i18n.ts'
import type { SvcPanel } from './svc-panels.ts'

const PHP_FEATURES = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'].map(version => ['php-' + version, 'PHP ' + version])

export const RELEASE_FEATURE_LABELS: Readonly<Record<string, string>> = {
  tools: msgid('Base system tools'), 'web-server': msgid('Web server'), 'core-services': msgid('Core services'), 'web-stats': msgid('Web statistics'),
  'web-disk': msgid('Web Disk'), calendars: msgid('Calendars and Contacts'), mariadb: 'MariaDB', mail: msgid('Mail'), dns: msgid('DNS server'), ftp: msgid('FTP server'), modsecurity: 'ModSecurity',
  ...Object.fromEntries(PHP_FEATURES),
}

/** What the installed release declares against the package database of this server. Both themes draw it from this schema. */
export const releasePackages: SvcPanel = { id: 'release-packages', tool: 'panel-upgrade', read: '/api/server/upgrade/packages', sections: [{
  id: 'release-packages', title: msgid('Release packages'), help: msgid('An upgrade switches the release first and never waits for a package manager. Once it settles, the agent installs what the new release declares as a background job, once per release. An upgrade cannot start while that job runs.'),
  facts: [{ path: 'release', label: msgid('Installed version') }, { path: 'summary', label: msgid('Result'), labels: { complete: msgid('Every declared package is installed'), missing: msgid('Some features are missing packages'), 'job-active': msgid('A package job is running'),
    'unsupported-host': msgid('This server has no installed release or supported package manager'), 'package-database-unavailable': msgid('The package database could not be read'), 'invalid-package-database': msgid('The package database gave an answer that could not be parsed') } },
  { path: 'jobStatus', label: msgid('Latest package job'), labels: { none: msgid('None for this release'), queued: msgid('Queued'), running: msgid('Running'), succeeded: msgid('Succeeded'), failed: msgid('Failed'), cancelled: msgid('Cancelled') } }, { path: 'jobReference', label: msgid('Job reference') }],
  tables: [{ title: msgid('Declared features'), rows: 'features', empty: msgid('No feature has been read.'), columns: [{ path: 'id', label: msgid('Feature'), labels: RELEASE_FEATURE_LABELS },
    { path: 'state', label: msgid('State'), labels: { complete: msgid('Installed'), missing: msgid('Missing packages'), 'not-selected': msgid('Not selected on this server') } }, { path: 'missing', label: msgid('Missing'), technical: true }] }],
  buttons: [{ label: msgid('Install missing packages'), op: 'post', url: '/api/server/upgrade/packages/retry', primary: true, revision: true, confirm: msgid('Install the missing packages of this release now?') }, { label: msgid('Refresh'), op: 'refresh' }] }] }
