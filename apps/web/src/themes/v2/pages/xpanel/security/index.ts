import type { PanelSurfaceProps } from '../../../../contract.ts'
import { renderV2WebDirectivePage } from '../advanced/directives.ts'
import { NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'
import { renderV2AccountSecurityPage } from './account.ts'
import { renderV2CertificateFilesPage, renderV2CertificateIssuePage } from './certificates.ts'
import { renderV2AccountSshPage, renderV2AccountWafPage, renderV2VirusScannerPage } from './tools.ts'

export { renderV2AccountSecurityPage, renderV2CertificateFilesPage, renderV2CertificateIssuePage, renderV2AccountSshPage, renderV2AccountWafPage, renderV2VirusScannerPage }
export type { PanelSettingsAuthority } from '../settings/common.ts'
export { PANEL_SETTINGS_CSS as PANEL_SECURITY_CSS } from '../settings/common.ts'

export function renderV2PanelSecurityPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/security/account': return renderV2AccountSecurityPage(props, authority)
    case '/security/ssl/issue': return renderV2CertificateIssuePage(props, authority)
    case '/security/ssl/files': return renderV2CertificateFilesPage(props, authority)
    case '/security/waf': return renderV2AccountWafPage(props, authority)
    case '/security/ssh': return renderV2AccountSshPage(props, authority)
    case '/security/virus-scanner': return renderV2VirusScannerPage(props, authority)
    case '/security/ip-blocker': return renderV2WebDirectivePage(props, 'ip-blocker', authority)
    case '/security/hotlink': return renderV2WebDirectivePage(props, 'hotlink', authority)
    default: return undefined
  }
}
