/** V2 owns every dynamic IP record, status pill, action and empty state. */
export function renderV2WhmIpClientTemplates(): string {
  const technical = (slot: string) => `<td><bdi class="v2-mono v2-num" dir="ltr" data-xp-slot="${slot}"></bdi></td>`
  const badge = (name: string, tone: string) => `<template data-xp-template="${name}"><span class="v2-pill v2-pill--${tone}"><span class="v2-pill__dot" aria-hidden="true"></span><span data-xp-slot="label"></span></span></template>`
  return `<template data-xp-template="whm-ip-row"><tr>${technical('address')}${technical('version')}${technical('interface')}<td><span data-xp-action="role"></span></td>${technical('owner')}${technical('ptr')}<td><span data-xp-action="primary"></span></td><td><button type="button" class="v2-btn v2-btn--danger" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></td></tr></template><template data-xp-template="whm-ip-empty"><tr><td colspan="8" data-xp-slot="message"></td></tr></template>${badge('whm-ip-role-web', 'ok')}${badge('whm-ip-role-mail', 'warn')}${badge('whm-ip-primary', 'ok')}${badge('whm-ip-secondary', 'neutral')}`
}
