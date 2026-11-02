import type { WhmMailPageInput } from './common.ts'
import { renderV2WhmMailServer } from './server.ts'
import { renderV2WhmMailPolicy } from './policy.ts'
import { renderV2WhmMailLog } from './logs.ts'
import { renderV2WhmMailQueue, renderV2WhmMailQuality, renderV2WhmMailboxMaintenance } from './operations.ts'

export { WHM_MAIL_CSS, type WhmMailAuthority, type WhmMailPageInput } from './common.ts'
export { renderV2WhmMailServer } from './server.ts'
export { renderV2WhmMailPolicy } from './policy.ts'
export { renderV2WhmMailLog } from './logs.ts'
export { renderV2WhmMailQueue, renderV2WhmMailQuality, renderV2WhmMailboxMaintenance } from './operations.ts'

/** Exact implemented documents only; unrelated routes remain the integrator's responsibility. */
export const WHM_MAIL_ROUTES = [
  '/whm/email/monitor', '/whm/email/queue', '/whm/email/delivery', '/whm/email/outbound', '/whm/email/spam', '/whm/email/quality',
  '/whm/email/routing', '/whm/email/relay', '/whm/email/server', '/whm/email/maintenance', '/whm/email/bcc', '/whm/email/marketing',
] as const

export function renderV2WhmMailPage(input: WhmMailPageInput): string | undefined {
  switch (input.activeRoute) {
    case '/whm/email/server': return renderV2WhmMailServer(input, 'server')
    case '/whm/email/routing': return renderV2WhmMailServer(input, 'routing')
    case '/whm/email/outbound': return renderV2WhmMailServer(input, 'outbound')
    case '/whm/email/spam': return renderV2WhmMailPolicy(input, 'spam')
    case '/whm/email/relay': return renderV2WhmMailPolicy(input, 'relay')
    case '/whm/email/bcc': return renderV2WhmMailPolicy(input, 'bcc')
    case '/whm/email/marketing': return renderV2WhmMailPolicy(input, 'marketing')
    case '/whm/email/monitor': return renderV2WhmMailLog(input, 'monitor')
    case '/whm/email/delivery': return renderV2WhmMailLog(input, 'delivery')
    case '/whm/email/queue': return renderV2WhmMailQueue(input)
    case '/whm/email/quality': return renderV2WhmMailQuality(input)
    case '/whm/email/maintenance': return renderV2WhmMailboxMaintenance(input)
    default: return undefined
  }
}
