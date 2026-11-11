import { v2PerlModulesCard } from './owner-tools.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { deniedOperationAuthority, operationContext, operationPage, type PanelOperationAuthority } from './common.ts'
import { pearPackagesCard } from '../../../../../models/tool-cards.ts'
import { renderV2ToolCard } from '../../../tool-card-view.ts'

/** PEAR and Perl modules; the shared client owns reads and every change. */
export function renderV2AccountPackagesPage(props: PanelSurfaceProps, authority: PanelOperationAuthority = deniedOperationAuthority): string {
  const { t, canManage, account } = operationContext(props, authority, '/software/packages')
  props = { ...props, account }
  return operationPage(props, '/software/packages', t(msgid('Packages & modules')), t(msgctxt('theme:v2', 'Install PEAR packages and Perl modules into your own account libraries.')),
    `<div class="v2-panel-operation-stack">${renderV2ToolCard(t, pearPackagesCard(account?.id ?? ''), canManage)}${v2PerlModulesCard(t)}</div>`, undefined, authority)
}
