import { renderV2WhmJobs } from './jobs.ts'
import { renderV2WhmAudit } from './audit.ts'
import { renderV2WhmSupport } from './support.ts'
import type { WhmObservationInput } from '../monitoring/common.ts'
export const WHM_ACTIVITY_ROUTES = Object.freeze(['/whm/jobs', '/whm/audit', '/whm/support'] as const)
export function renderV2WhmActivityPage(input: WhmObservationInput): string | undefined {
  switch (input.activeRoute) {
    case '/whm/jobs': return renderV2WhmJobs(input)
    case '/whm/audit': return renderV2WhmAudit(input)
    case '/whm/support': return renderV2WhmSupport(input)
    default: return undefined
  }
}
