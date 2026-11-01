import { describe, expect, it } from 'vitest'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './controller-hooks.ts'
import { checkControllerDeclarations } from './controller-conformance.ts'
import { parseMarkup } from './markup.ts'

const find = (id: string) => {
  const declaration = AUTHORITATIVE_CONTROLLER_DECLARATIONS.find(item => item.id === id)
  if (!declaration) throw new Error(`Missing source-owned controller declaration: ${id}`)
  return declaration
}
const check = (id: string, body: string, route: string, qualified: boolean) => checkControllerDeclarations(
  parseMarkup(`<html><body>${body}</body></html>`), [find(id)], { route, surface: route.startsWith('/whm/') ? 'xwhm' : 'xpanel', qualified },
)
const account = '<div data-account-detail-workspace="/whm/accounts"><aside id="account-detail" data-account-detail-panel hidden><button type="button" data-account-detail-close>Close</button></aside></div>'
const accountRows = '<div data-account-detail-workspace="/whm/accounts"><table><tbody><tr data-account-row="alice"><td><button type="button" data-account-detail-open="alice" aria-expanded="false" aria-controls="account-detail">Alice</button></td></tr></tbody></table><aside id="account-detail" data-account-detail-panel hidden><button type="button" data-account-detail-close>Close</button><section data-account-detail-for="alice" hidden></section></aside></div>'
const plan = '<form data-native-plan-editor><section data-native-plan-review><p data-plan-review-status></p><span data-plan-review-count>0</span><p data-plan-review-empty></p><ol><li data-plan-review-key="name"><bdi data-plan-review-from></bdi><bdi data-plan-review-to></bdi></li></ol></section></form>'
const tabs = '<div data-presentation-tabs="panels"><div role="tablist" aria-label="Settings"><button type="button" role="tab" id="tab-a" data-presentation-tab="a" aria-selected="true" aria-controls="panel-a">A</button><button type="button" role="tab" id="tab-b" data-presentation-tab="b" aria-selected="false" aria-controls="panel-b">B</button></div><section id="panel-a" role="tabpanel" aria-labelledby="tab-a"></section><section id="panel-b" role="tabpanel" aria-labelledby="tab-b" hidden></section></div>'
const prompt = '<template data-xp-template="prompt-dialog"><dialog data-xp-prompt aria-labelledby="prompt-title" aria-describedby="prompt-body"><form method="dialog" data-xp-slot="form"><h2 id="prompt-title" data-xp-slot="title"></h2><p id="prompt-body" data-xp-slot="body"></p><div data-xp-slot="field"><label for="prompt-input" data-xp-slot="label"></label><input id="prompt-input" data-xp-slot="input"></div><button type="button" data-xp-slot="cancel">Cancel</button><button type="submit" data-xp-slot="confirm">Confirm</button></form></dialog></template>'
const facts = (prefix: string) => `<template data-xp-template="${prefix}-fact-technical"><div><dt data-xp-slot="label"></dt><dd><bdi dir="ltr" data-xp-slot="value"></bdi></dd></div></template><template data-xp-template="${prefix}-fact-text"><div><dt data-xp-slot="label"></dt><dd><span data-xp-slot="value"></span></dd></div></template>`
const security = `<div data-whm-security-evidence><table><tbody data-whm-security-check-rows></tbody></table><dl data-whm-security-configuration></dl><p data-whm-security-status></p><button type="button" data-whm-security-refresh>Read</button>${facts('whm-security')}</div>`
const ssh = `<div data-whm-detail-route="/whm/security/ssh"><div data-whm-ssh-keys><table><tbody data-whm-ssh-key-rows></tbody></table><textarea data-whm-ssh-public-key></textarea><p data-whm-ssh-status></p><button type="button" data-whm-ssh-refresh>Read</button><button type="button" data-whm-ssh-add>Add</button></div><dl data-whm-ssh-effective></dl><table><tbody data-whm-ssh-failure-rows></tbody></table><select data-whm-ssh-window><option value="24h">24 hours</option></select><template data-xp-template="whm-ssh-remove"><button type="button" disabled data-whm-ssh-remove data-protected="true"><span data-xp-slot="label"></span></button></template>${facts('whm-ssh')}</div>`
const notices = ['info', 'warning', 'maintenance'].map(kind => `<template data-xp-template="account-announcement-notice-${kind}"><div role="status"><span data-xp-slot="severity"></span><span data-xp-slot="title"></span><p data-xp-slot="body"></p><p data-xp-slot="expiry"><bdi dir="ltr" data-xp-slot="end"></bdi></p><button type="button" disabled data-xp-slot="dismiss"></button></div></template>`).join('')
const announcements = `<div data-account-announcements><div data-account-announcements-list></div><p data-account-announcements-status></p>${notices}</div>`

