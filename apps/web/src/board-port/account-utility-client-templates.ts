/** Markup is owned by the selected theme; controllers fill only named semantic slots. */
export function gitHistoryClientTemplates(): string {
  return `<template data-xp-template="git-history-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="hash"></bdi></td><td><bdi dir="ltr"><time data-xp-slot="at"></time></bdi></td><td data-xp-slot="subject"></td></tr></template><template data-xp-template="git-history-empty"><tr><td colspan="3" data-xp-slot="message"></td></tr></template>`
}

export function sshKeyClientTemplates(): string {
  return `<template data-xp-template="ssh-key-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="type"></bdi></td><td><bdi dir="ltr" class="xp-mono" data-xp-slot="fingerprint"></bdi></td><td data-xp-slot="comment"></td><td data-xp-slot="notes"></td><td data-xp-slot="actions"></td></tr></template><template data-xp-template="ssh-key-action"><button type="button" class="xp-btn" data-xp-slot="label"></button></template><template data-xp-template="ssh-key-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>`
}

export function accountSessionClientTemplates(): string {
  return `<template data-xp-template="account-session-row"><article class="xp-panel-detail__native"><header><strong data-xp-slot="title"></strong><span class="xp-help" data-xp-slot="verification"></span></header><dl class="xp-panel-detail__facts"><div><dt data-xp-slot="network-label"></dt><dd><bdi dir="ltr" data-xp-slot="network"></bdi></dd></div><div><dt data-xp-slot="client-label"></dt><dd><bdi dir="auto" data-xp-slot="client"></bdi></dd></div><div><dt data-xp-slot="last-active-label"></dt><dd><bdi dir="ltr"><time data-xp-slot="last-active"></time></bdi></dd></div><div><dt data-xp-slot="expires-label"></dt><dd><bdi dir="ltr"><time data-xp-slot="expires"></time></bdi></dd></div></dl><div class="xp-panel-detail__actions" data-xp-slot="actions"></div></article></template><template data-xp-template="account-session-action"><button type="button" class="xp-btn" data-session-action="revoke" data-xp-slot="label"></button></template><template data-xp-template="account-session-empty"><p class="xp-help" data-xp-slot="message"></p></template>`
}

export function virusScanClientTemplates(): string {
  return `<template data-xp-template="virus-scan-row"><tr><td><bdi dir="ltr"><time data-xp-slot="started"></time></bdi></td><td data-xp-slot="status"></td><td><span data-xp-slot="result"></span></td><td><bdi dir="ltr" data-xp-slot="scanned"></bdi></td><td><bdi dir="ltr" data-xp-slot="infected"></bdi></td></tr></template><template data-xp-template="virus-scan-detail"><tr><td colspan="5"><ul data-xp-slot="files"></ul><p class="xp-help" data-xp-slot="notice" hidden></p></td></tr></template><template data-xp-template="virus-scan-file"><li><bdi dir="ltr" class="xp-mono" data-xp-slot="path"></bdi><span aria-hidden="true"> · </span><bdi dir="ltr" data-xp-slot="signature"></bdi></li></template><template data-xp-template="virus-scan-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>`
}
