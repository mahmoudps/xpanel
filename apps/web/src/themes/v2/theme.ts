import { projectMailSurfaceView } from '../../models/mail.ts'
import { projectPanelSurface, projectWhmSurface } from '../../models/theme-surface.ts'
import type { ThemeSurface, ThemeViewProps, UiTheme } from '../contract.ts'
import { v2Assets } from './assets.ts'
import { renderV2Document } from './document.ts'
import { v2Messages } from './messages.ts'
import { renderV2Login } from './surfaces/login.ts'
import { renderV2ReadOnlyPage } from './surfaces/read-only.ts'
import { v2SharedSlots } from './surfaces/slots.ts'
import { renderV2Status } from './surfaces/status.ts'
import { createV2UnavailableRenderer } from './surfaces/unavailable.ts'
import { createV2MailSurface } from './surfaces/xmail.ts'
import { createV2PanelSurface } from './surfaces/xpanel.ts'
import { createV2WhmSurface } from './surfaces/xwhm.ts'

const renderUnavailable = createV2UnavailableRenderer(renderV2ReadOnlyPage)
function coreUnavailable(surface: ThemeSurface, props: ThemeViewProps & { readonly activeRoute?: string }): string {
  const descriptor = props.unavailableView
  if (!descriptor) throw new Error(`v2_core_unavailable_context_missing:${surface}`)
  const route = props.activeRoute === '/panel' ? '/home' : props.activeRoute === '/mail' ? '/mail/inbox' : props.activeRoute
  if (descriptor.surface !== surface || route !== undefined && descriptor.route !== route) throw new Error(`v2_core_unavailable_context_mismatch:${surface}`)
  return renderUnavailable(descriptor)
}

/** Complete composition; registration is a separate core decision after controller conformance. */
export const v2Theme: UiTheme = Object.freeze<UiTheme>({
  id: 'v2', assets: v2Assets, messages: v2Messages, renderDocument: renderV2Document,
  renderLogin: renderV2Login, renderStatus: renderV2Status, renderUnavailable,
  renderPanel: createV2PanelSurface(projectPanelSurface, props => coreUnavailable('xpanel', props)),
  renderWhm: createV2WhmSurface(projectWhmSurface, props => coreUnavailable('xwhm', props)),
  renderMail: createV2MailSurface(projectMailSurfaceView, props => coreUnavailable('xmail', props)),
  slots: v2SharedSlots,
})
