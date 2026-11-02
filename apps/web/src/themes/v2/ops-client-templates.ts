/** V2 presentation for authenticated operations refreshes. */
export function v2OpsClientTemplates(family: 'shares' | 'nodes' | 'integrations'): string {
  const template = (name: string, body: string) => `<template data-xp-template="ops-${name}">${body}</template>`
  const value = (name: string, technical = false) => `<td><${technical ? 'bdi dir="ltr" class="v2-mono"' : 'span'} data-xp-slot="${name}"></${technical ? 'bdi' : 'span'}></td>`
  const button = (name: string) => `<button type="button" class="v2-btn" data-xp-action="${name}" disabled hidden><span data-xp-slot="${name}-label"></span></button>`
  const empty = (name: string, columns: number) => template(name + '-empty', `<tr><td colspan="${columns}" data-xp-slot="message"></td></tr>`)
  if (family === 'shares') return template('share-row', `<tr>${value('path', true)}${value('clients')}${value('state')}<td><div class="v2-admin-actions">${button('remove')}</div></td></tr>`) + empty('share', 4) + template('share-foreign', '<li><bdi dir="ltr" class="v2-mono" data-xp-slot="path"></bdi></li>')
  if (family === 'nodes') return template('node-row', `<tr>${value('label')}${value('hostname', true)}${value('role')}${value('enrollment')}<td><div class="v2-admin-actions">${button('verify')}${button('remove')}</div></td></tr>`) + empty('node', 5)
  return template('endpoint-row', `<tr>${value('url', true)}${value('events', true)}${value('secret')}${value('active')}<td><div class="v2-admin-actions">${button('test')}${button('remove')}</div></td></tr>`) + empty('endpoint', 5)
    + template('delivery-row', `<tr>${value('reference')}${value('event', true)}${value('state')}${value('attempts', true)}${value('status', true)}</tr>`) + empty('delivery', 5)
    + template('event', '<label class="v2-admin-check"><input type="checkbox" data-xp-action="select" disabled><bdi dir="ltr" class="v2-mono" data-xp-slot="event"></bdi></label>')
}
