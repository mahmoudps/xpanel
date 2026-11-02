/** Classic markup for rows refreshed by the account domain controllers. */
export function domainClientTemplates(t: (message: string) => string): string {
  return `<template data-xp-template="domain-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="name"></bdi></td><td data-xp-slot="kind"></td><td><bdi dir="ltr" class="xp-mono" data-xp-slot="root"></bdi></td><td><label class="xp-domain-check"><input type="checkbox" disabled data-xp-slot="wildcard"><span data-xp-slot="wildcard-label"></span></label></td><td data-domain-certificate="unverified" data-xp-slot="certificate"></td><td><bdi dir="ltr" data-xp-slot="php"></bdi></td><td><bdi dir="ltr" data-xp-slot="site"></bdi></td><td><button type="button" class="xp-btn" data-xp-slot="settings">${t('Settings')}</button><details><summary>${t('More')}</summary><button type="button" class="xp-btn" data-xp-slot="remove">${t('Remove saved domain')}</button></details><p data-xp-slot="removal-reason" hidden></p></td></tr></template>
<template data-xp-template="domain-empty"><tr><td colspan="8" data-xp-slot="message"></td></tr></template>
<template data-xp-template="domain-fact"><div class="xp-extension__fact"><dt data-xp-slot="label"></dt><dd><bdi dir="ltr" data-xp-slot="value"></bdi></dd></div></template>`
}

export function dynamicDnsClientTemplates(t: (message: string) => string): string {
  return `<template data-xp-template="ddns-row"><tr><td><bdi dir="ltr" data-xp-slot="hostname"></bdi></td><td><bdi dir="ltr" data-xp-slot="type"></bdi></td><td data-xp-slot="description"></td><td><bdi dir="ltr" data-xp-slot="updated"></bdi></td><td data-xp-slot="state"></td><td><button type="button" class="xp-btn" data-xp-slot="manage">${t('Manage')}</button></td></tr></template><template data-xp-template="ddns-empty"><tr><td colspan="6" data-xp-slot="message"></td></tr></template>`
}

export function stagingClientTemplates(): string {
  return `<template data-xp-template="staging-row"><tr><td><bdi dir="ltr" data-xp-slot="name"></bdi></td><td><bdi dir="ltr" data-xp-slot="path"></bdi></td><td data-xp-slot="state"></td><td><bdi dir="ltr" data-xp-slot="files"></bdi></td><td><time dir="ltr" data-xp-slot="created"></time></td><td><time dir="ltr" data-xp-slot="promoted"></time></td><td><div class="xp-account-staging__actions" data-xp-slot="actions"></div></td></tr></template>
<template data-xp-template="staging-action"><button type="button" class="xp-btn" data-xp-slot="label"></button></template>
<template data-xp-template="staging-review"><tr><td><bdi dir="ltr" data-xp-slot="path"></bdi></td><td data-xp-slot="change"></td><td><bdi dir="ltr" data-xp-slot="size"></bdi></td></tr></template>
<template data-xp-template="staging-result"><tr><td><bdi dir="ltr" data-xp-slot="path"></bdi></td><td data-xp-slot="change"></td><td data-xp-slot="result"></td></tr></template>
<template data-xp-template="staging-empty-list"><tr><td colspan="7" data-xp-slot="message"></td></tr></template><template data-xp-template="staging-empty-detail"><tr><td colspan="3" data-xp-slot="message"></td></tr></template>`
}

export function publisherClientTemplates(): string {
  return `<template data-xp-template="publisher-file"><tr><td><bdi dir="ltr" data-xp-slot="name"></bdi></td><td data-xp-slot="state"></td><td><bdi dir="ltr" data-xp-slot="size"></bdi></td></tr></template><template data-xp-template="publisher-empty"><tr><td colspan="3" data-xp-slot="message"></td></tr></template>`
}

export function reverseProxyClientTemplates(t: (message: string) => string): string {
  return `<template data-xp-template="proxy-row"><tr><td><bdi dir="ltr" class="xp-technical-token" data-xp-slot="name"></bdi></td><td data-xp-slot="kind"></td><td data-xp-slot="mode"></td><td><bdi dir="ltr" class="xp-technical-token" data-xp-slot="upstream"></bdi></td><td><button type="button" class="xp-btn" data-xp-slot="configure">${t('Configure')}</button><p class="xp-help" data-xp-slot="reason" hidden></p></td></tr></template>
<template data-xp-template="proxy-empty"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>
<template data-xp-template="proxy-header"><tr data-rp-header><td><input type="text" class="xp-input xp-mono" dir="ltr" maxlength="64" spellcheck="false" autocomplete="off" data-rp-header-field="name" data-xp-slot="name" aria-label="${t('Header name')}"></td><td><input type="text" class="xp-input xp-mono" dir="ltr" maxlength="256" spellcheck="false" autocomplete="off" data-rp-header-field="value" data-xp-slot="value" aria-label="${t('Header value')}"></td><td><button type="button" class="xp-btn" data-xp-slot="remove">${t('Remove')}</button></td></tr></template>`
}

export function redirectClientTemplates(): string {
  return `<template data-xp-template="redirect-row"><tr><td><bdi dir="ltr" data-xp-slot="status"></bdi></td><td><bdi dir="ltr" data-xp-slot="path"></bdi></td><td><bdi dir="ltr" data-xp-slot="target"></bdi></td><td data-xp-slot="actions"></td></tr></template><template data-xp-template="redirect-action"><button type="button" class="xp-btn" data-xp-slot="label"></button></template><template data-xp-template="redirect-empty"><tr><td colspan="4" data-xp-slot="message"></td></tr></template><template data-xp-template="redirect-error"><tr><td colspan="4" class="xp-wd__error" data-xp-slot="message"></td></tr></template>`
}
