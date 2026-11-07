type SecActionPage = 'account-waf' | 'account-cloudflare' | 'dns-providers' | 'dns-cluster' | 'identity-panel' | 'identity-whm'

/** Complete V2 action prototypes retain each owning page family's existing action layout. */
export function v2SecClientTemplates(page: SecActionPage): string {
  const group = page === 'account-waf' || page === 'identity-panel' ? 'v2-panel-settings__actions' : page === 'account-cloudflare' ? 'v2-domain-actions' : page === 'identity-whm' ? 'v2-observation__actions' : 'v2-whm-network__actions'
  return `<template data-xp-template="sec-action"><button type="button" class="v2-btn"><span data-xp-slot="label"></span></button></template>
    <template data-xp-template="sec-action-group"><div class="${group}" data-xp-slot="items"></div></template>`
}
