export { renderV2WhmPlans } from './plans.ts'
export { renderV2PlanEditor } from './editor.ts'
export { renderV2WhmFeatures } from './features.ts'
export { renderV2WhmEnhancements } from './enhancements.ts'
export { WHM_PLANS_CSS, type WhmPlanAuthority } from './common.ts'

import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import type { WhmPlanAuthority } from './common.ts'
import { renderV2WhmPlans } from './plans.ts'
import { renderV2WhmFeatures } from './features.ts'
import { renderV2WhmEnhancements } from './enhancements.ts'

export function renderV2WhmPlanPage(t: Translate, props: WhmSurfaceProps, authority: WhmPlanAuthority): string | undefined {
  if (props.activeRoute === '/whm/plans') return renderV2WhmPlans(t, props, authority)
  if (props.activeRoute === '/whm/plans/features') return renderV2WhmFeatures(t, props, authority)
  if (props.activeRoute === '/whm/plans/enhancements') return renderV2WhmEnhancements(t, props, authority)
  return undefined
}
