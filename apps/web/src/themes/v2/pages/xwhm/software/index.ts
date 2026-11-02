import type { WhmDataPageInput } from './common.ts'
import { WHM_DATA_COMMON_CSS } from './common.ts'
import { renderV2WhmSoftwareCenter, renderV2WhmStore } from './catalog.ts'
import { renderV2WhmAddonServices, renderV2WhmContainers } from './containers.ts'
import { renderV2WhmAppProjects, renderV2WhmComposer, renderV2WhmDeployments } from './projects.ts'
import { renderV2WhmUpdates } from './updates.ts'

export type { WhmDataPageInput, WhmDataAuthority } from './common.ts'
export const WHM_SOFTWARE_PAGES_CSS = WHM_DATA_COMMON_CSS
export const V2_WHM_SOFTWARE_ROUTES = Object.freeze(['/whm/software/runtimes', '/whm/software/catalog', '/whm/software/site-software', '/whm/software/modules', '/whm/software/addon-services', '/whm/software/containers', '/whm/software/containers/engine', '/whm/software/updates', '/whm/software/deployments', '/whm/software/application-projects', '/whm/software/composer', '/whm/software/store', '/whm/software/store/extensions', '/whm/software/store/activity'] as const)

export function renderV2WhmSoftwarePage(input: WhmDataPageInput): string | undefined {
  switch (input.activeRoute) {
    case '/whm/software/runtimes': return renderV2WhmSoftwareCenter(input, 'runtime')
    case '/whm/software/catalog': return renderV2WhmSoftwareCenter(input, 'catalog')
    case '/whm/software/modules': return renderV2WhmSoftwareCenter(input, 'module')
    case '/whm/software/addon-services': return renderV2WhmAddonServices(input)
    case '/whm/software/containers': return renderV2WhmContainers(input)
    case '/whm/software/containers/engine': return renderV2WhmContainers(input, true)
    case '/whm/software/updates': return renderV2WhmUpdates(input)
    case '/whm/software/deployments': return renderV2WhmDeployments(input)
    case '/whm/software/application-projects': return renderV2WhmAppProjects(input)
    case '/whm/software/composer': return renderV2WhmComposer(input)
    case '/whm/software/site-software':
    case '/whm/software/store':
    case '/whm/software/store/extensions':
    case '/whm/software/store/activity': return renderV2WhmStore(input, input.activeRoute)
    default: return undefined
  }
}
