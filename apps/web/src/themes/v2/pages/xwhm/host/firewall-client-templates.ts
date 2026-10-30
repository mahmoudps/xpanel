/** V2 firewall records, actions and editors retain their own presentation after every readback. */
export function renderV2WhmFirewallClientTemplates(): string {
  const cell = (name: string) => ['action', 'comment', 'reason'].includes(name) ? `<td data-xp-slot="${name}"></td>` : `<td><bdi dir="ltr" data-xp-slot="${name}"></bdi></td>`
  const actions = '<td><div class="v2-host__actions" data-xp-action="actions"></div></td>'
  const rows = [['port', ['position', 'action', 'protocol', 'port', 'source', 'comment']], ['ip', ['action', 'source', 'port', 'comment', 'added', 'expires']], ['forward', ['protocol', 'port', 'destination', 'source', 'comment']], ['prefix', ['name', 'action', 'entries', 'port', 'file', 'updated']], ['ban', ['address', 'reason', 'source', 'since', 'expires']]] as const
  return rows.map(([kind, names]) => `<template data-xp-template="firewall-${kind}-row"><tr>${names.map(cell).join('')}${kind === 'prefix' ? '' : actions}</tr></template>`).join('')
    + '<template data-xp-template="firewall-empty"><tr><td colspan="1" data-xp-action="cell" data-xp-slot="message"></td></tr></template>'
    + '<template data-xp-template="firewall-action"><button type="button" class="v2-btn" data-xp-slot="label"></button></template>'
    + '<template data-xp-template="firewall-editor"><tr><td data-xp-action="cell"><form class="v2-host__groups" data-xp-action="form"><fieldset><legend data-xp-slot="title"></legend><div class="v2-host__fields" data-xp-action="fields"></div></fieldset><div class="v2-host__actions" data-xp-action="actions"></div></form></td></tr></template>'
    + '<template data-xp-template="firewall-edit-input"><div class="v2-host__field"><label data-xp-action="label" data-xp-slot="label"></label><input type="text" dir="ltr" data-xp-action="control"></div></template>'
    + '<template data-xp-template="firewall-edit-select"><div class="v2-host__field"><label data-xp-action="label" data-xp-slot="label"></label><select data-xp-action="control"></select></div></template>'
}
