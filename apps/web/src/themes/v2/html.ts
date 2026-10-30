// HTML helpers shared by the v2 kit. Text is always escaped; fields named `*Html` carry markup the caller
// built from this kit and are inserted as they are.

import { escapeHtml as escapeText } from '../../html.ts'

/** Escapes text for HTML element content and quoted attribute values; numbers are written as text. */
export const escapeHtml = (value: string | number): string => escapeText(String(value))

/** `data-*` hook attributes core controllers bind to. `true` renders a bare attribute; `false`/`undefined` none. */
export type HookAttributes = Readonly<Record<`data-${string}`, string | number | boolean | undefined>>

const HOOK_NAME = /^data-[a-z0-9]+(?:[-_.][a-z0-9]+)*$/

/** Renders hook attributes with a leading space. Names are validated so a hook can never inject markup. */
export function hookAttrs(hooks: HookAttributes | undefined): string {
  if (!hooks) return ''
  let out = ''
  for (const [name, value] of Object.entries(hooks)) {
    if (!HOOK_NAME.test(name)) throw new Error(`Invalid hook attribute name: ${name}`)
    if (value === undefined || value === false) continue
    out += value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`
  }
  return out
}

/** Optional attribute: ` name="value"` when value is set. */
export const attr = (name: string, value: string | number | undefined | null): string =>
  value === undefined || value === null || value === '' ? '' : ` ${name}="${escapeHtml(value)}"`

/** Visual tone shared by pills, notices, meters, KPI tiles and toasts. */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral'

const TEMPLATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A `<template data-xp-template=name>` core clones inside its workspace root. Its slots (`data-xp-slot`) take
 *  text only, its controls carry `data-xp-action` verbs and its state goes on the clone root (`data-state`,
 *  `data-kind`, `data-level`), so controllers never build or class-style markup themselves. */
export function xpTemplate(name: string, html: string): string {
  if (!TEMPLATE_NAME.test(name)) throw new Error(`Invalid template name: ${name}`)
  return `<template data-xp-template="${name}">${html}</template>`
}
