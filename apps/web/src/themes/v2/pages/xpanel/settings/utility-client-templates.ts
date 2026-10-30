import { statePill, stateTones } from '../../../components/status-pill.ts'

/** The V2 clone shapes preserve its own typography, controls and field hierarchy. */
export function gitHistoryClientTemplates(): string {
  return `<template data-xp-template="git-history-row"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="hash"></bdi></td><td><bdi dir="ltr"><time data-xp-slot="at"></time></bdi></td><td data-xp-slot="subject"></td></tr></template><template data-xp-template="git-history-empty"><tr><td colspan="3" data-xp-slot="message"></td></tr></template>`
}

export function sshKeyClientTemplates(): string {
  return `<template data-xp-template="ssh-key-row"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="type"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="fingerprint"></bdi></td><td data-xp-slot="comment"></td><td data-xp-slot="notes"></td><td data-xp-slot="actions"></td></tr></template><template data-xp-template="ssh-key-action"><button type="button" class="v2-btn" data-xp-slot="label"></button></template><template data-xp-template="ssh-key-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>`
}

export function accountSessionClientTemplates(): string {
  return `<template data-xp-template="account-session-row"><article class="v2-panel-settings__preview v2-panel-settings__groups"><header class="v2-panel-settings__actions"><strong data-xp-slot="title"></strong><span class="v2-muted" data-xp-slot="verification"></span></header><dl class="v2-panel-settings__facts"><div><dt data-xp-slot="network-label"></dt><dd><bdi dir="ltr" data-xp-slot="network"></bdi></dd></div><div><dt data-xp-slot="client-label"></dt><dd><bdi dir="auto" data-xp-slot="client"></bdi></dd></div><div><dt data-xp-slot="last-active-label"></dt><dd><bdi dir="ltr"><time data-xp-slot="last-active"></time></bdi></dd></div><div><dt data-xp-slot="expires-label"></dt><dd><bdi dir="ltr"><time data-xp-slot="expires"></time></bdi></dd></div></dl><div class="v2-panel-settings__actions" data-xp-slot="actions"></div></article></template><template data-xp-template="account-session-action"><button type="button" class="v2-btn" data-session-action="revoke" data-xp-slot="label"></button></template><template data-xp-template="account-session-empty"><p class="v2-muted" data-xp-slot="message"></p></template>`
}

export function virusScanClientTemplates(): string {
  return `<template data-xp-template="virus-scan-row"><tr data-utility-row="virus-scan"><td><bdi dir="ltr"><time data-xp-slot="started"></time></bdi></td><td data-xp-slot="status"></td><td>${statePill('result')}</td><td><bdi dir="ltr" data-xp-slot="scanned"></bdi></td><td><bdi dir="ltr" data-xp-slot="infected"></bdi></td></tr></template><template data-xp-template="virus-scan-detail"><tr><td colspan="5"><ul class="v2-panel-settings__list" data-xp-slot="files"></ul><p class="v2-muted" data-xp-slot="notice" hidden></p></td></tr></template><template data-xp-template="virus-scan-file"><li><bdi dir="ltr" class="v2-mono" data-xp-slot="path"></bdi><span aria-hidden="true"> · </span><bdi dir="ltr" data-xp-slot="signature"></bdi></li></template><template data-xp-template="virus-scan-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>`
}

export const PANEL_UTILITY_CLIENT_CSS = stateTones('.v2-panel-settings [data-utility-row="virus-scan"]', 'data-state', {
  pending: 'info', clean: 'ok', infected: 'bad', error: 'warn', cancelled: 'neutral', unknown: 'warn',
})
