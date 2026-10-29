import type { Locale } from '../i18n.ts'
import { renderWhmDeveloperWorkspace } from './whm-developer-workspace.ts'

/** Real own-token integration inspection; external connection cards keep their explicit unavailable states. */
export function renderWhmIntegrationWorkspace(input: { locale: Locale; canRead: boolean }): string {
  return renderWhmDeveloperWorkspace({ ...input, surface: 'integrations' })
}
