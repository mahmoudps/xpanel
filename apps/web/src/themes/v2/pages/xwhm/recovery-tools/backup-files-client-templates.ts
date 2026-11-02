/** Selected-theme presentation for verified backup-file controller data. */
export function backupFilesClientTemplates(): string {
  return `<template data-xp-template="backup-files-value"><bdi dir="ltr" class="v2-mono" data-xp-slot="value"></bdi></template>
<template data-xp-template="backup-files-option"><option data-xp-slot="label"></option></template>
<template data-xp-template="backup-files-empty4"><tr><td colspan="4" data-xp-slot="message"></td></tr></template>
<template data-xp-template="backup-files-empty5"><tr><td colspan="5" data-xp-slot="message"></td></tr></template>
<template data-xp-template="backup-files-archive"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="created"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="file"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="size"></bdi></td><td data-xp-slot="state"></td><td><button type="button" class="v2-btn" data-xp-action="open" data-xp-slot="label" disabled></button></td></tr></template>
<template data-xp-template="backup-files-entry"><tr><td><input type="checkbox" data-xp-action="select" disabled></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="name"></bdi></td><td data-xp-slot="type"></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="size"></bdi></td></tr></template>
<template data-xp-template="backup-files-folder"><tr><td><input type="checkbox" data-xp-action="select" disabled></td><td><button type="button" class="v2-btn" data-xp-action="open" disabled><bdi dir="ltr" class="v2-mono" data-xp-slot="name"></bdi></button></td><td data-xp-slot="type"></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="size"></bdi></td></tr></template>
<template data-xp-template="backup-files-review"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="path"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="destination"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="size"></bdi></td><td data-xp-slot="action"></td></tr></template>
<template data-xp-template="backup-files-result"><tr><td><bdi dir="ltr" class="v2-mono" data-xp-slot="path"></bdi></td><td><bdi dir="ltr" class="v2-mono" data-xp-slot="destination"></bdi></td><td data-xp-slot="result"></td><td data-xp-slot="reason"></td></tr></template>`
}
