import type { PanelEmailAuthority } from '../email-tools/common.ts'

export interface PanelObservationAuthority extends PanelEmailAuthority {
  /** The independently admitted account log capabilities; absence never enables a log read. */
  readonly logKinds?: readonly ('access' | 'error')[]
  /** Core's current catalog/role-filtered routes, used for links to related authorized workflows. */
  readonly relatedRoutes?: ReadonlySet<string>
  /** True only when core applies the selected owned domain before reading traffic. */
  readonly domainSelectionAvailable?: boolean
}
export { PANEL_ADDITIONAL_CSS as PANEL_OBSERVATIONS_CSS } from '../email-tools/common.ts'