const cases = [
  { id: 'whm-account-details', route: '/whm/accounts', good: account, bad: account.replace('<button type="button" data-account-detail-close>Close</button>', ''), outside: '<button type="button" data-account-detail-close>Outside</button>' },
  { id: 'native-plan-review', route: '/whm/plans/new', good: plan, bad: plan.replace('<bdi data-plan-review-to></bdi>', '<span data-plan-review-to></span>'), outside: '<bdi data-plan-review-to></bdi>' },
  { id: 'presentation-tabs', route: '/whm/services/php', good: tabs, bad: tabs.replace('aria-controls="panel-b"', 'aria-controls="foreign-panel"'), outside: '<section id="foreign-panel" role="tabpanel" aria-labelledby="tab-b"></section>' },
  { id: 'shared-prompt-dialog', route: '/home', good: prompt, bad: prompt.replace('<input id="prompt-input" data-xp-slot="input">', '<textarea id="prompt-input" data-xp-slot="input"></textarea>'), outside: '<input id="outside-input" data-xp-slot="input">' },
  { id: 'whm-security-evidence', route: '/whm/security', good: security, bad: security.replace('<dl data-whm-security-configuration></dl>', ''), outside: '<dl data-whm-security-configuration></dl>' },
  { id: 'whm-ssh-workspace', route: '/whm/security/ssh', good: ssh, bad: ssh.replace('<textarea data-whm-ssh-public-key></textarea>', '<input data-whm-ssh-public-key>'), outside: '<textarea data-whm-ssh-public-key></textarea>' },
  { id: 'account-announcements-owned-root', route: '/home', good: announcements, bad: announcements.replace('<p data-account-announcements-status></p>', ''), outside: '<p data-account-announcements-status></p>' },
] as const

describe('independent source-owned controller scopes', () => {
  for (const qualified of [true, false]) for (const fixture of cases) {
    it('accepts ' + fixture.id + ' with qualified=' + String(qualified), { tags: ['unit'] }, () => {
      expect(check(fixture.id, fixture.good, fixture.route, qualified)).toEqual([])
    })
    it('rejects malformed ' + fixture.id + ' with qualified=' + String(qualified), { tags: ['unit'] }, () => {
      expect(check(fixture.id, fixture.outside + fixture.bad, fixture.route, qualified).length).toBeGreaterThan(0)
    })
  }
  it('does not require optional controllers where none are mounted', { tags: ['unit'] }, () => {
    for (const fixture of cases) expect(check(fixture.id, '<main>Empty authorized page</main>', fixture.route, false)).toEqual([])
  })
  it('does not satisfy an account workspace with a nested workspace controls', { tags: ['unit'] }, () => {
    expect(check('whm-account-details', '<div data-account-detail-workspace="/whm/accounts">' + account + '</div>', '/whm/accounts', true).length).toBeGreaterThan(0)
  })
  it('binds each account opener to its unique same-workspace aside identity', { tags: ['unit'] }, () => {
    expect(check('whm-account-details', accountRows, '/whm/accounts', true)).toEqual([])
    expect(check('whm-account-details', accountRows.replace('aria-controls="account-detail"', 'aria-controls="other-detail"'), '/whm/accounts', true).length).toBeGreaterThan(0)
  })
})


