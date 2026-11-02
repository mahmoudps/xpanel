/** Theme-owned diagnostic fragments; values are filled as text only. */
export function classicDiagnosticsTemplates(kind: 'network' | 'health'): string {
 const template = (name: string, body: string) => `<template data-xp-template="${name}">${body}</template>`
 if (kind === 'network') return template('nettools-row', '<tr></tr>') + template('nettools-header', '<th scope="col" data-xp-slot="label"></th>') + template('nettools-value', '<td><bdi class="xp-mono" dir="ltr" data-xp-slot="value"></bdi></td>') + template('nettools-text', '<td data-xp-slot="value"></td>')
 return template('site-health-row', '<tr><td><bdi dir="ltr" data-xp-slot="domain"></bdi></td><td data-xp-slot="check"></td><td><span data-xp-slot="state"></span></td><td dir="auto" data-xp-slot="detail"></td><td data-xp-slot="actions"></td></tr>') + template('site-health-link', '<a class="xp-btn" data-xp-slot="label"></a>') + template('site-health-empty', '<tr><td colspan="5" data-xp-slot="message"></td></tr>')
}
