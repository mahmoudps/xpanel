/** Selected-theme markup for protected account file editors. */
export function htaccessClientTemplates(): string {
  return `<template data-xp-template="htaccess-php-row"><tr><td><bdi dir="ltr" class="xp-mono" data-xp-slot="directive"></bdi></td><td><bdi dir="ltr" class="xp-mono" data-xp-slot="value"></bdi></td><td data-xp-slot="compatibility"></td></tr></template>
<template data-xp-template="htaccess-empty-php"><tr><td colspan="3" data-xp-slot="message"></td></tr></template>
<template data-xp-template="htaccess-issue"><li data-xp-slot="message"></li></template>
<template data-xp-template="htaccess-version"><tr><td><bdi dir="ltr" class="xp-mono"><time data-xp-slot="time"></time></bdi></td><td data-xp-slot="actor"></td><td><bdi dir="ltr" class="xp-mono" data-xp-slot="size"></bdi></td><td data-xp-slot="state"></td><td><button type="button" class="xp-btn" data-xp-slot="restore" disabled></button></td></tr></template>
<template data-xp-template="htaccess-empty-versions"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>`
}
export function webDirectiveClientTemplates(): string {
  return `<template data-xp-template="web-directive-row"><tr><td data-xp-slot="actions"></td></tr></template>
<template data-xp-template="web-directive-text-cell"><td><span data-xp-slot="value"></span></td></template>
<template data-xp-template="web-directive-technical-cell"><td><bdi dir="ltr" class="xp-mono" data-xp-slot="value"></bdi></td></template>
<template data-xp-template="web-directive-action"><button type="button" class="xp-btn" data-xp-slot="label" disabled></button></template>
<template data-xp-template="web-directive-error"><tr><td class="xp-wd__error" data-xp-slot="message"></td></tr></template>
<template data-xp-template="web-directive-empty"><tr><td data-xp-slot="message"></td></tr></template>
<template data-xp-template="web-directive-summary"><tr><td data-xp-slot="label"></td><td><bdi data-xp-slot="value"></bdi></td></tr></template>
<template data-xp-template="web-directive-notice"><p data-xp-slot="message"></p></template>
<template data-xp-template="web-directive-issue"><li data-xp-slot="message"></li></template>`
}
