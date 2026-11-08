import { type Locale, SOURCE_LOCALE, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Theme-owned rows; local selection never carries a native action flag. A phone shows each fact with its label. */
export function renderWhmServiceClientTemplates(kind: 'host' | 'manager', locale: Locale = SOURCE_LOCALE): string {
  const label = (message: string) => ` data-phone-label="${escapeHtml(translator(locale)(message))}"`
  // A role, version, uptime, memory size or load state names itself; the others need their label.
  const labels: Record<string, string> = { sub: msgid('Substate'), boot: msgid('Start at boot') }
  const cell = (slot: string) => `<td${labels[slot] ? label(labels[slot]) : ''}><bdi dir="ltr" data-xp-slot="${slot}"></bdi></td>`
  if (kind === 'host') return `<template data-xp-template="host-service-row"><tr><th scope="row"><button type="button" data-xp-action="select" aria-pressed="false"><span data-xp-slot="service"></span><bdi dir="ltr" data-xp-slot="unit"></bdi></button></th><td data-xp-slot="role"></td><td data-xp-slot="state"></td>${['version','uptime','memory'].map(cell).join('')}<td><div class="xp-service-workspace__actions"><button type="button" class="xp-btn" disabled><span data-xp-slot="reload-label"></span></button><button type="button" class="xp-btn" data-xp-action="restart" disabled><span data-xp-slot="restart-label"></span></button></div></td></tr></template><template data-xp-template="host-service-empty"><tr><td colspan="7" data-xp-slot="message"></td></tr></template>`
  return `<template data-xp-template="service-manager-row"><tr><td><button type="button" data-xp-action="select" aria-pressed="false"><bdi dir="ltr" data-xp-slot="unit"></bdi></button></td>${['load', 'active', 'sub', 'boot'].map(cell).join('')}<td><div class="xp-whm-service-manager__actions"><button type="button" class="xp-btn" data-xp-action="restart" disabled><span data-xp-slot="restart-label"></span></button><button type="button" class="xp-btn" data-xp-action="boot" disabled><span data-xp-slot="boot-label"></span></button><span data-xp-action="protected" data-xp-slot="protected-label"></span></div></td></tr></template><template data-xp-template="service-manager-empty"><tr><td colspan="6" data-xp-slot="message"></td></tr></template>`
}
