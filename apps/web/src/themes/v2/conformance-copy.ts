import { msgctxt } from '@xpanel/core'
import type { Locale } from '../../i18n.ts'
import { v2Messages } from './messages.ts'

/** Resolve theme-owned copy here; host conformance never receives catalog keys. */
export function v2ConformanceCopy(locale: Locale) {
  const t = v2Messages.translator(locale)
  return Object.freeze({
    locale: t.locale,
    localArchiveWorkflowNotice: t(msgctxt('theme:v2', 'Local archive actions require the guarded preview and confirmation workflow before they can be used here.')),
  })
}
