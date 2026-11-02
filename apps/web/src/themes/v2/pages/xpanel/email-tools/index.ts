import type { PanelSurfaceProps } from '../../../../contract.ts'
import type { PanelEmailAuthority } from './common.ts'
import { renderV2PanelMailingLists } from './mailing-lists.ts'
import { renderV2PanelEmailFilters } from './filters.ts'
import { renderV2PanelSpamFilters } from './spam.ts'
import { renderV2PanelQuarantine } from './quarantine.ts'
import { renderV2PanelEmailArchive, renderV2PanelDeliverability } from './archive-deliverability.ts'
import { renderV2PanelEmailEncryption } from './encryption.ts'
import { renderV2PanelCalendarsContacts } from './collaboration.ts'

export { renderV2PanelMailingLists, renderV2PanelEmailFilters, renderV2PanelSpamFilters, renderV2PanelQuarantine, renderV2PanelEmailArchive, renderV2PanelDeliverability, renderV2PanelEmailEncryption, renderV2PanelCalendarsContacts }
export { PANEL_ADDITIONAL_CSS } from './common.ts'
export type { PanelEmailAuthority } from './common.ts'
export const V2_PANEL_EMAIL_TOOL_ROUTES = Object.freeze(['/email/mailing-lists', '/email/filters', '/email/deliverability', '/email/spam-filters', '/email/spam-quarantine', '/email/archive', '/email/encryption', '/email/calendars-contacts'] as const)
export function renderV2PanelEmailTool(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string | undefined {
  switch (props.activeRoute) {
    case '/email/mailing-lists': return renderV2PanelMailingLists(props, authority)
    case '/email/filters': return renderV2PanelEmailFilters(props, authority)
    case '/email/deliverability': return renderV2PanelDeliverability(props, authority)
    case '/email/spam-filters': return renderV2PanelSpamFilters(props, authority)
    case '/email/spam-quarantine': return renderV2PanelQuarantine(props, authority)
    case '/email/archive': return renderV2PanelEmailArchive(props, authority)
    case '/email/encryption': return renderV2PanelEmailEncryption(props, authority)
    case '/email/calendars-contacts': return renderV2PanelCalendarsContacts(props, authority)
    default: return undefined
  }
}
