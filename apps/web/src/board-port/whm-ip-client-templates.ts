/** Classic IP-pool records and actions cloned by the shared revision/readback controller. */
export function renderWhmIpClientTemplates(): string {
  const technical = (slot: string) => `<td class="xp-mono"><bdi dir="ltr" data-xp-slot="${slot}"></bdi></td>`
  const badge = (name: string, tone: string) => `<template data-xp-template="${name}"><span class="xp-badge xp-badge--${tone}" data-status="${tone}"><span class="xp-badge__label" data-xp-slot="label"></span></span></template>`
  return `<template data-xp-template="whm-ip-row"><tr>${technical('address')}${technical('version')}${technical('interface')}<td><span data-xp-action="role"></span></td>${technical('owner')}${technical('ptr')}<td><span data-xp-action="primary"></span></td><td><button type="button" class="xp-btn xp-btn--danger" data-xp-action="remove" disabled><span data-xp-slot="remove-label"></span></button></td></tr></template><template data-xp-template="whm-ip-empty"><tr><td colspan="8" data-xp-slot="message"></td></tr></template>${badge('whm-ip-role-web', 'ok')}${badge('whm-ip-role-mail', 'warn')}${badge('whm-ip-primary', 'ok')}${badge('whm-ip-secondary', 'suspended')}`
}
