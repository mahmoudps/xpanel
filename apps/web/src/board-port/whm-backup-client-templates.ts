const tpl = (name: string, tag: string, body: string, attrs = ''): string => `<template data-xp-template="whm-backup-${name}"><${tag}${attrs}>${body}</${tag}></template>`
const slot = (name: string, tag = 'span', attrs = ''): string => `<${tag} data-xp-slot="${name}"${attrs}></${tag}>`
const cell = (name: string, technical = false): string => `<td>${slot(name, technical ? 'bdi' : 'span', technical ? ' dir="ltr" class="xp-mono"' : '')}</td>`
const button = (name: string, hooks = ''): string => `<button type="button" class="xp-btn" data-xp-slot="${name}"${hooks} disabled></button>`
/** This theme owns every dynamic server-backup row, choice and restore view. */
export const classicWhmBackupClientTemplates = (): string => [
  tpl('activation', 'span', slot('before') + slot('link', 'a') + slot('after'), ' class="xp-help" id="backup-destination-activation-help"'),
  tpl('missing', 'div', slot('notice', 'p') + button('clear')),
  tpl('account-choice', 'label', '<input type="checkbox" data-backup-selected-account data-xp-slot="control" disabled>' + slot('text', 'bdi', ' dir="ltr"'), ' class="xp-whm-backup-choice"'),
  tpl('destination-heading', 'strong', '', ' data-xp-slot="text"'),
  tpl('destination-choice', 'label', '<input type="checkbox" data-backup-selected-destination data-xp-slot="control" disabled>' + slot('text'), ' class="xp-whm-backup-choice"'),
  tpl('destination-row', 'tr', cell('name') + cell('kind') + cell('endpoint', true) + cell('state') + '<td><div class="xp-whm-backup-actions">' + button('edit', ' data-backup-edit-destination') + button('remove', ' data-backup-delete-destination') + '</div></td>'),
  tpl('destination-empty', 'tr', '<td colspan="5" data-xp-slot="message"></td>'),
  tpl('snapshot-row', 'tr', ['created','kind','username','bytes','contents','integrity','state'].map(key => cell(key, ['created','username','bytes'].includes(key))).join('') + '<td><details><summary data-xp-slot="summary"></summary><ul data-xp-slot="paths"></ul></details></td>'),
  tpl('path', 'li', slot('text', 'bdi', ' dir="ltr" class="xp-mono"')),
  tpl('snapshot-empty', 'tr', '<td colspan="8" data-xp-slot="message"></td>'),
  tpl('pager', 'div', button('previous') + slot('label', 'bdi', ' dir="ltr"') + button('next'), ' class="xp-whm-backup-actions"'),
  tpl('run-row', 'tr', ['created','trigger','accounts','bytes','duration','copies','state'].map(key => cell(key, ['created','bytes','duration'].includes(key))).join('') + '<td><div class="xp-whm-backup-actions">' + button('restore') + button('log') + '</div></td>'),
  tpl('run-empty', 'tr', '<td colspan="8" data-xp-slot="message"></td>'),
  tpl('log', 'li', ''),
  tpl('technical', 'bdi', '', ' dir="ltr" class="xp-mono" data-xp-slot="text"'),
  tpl('name', 'bdi', '', ' data-xp-slot="text"'),
  tpl('radio', 'button', '<span class="xp-whm-backup-radio-ring" aria-hidden="true"></span><span>' + slot('title', 'strong') + slot('note', 'span', ' class="xp-help"') + '</span>', ' type="button" class="xp-whm-backup-radio" role="radio" disabled'),
  tpl('choices-empty', 'p', '', ' data-xp-slot="message"'),
  tpl('difference', 'tr', cell('part') + cell('name', true) + cell('current') + cell('backup') + cell('action')),
].join('')