// Minimal immutable control shapes used by the existing public File/FTP/PHP/Transfer fixtures.
// They are independent input markup, never generated from controller declarations.
const filePresentation = '<input type="checkbox" data-file-select-all><input type="search" data-file-filter><output data-file-selection-count>0</output><button type="button" data-file-selection-clear>Clear</button><span data-file-detail="name"></span><span data-file-detail="path"></span><span data-file-detail="kind"></span><span data-file-detail="size"></span><span data-file-detail="mode"></span><span data-file-detail="modified"></span><span data-file-detail="owner"></span><span data-file-permission-bit="0-0"></span><span data-file-permission-bit="0-1"></span><span data-file-permission-bit="0-2"></span><span data-file-permission-bit="1-0"></span><span data-file-permission-bit="1-1"></span><span data-file-permission-bit="1-2"></span><span data-file-permission-bit="2-0"></span><span data-file-permission-bit="2-1"></span><span data-file-permission-bit="2-2"></span><p data-file-filter-empty></p><p data-file-selection-status></p><button type="button" data-file-detail-primary>Primary</button><button type="button" data-file-detail-secondary>Secondary</button><button type="button" data-file-copy-path>Copy</button>'
const fileBrowse = '<div data-file-manager="browse">' + filePresentation + '<div data-file-editor-panel></div><p data-file-editor-closed></p><button type="button" data-file-editor-show>Show</button><button type="button" data-file-editor-close>Close</button><ul data-file-uploads></ul><p data-file-uploads-empty></p><output data-file-upload-count>0</output><template data-xp-template="file-upload-row"><li><bdi data-xp-slot="name"></bdi><bdi data-xp-slot="bytes"></bdi><span data-xp-slot="state"></span><div data-xp-slot="progress" role="progressbar"></div><button type="button" data-xp-slot="dismiss">Dismiss</button></li></template></div>'
const fileTrash = '<div data-file-manager="trash">' + filePresentation + '</div>'
const ftpControls = '<div data-whm-ftp-log><form data-ftp-log-form><select data-ftp-log-range></select><button type="submit" data-ftp-log-submit>Read</button></form><p data-ftp-log-status></p></div>'
const phpControls = '<div data-whm-php-workspace><p data-whm-php-status></p><button type="button" data-whm-php-refresh>Read</button><div data-whm-php-version-entries></div></div>'
const transferControls = '<div data-transfer-workspace><select data-transfer-session></select><select data-transfer-credential></select><select data-transfer-conflict></select><select data-transfer-resolution></select><select data-transfer-import></select><select data-transfer-import-plan></select><p data-transfer-status></p><div data-transfer-accounts></div><div data-transfer-plans></div><div data-transfer-review-results></div><div data-transfer-archive-review></div><code data-transfer-ssh-key-value></code></div>'
const extraCases = [
  { id: 'file-workspace-browse-presentation', route: '/files/manager', good: fileBrowse, bad: fileBrowse.replace('<input type="search" data-file-filter>', '<input type="checkbox" data-file-filter>'), outside: '<input type="search" data-file-filter>' },
  { id: 'file-workspace-trash-presentation', route: '/files/trash', good: fileTrash, bad: fileTrash.replace('<button type="button" data-file-selection-clear>Clear</button>', ''), outside: '<button type="button" data-file-selection-clear>Clear</button>' },
  { id: 'whm-ftp-log-workspace-controls', route: '/whm/services/ftp-log-analysis', good: ftpControls, bad: ftpControls.replace('<form data-ftp-log-form>', '<div data-ftp-log-form>').replace('</form>', '</div>'), outside: '<form data-ftp-log-form></form>' },
  { id: 'whm-php-workspace-controls', route: '/whm/software/php', good: phpControls, bad: phpControls.replace('<button type="button" data-whm-php-refresh>Read</button>', '<span data-whm-php-refresh>Read</span>'), outside: '<button type="button" data-whm-php-refresh>Read</button>' },
  { id: 'whm-transfer-workspace-controls', route: '/whm/transfers', good: transferControls, bad: transferControls.replace('<select data-transfer-credential></select>', '<input data-transfer-credential>'), outside: '<select data-transfer-credential></select>' },
] satisfies readonly { id: string; route: string; good: string; bad: string; outside: string }[]

describe('finite controls of the existing File/FTP/PHP/Transfer helpers', () => {
  for (const fixture of extraCases) {
    it('accepts the existing ' + fixture.id + ' control shape', { tags: ['unit'] }, () => {
      expect(check(fixture.id, fixture.good, fixture.route, true)).toEqual([])
    })
    it('rejects a missing or mistyped ' + fixture.id + ' control despite a foreign match', { tags: ['unit'] }, () => {
      expect(check(fixture.id, fixture.outside + fixture.bad, fixture.route, true).length).toBeGreaterThan(0)
    })
  }
})
