/** Theme-owned markup for bounded account diagnostic observations. */
export function networkDiagnosticClientTemplates(): string {
  return `<template data-xp-template="network-diagnostic-row"><tr></tr></template><template data-xp-template="network-diagnostic-header"><th scope="col" data-xp-slot="value"></th></template><template data-xp-template="network-diagnostic-cell"><td><span dir="auto" data-xp-slot="value"></span></td></template><template data-xp-template="network-diagnostic-technical-cell"><td><bdi dir="ltr" class="xp-mono" data-xp-slot="value"></bdi></td></template><template data-xp-template="network-diagnostic-instant"><bdi dir="ltr" class="xp-mono"></bdi></template>`
}
export function siteHealthClientTemplates(): string {
  return `<template data-xp-template="site-health-result"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="domain"></bdi></td><td data-xp-slot="kind"></td><td><span data-state-chip data-xp-slot="state"></span></td><td dir="auto" data-xp-slot="detail"></td><td data-xp-slot="fix"></td></tr></template><template data-xp-template="site-health-fix"><a class="xp-btn" aria-disabled="true" tabindex="-1" data-xp-slot="label"></a></template><template data-xp-template="site-health-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template><template data-xp-template="site-health-instant"><bdi dir="ltr" class="xp-mono"></bdi></template>`
}
