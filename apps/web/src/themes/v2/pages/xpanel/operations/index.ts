import type { PanelSurfaceProps } from '../../../../contract.ts'
import { renderV2AccountBackupPage } from './backup.ts'
import { renderV2AccountFtpPage } from './ftp.ts'
import { renderV2AccountGitPage } from './git.ts'
import { renderV2AccountPackagesPage } from './packages.ts'
import { renderV2AccountRuntimePage } from './runtime.ts'
import { renderV2AccountTerminalPage } from './terminal.ts'
import { deniedOperationAuthority, type PanelOperationAuthority } from './common.ts'

export { renderV2AccountBackupPage, renderV2AccountFtpPage, renderV2AccountGitPage, renderV2AccountPackagesPage, renderV2AccountRuntimePage, renderV2AccountTerminalPage }
export { PANEL_OPERATIONS_CSS } from './styles.ts'
export type { PanelOperationAuthority } from './common.ts'

/** Only these actual workspace families are handled; core retains all other routes. */
export function renderV2PanelOperationsPage(props: PanelSurfaceProps, authority: PanelOperationAuthority = deniedOperationAuthority): string | undefined {
  switch (props.activeRoute) {
    case '/files/backup': return renderV2AccountBackupPage(props, authority)
    case '/files/ftp': return renderV2AccountFtpPage(props, authority)
    case '/files/git': return renderV2AccountGitPage(props, authority)
    case '/advanced/terminal': return renderV2AccountTerminalPage(props, authority)
    case '/software/apps': return renderV2AccountRuntimePage(props, 'apps', authority)
    case '/software/containers': return renderV2AccountRuntimePage(props, 'containers', authority)
    case '/software/cache': return renderV2AccountRuntimePage(props, 'cache', authority)
    case '/software/packages': return renderV2AccountPackagesPage(props, authority)
    default: return undefined
  }
}
