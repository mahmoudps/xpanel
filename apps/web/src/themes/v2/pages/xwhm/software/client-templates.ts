import { v2SoftwareOperationTemplates } from './operation-client-templates.ts'
/** V2 software inventory remains in named slots, independently of the core controller's data shape. */
export function v2SoftwareClientTemplates(route: string): string {
  const technical = new Set(['name', 'image', 'unit', 'ports', 'version', 'installed', 'candidate', 'origin', 'runtime', 'driver', 'cgroup', 'reference', 'tags', 'size', 'registry'])
  const row = (name: string, fields: readonly string[], controls = '') => `<template data-xp-template="${name}-row"><tr>${fields.map(key => `<td><${technical.has(key) ? 'bdi dir="ltr" class="v2-mono"' : 'span'} data-xp-slot="${key}"></${technical.has(key) ? 'bdi' : 'span'}></td>`).join('')}${controls ? `<td><div class="v2-whm-data__actions">${controls}</div></td>` : ''}</tr></template><template data-xp-template="${name}-empty"><tr><td colspan="${fields.length + (controls ? 1 : 0)}" data-xp-slot="message"></td></tr></template>`
  const actions = ['start', 'stop', 'restart'].map(action => `<button type="button" class="v2-btn" data-xp-action="${action}" disabled><span data-xp-slot="${action}-label"></span></button>`).join('')
  if (route === '/whm/software/addon-services') return row('software-addon', ['service', 'kind', 'package', 'unit', 'state', 'boot'], actions)
  if (route === '/whm/software/containers') return row('software-container', ['name', 'engine', 'image', 'state', 'status', 'ports'], actions)
  if (route === '/whm/software/application-projects') return row('software-project-runtime', ['name', 'state', 'version'])
  if (route === '/whm/software/updates') return `<template data-xp-template="software-update-row"><tr><td><input type="checkbox" data-xp-action="select" disabled></td>${['name', 'installed', 'candidate', 'origin', 'kind', 'state'].map(key => `<td><${technical.has(key) ? 'bdi dir="ltr" class="v2-mono"' : 'span'} data-xp-slot="${key}"></${technical.has(key) ? 'bdi' : 'span'}></td>`).join('')}</tr></template><template data-xp-template="software-update-empty"><tr><td colspan="7" data-xp-slot="message"></td></tr></template>`
  if (route === '/whm/software/containers/engine') return row('software-engine-facts', ['engine', 'runtime', 'driver', 'cgroup', 'rootless']) + row('software-engine-images', ['reference', 'tags', 'size', 'engine']) + row('software-engine-registries', ['registry', 'engine']) + row('software-engine-networks', ['name', 'driver', 'reference', 'engine']) + row('software-engine-volumes', ['name', 'driver', 'engine'])
  if (route === '/whm/software/deployments') return v2SoftwareOperationTemplates('deployments')
  if (route === '/whm/software/composer') return v2SoftwareOperationTemplates('composer')
  return ''
}
