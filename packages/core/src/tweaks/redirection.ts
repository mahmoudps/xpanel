import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition, TweakValue } from './index.ts'

/** Tweak Settings of the Redirection section; the panels answer only on their own public host, so that is the one target. */
export const REDIRECTION_TWEAKS: readonly TweakDefinition[] = [
  // The nginx edge (packages/render/src/edge/nginx.ts) adds the panel paths to each account site.
  { key: 'redirection.panelPaths', label: msgid('Redirect panel paths on hosted sites'), help: msgid('/whm, /xpanel and /webmail on an account site redirect to the HTTPS address of that panel. Off leaves these paths to the site.'),
    consumer: '/whm/security/panel-access', kind: 'boolean', default: true },
  // POST /api/auth/logout returns it to the signed-out browser.
  { key: 'redirection.logoutUrl', label: msgid('Address after sign-out'), help: msgid('An https address the browser opens after a sign-out. Empty returns to the sign-in page.'),
    consumer: '/whm/security/panel-access', kind: 'url', default: '' },
]

export interface RedirectionValues { panelPaths: boolean; logoutUrl: string | null }
/** The Redirection section of parsed Tweak Settings values (parseTweakValues). */
export const redirectionValues = (values: Readonly<Record<string, TweakValue>>): RedirectionValues => ({
  panelPaths: values['redirection.panelPaths'] !== false, logoutUrl: values['redirection.logoutUrl'] ? String(values['redirection.logoutUrl']) : null,
})
