/** Theme-owned records for deployment, dependency and policy observations. */
export function v2SoftwareOperationTemplates(kind: 'deployments' | 'composer' | 'optimize'): string {
  const mono = 'v2-mono', button = 'v2-btn';
  const row = (name: string, fields: readonly string[], action = '') => `<template data-xp-template="${name}-row"><tr>${fields.map(key => `<td><bdi dir="${['subject','development','compression','cache'].includes(key)?'auto':'ltr'}" class="${['subject','development','compression','cache'].includes(key)?'':mono}" data-xp-slot="${key}"></bdi></td>`).join('')}${action?`<td><button type="button" class="${button}" data-xp-action="inspect" disabled><span data-xp-slot="inspect-label"></span></button></td>`:''}</tr></template><template data-xp-template="${name}-empty"><tr><td colspan="${fields.length+(action?1:0)}" data-xp-slot="message"></td></tr></template>`;
  if(kind==='deployments') return row('software-deployment-repository',['path'],'inspect')+row('software-deployment-commit',['hash','date','subject']);
  if(kind==='composer') return row('software-composer-package',['name','requirement','locked','installed','development'])+row('software-composer-review',['name','version','development']);
  return row('software-optimize-domain',['name','compression','cache'])+`<template data-xp-template="software-optimize-type"><bdi dir="ltr" class="${mono}" data-xp-slot="value"></bdi></template>`;
}
