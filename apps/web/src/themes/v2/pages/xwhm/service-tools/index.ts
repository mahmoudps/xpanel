import { WHM_DATA_COMMON_CSS, type WhmDataPageInput } from '../software/common.ts'
import { renderV2WhmConfigurationHealth, renderV2WhmDefaultIndex, renderV2WhmServiceDetail } from './details.ts'
import { renderV2WhmFtpLog } from './ftp-log.ts'
import { renderV2WhmWebServer } from './web.ts'

export const WHM_SERVICE_TOOLS_CSS = WHM_DATA_COMMON_CSS
export const V2_WHM_SERVICE_TOOL_ROUTES = Object.freeze(['/whm/services/web', '/whm/services/health', '/whm/services/ftp', '/whm/services/dns', '/whm/services/certificates', '/whm/services/ftp-log-analysis', '/whm/services/default-index'] as const)
export function renderV2WhmServiceToolPage(input: WhmDataPageInput): string | undefined {
  switch (input.activeRoute) {
    case '/whm/services/web': return renderV2WhmWebServer(input)
    case '/whm/services/health': return renderV2WhmConfigurationHealth(input)
    case '/whm/services/default-index': return renderV2WhmDefaultIndex(input)
    case '/whm/services/ftp-log-analysis': return renderV2WhmFtpLog(input)
    case '/whm/services/dns': return renderV2WhmServiceDetail(input, 'dns')
    case '/whm/services/ftp': return renderV2WhmServiceDetail(input, 'ftp')
    case '/whm/services/certificates': return renderV2WhmServiceDetail(input, 'certificates')
    default: return undefined
  }
}
