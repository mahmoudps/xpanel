import { safePanelLinks } from './chrome.ts'
import type { NavigationContext } from './document-routes.ts'

/** A sibling mail listener receives UI preferences, never the source account or session. */
export function mailInboxHref(origin: string | undefined, context: Pick<NavigationContext, 'locale' | 'theme'>): string | undefined {
  if (!origin) return undefined
  const panel = safePanelLinks([{ surface: 'xmail', origin }])[0]
  if (!panel) return undefined
  const destination = new URL('/mail/inbox', panel.origin)
  destination.searchParams.set('lang', context.locale)
  destination.searchParams.set('theme', context.theme)
  return destination.href
}
