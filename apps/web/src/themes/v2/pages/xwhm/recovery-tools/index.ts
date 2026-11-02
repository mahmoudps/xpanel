import type { WhmSurfaceProps } from '../../../../contract.ts'
import { NO_ACCOUNT_TOOL_AUTHORITY, type WhmAccountToolAuthority } from '../account-tools/common.ts'
import { renderV2WhmConvertAddonPage } from './convert.ts'
import { renderV2WhmRestoreComponentsPage, renderV2WhmRestoreFilesPage } from './restore.ts'

export { WHM_RECOVERY_TOOLS_CSS } from './common.ts'
export type { WhmAccountToolAuthority as WhmRecoveryToolAuthority } from '../account-tools/common.ts'
export { renderV2WhmConvertAddonPage } from './convert.ts'
export { renderV2WhmRestoreComponentsPage, renderV2WhmRestoreFilesPage } from './restore.ts'
export const V2_WHM_RECOVERY_TOOL_ROUTES = Object.freeze(['/whm/backups/restore-more', '/whm/backups/files', '/whm/transfers/convert-addon'] as const)
export function renderV2WhmRecoveryToolsPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority = NO_ACCOUNT_TOOL_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/whm/backups/restore-more': return renderV2WhmRestoreComponentsPage(props, authority)
    case '/whm/backups/files': return renderV2WhmRestoreFilesPage(props, authority)
    case '/whm/transfers/convert-addon': return renderV2WhmConvertAddonPage(props, authority)
    default: return undefined
  }
}
