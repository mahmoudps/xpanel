import { renderV2WhmProcesses, renderV2WhmDisk, renderV2WhmLogs, renderV2WhmPerformance } from './snapshots.ts'
import { renderV2WhmHealth, renderV2WhmLimits } from './health.ts'
import { renderV2WhmTraffic, renderV2WhmIo, renderV2WhmServerInfo } from './resources.ts'
import { renderV2WhmAlerts, renderV2WhmRepair, renderV2WhmBenchmark } from './workflows.ts'
import type { WhmObservationInput } from './common.ts'
export { WHM_OBSERVATION_CSS } from './common.ts'
export type { WhmObservationInput, ObservationAuthority } from './common.ts'
export const WHM_MONITORING_ROUTES = Object.freeze(['/whm/monitoring/health', '/whm/monitoring/alerts', '/whm/monitoring/repair', '/whm/monitoring/performance', '/whm/monitoring/traffic', '/whm/monitoring/io', '/whm/monitoring/limits', '/whm/monitoring/processes', '/whm/monitoring/disk', '/whm/monitoring/logs', '/whm/monitoring/server-info', '/whm/monitoring/benchmark'] as const)
export function renderV2WhmMonitoringPage(input: WhmObservationInput): string | undefined {
  switch (input.activeRoute) {
    case '/whm/monitoring/health': return renderV2WhmHealth(input)
    case '/whm/monitoring/alerts': return renderV2WhmAlerts(input)
    case '/whm/monitoring/repair': return renderV2WhmRepair(input)
    case '/whm/monitoring/performance': return renderV2WhmPerformance(input)
    case '/whm/monitoring/traffic': return renderV2WhmTraffic(input)
    case '/whm/monitoring/io': return renderV2WhmIo(input)
    case '/whm/monitoring/limits': return renderV2WhmLimits(input)
    case '/whm/monitoring/processes': return renderV2WhmProcesses(input)
    case '/whm/monitoring/disk': return renderV2WhmDisk(input)
    case '/whm/monitoring/logs': return renderV2WhmLogs(input)
    case '/whm/monitoring/server-info': return renderV2WhmServerInfo(input)
    case '/whm/monitoring/benchmark': return renderV2WhmBenchmark(input)
    default: return undefined
  }
}
