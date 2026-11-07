import { defaultServerWebSettings, validateServerWebSettings } from '@xpanel/core'
import type { ServerSettings, ServerWebSettings } from '@xpanel/core'

/** Saved web directives, validated again where they become configuration lines; the defaults while none are saved. */
export const assertWebDirectives = (s: ServerSettings): ServerWebSettings =>
  s.web === undefined ? defaultServerWebSettings() : validateServerWebSettings(s.web)

/** Root's Include Editor text at one insertion point, marked so the generated file shows where it starts. */
export const includeLines = (label: string, text: string): string[] =>
  text.trim() === '' ? [] : [`# Include Editor: ${label}`, ...text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n'), '']
