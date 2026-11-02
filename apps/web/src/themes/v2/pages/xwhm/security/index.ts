import { renderV2WhmSecurityOverview, renderV2WhmSignIn } from './overview.ts'
import { renderV2WhmSsh } from './ssh.ts'
import { renderV2WhmSecurityPolicy } from './policies.ts'
import { renderV2WhmSecurityTool } from './tools.ts'
import type { WhmObservationInput } from '../monitoring/common.ts'
export const WHM_SECURITY_ROUTES = Object.freeze(['/whm/security', '/whm/security/intrusion', '/whm/security/flood', '/whm/security/waf', '/whm/security/isolation', '/whm/security/antivirus', '/whm/security/ssh', '/whm/security/panel-access', '/whm/security/sign-in'] as const)
export function renderV2WhmSecurityPage(input: WhmObservationInput): string | undefined {
  switch (input.activeRoute) {
    case '/whm/security': return renderV2WhmSecurityOverview(input)
    case '/whm/security/sign-in': return renderV2WhmSignIn(input)
    case '/whm/security/ssh': return renderV2WhmSsh(input)
    case '/whm/security/intrusion': return renderV2WhmSecurityTool(input, 'intrusion')
    case '/whm/security/isolation': return renderV2WhmSecurityTool(input, 'isolation')
    case '/whm/security/antivirus': return renderV2WhmSecurityTool(input, 'antivirus')
    case '/whm/security/waf': return renderV2WhmSecurityPolicy(input, 'waf')
    case '/whm/security/flood': return renderV2WhmSecurityPolicy(input, 'flood')
    case '/whm/security/panel-access': return renderV2WhmSecurityPolicy(input, 'panel-access')
    default: return undefined
  }
}
