import { projectReadOnlyMailSurface, projectReadOnlyPanelSurface, projectReadOnlyWhmSurface } from '../../../models/theme-surface.ts'
import { projectReadOnlyMailSurfaceView } from '../../../models/mail.ts'
import { v2Messages } from '../messages.ts'
import { parseMarkup } from '../../../html.ts'
import { renderV2MailInbox } from '../pages/xmail/inbox.ts'
import { renderV2MailCompose } from '../pages/xmail/compose.ts'
import { renderV2MailWorkspace } from '../pages/xmail/workspaces/index.ts'
import { renderV2PanelBody } from './xpanel.ts'
import { renderV2WhmBody } from './xwhm.ts'
import { V2_SECURITY_SLOT } from './slots.ts'
import type { V2ReadOnlyPage } from './unavailable.ts'

/** Native controllers cannot cross the stored-fact boundary; account security remains a separate core slot. */
function readOnlyBoundary(html: string, securityPage: boolean): string {
  const pieces = html.split(V2_SECURITY_SLOT)
  if (securityPage && pieces.length !== 2) throw new Error('v2_readonly_security_slot_missing_or_duplicated')
  if (!securityPage && pieces.length !== 1) throw new Error('v2_readonly_unexpected_security_slot')
  if (!securityPage) return `<div data-readonly="true" data-qualified="false">${html}</div>`
  // The body places its core security host between balanced native-only siblings.
  // Never split nested HTML here: a fragment wrapper can swallow the live host.
  const nodes = parseMarkup(html)
  const slots = nodes.filter(node => node.attrs.has('data-v2-account-security-slot'))
  if (slots.length !== 1) throw new Error('v2_readonly_security_slot_missing_or_duplicated')
  let parent = slots[0]!.parent
  while (parent >= 0) {
    const node = nodes[parent]!
    if (node.attrs.get('data-readonly') === 'true' || node.attrs.get('data-qualified') === 'false') throw new Error('v2_readonly_security_slot_blocked')
    parent = node.parent
  }
  return html
}

/** Each body receives the actual scoped projection and finite read-only authority. */
export const renderV2ReadOnlyPage: V2ReadOnlyPage = props => {
  if (!props.admitted) return undefined
  const facts = props.readOnlyFacts
  if (!facts) throw new Error(`v2_readonly_facts_missing:${props.surface}:${props.route}`)
  if (facts.surface !== props.surface) throw new Error(`v2_readonly_facts_realm_mismatch:${props.surface}`)
  const context = { locale: props.locale, theme: props.theme, density: props.density, activeRoute: props.route,
    visibility: props.visibility, catalog: props.catalog, branding: props.branding, themePackages: props.themePackages }
  let body: string | undefined
  if (facts.surface === 'xpanel') {
    const view = projectReadOnlyPanelSurface({ ...facts.panel, ...context })
    if (!view) throw new Error(`v2_readonly_authority_unavailable:xpanel:${props.route}`)
    body = renderV2PanelBody(view)
  } else if (facts.surface === 'xwhm') {
    const view = projectReadOnlyWhmSurface({ ...facts.whm, ...context })
    if (!view) throw new Error(`v2_readonly_authority_unavailable:xwhm:${props.route}`)
    body = renderV2WhmBody(view)
  } else {
    const scoped = projectReadOnlyMailSurface({ ...facts.mail, ...context })
    if (!scoped) throw new Error(`v2_readonly_authority_unavailable:xmail:${props.route}`)
    const view = projectReadOnlyMailSurfaceView(scoped.props, scoped.authority)
    if (!view) throw new Error(`v2_readonly_mail_presentation_unavailable:${props.route}`)
    const t = v2Messages.translator(props.locale)
    body = view.kind === 'inbox' ? renderV2MailInbox(t, view) : view.kind === 'compose' ? renderV2MailCompose(t, view)
      : renderV2MailWorkspace({ ...view, locale: props.locale, ...(props.securityPage ? { securityHtml: V2_SECURITY_SLOT } : {}) })
  }
  if (body === undefined) throw new Error(`v2_readonly_presentation_contract_missing:${props.surface}:${props.route}`)
  return readOnlyBoundary(body, props.securityPage)
}