import { escapeHtml } from '../html.ts'

const tpl = (name: string, body: string): string => `<template data-xp-template="${name}">${body}</template>`
export function teamClientTemplates(): string {
  return [
    tpl('acct-team-member', '<tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="username"></bdi></td><td data-xp-slot="roles"></td><td><bdi dir="ltr" data-xp-slot="email"></bdi></td><td><span data-xp-slot="phase" data-state-chip></span> <bdi dir="auto" data-xp-slot="reason"></bdi></td><td data-xp-slot="signin"></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="expires"></bdi></td><td><div class="v2-panel-settings__actions" data-xp-slot="actions"></div></td></tr>'),
    tpl('acct-team-empty', '<tr><td colspan="7" data-xp-slot="message"></td></tr>'),
    tpl('acct-team-signin', '<div class="v2-team-signin" style="display:flex;flex-direction:column;gap:8px"><span data-xp-slot="password"></span><div data-xp-slot="times" style="display:flex;flex-direction:column;gap:8px"></div></div>'),
    tpl('acct-team-signin-time', '<span style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px"><span data-xp-slot="label"></span><bdi dir="ltr" class="v2-mono" data-xp-slot="stamp"></bdi></span>'),
    tpl('acct-team-value', '<bdi dir="ltr" class="v2-mono" data-xp-slot="value"></bdi>'),
    tpl('acct-team-action', '<button type="button" class="v2-btn" data-xp-slot="label" disabled></button>'),
    tpl('acct-team-delete', '<button type="button" class="v2-btn v2-btn--danger" data-xp-slot="label" disabled></button>'),
  ].join('')
}

export function logsClientTemplates(t: (message: string) => string): string {
  const head = (labels: readonly string[]) => '<tr>' + labels.map(label => '<th scope="col">' + escapeHtml(t(label)) + '</th>').join('') + '</tr>'
  return [
    tpl('account-logs-access', '<tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="time"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="status"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="request"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="client"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="bytes"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="referer"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="agent"></bdi></td></tr>'),
    tpl('account-logs-error', '<tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="time"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="level"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="message"></bdi></td></tr>'),
    tpl('account-logs-access-head', head(['Time', 'Status', 'Request', 'Client', 'Bytes', 'Referrer', 'User agent'])),
    tpl('account-logs-error-head', head(['Time', 'Level', 'Message'])),
    tpl('account-logs-empty-access', '<tr><td colspan="7" data-xp-slot="message"></td></tr>'),
    tpl('account-logs-empty-error', '<tr><td colspan="3" data-xp-slot="message"></td></tr>'),
    tpl('account-logs-stamp', '<bdi dir="ltr" class="v2-mono" data-xp-slot="value"></bdi>'),
  ].join('')
}
