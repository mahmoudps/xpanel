import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition, TweakValue } from './index.ts'

export const COOKIE_IP_MODES = ['disabled', 'loose', 'strict'] as const
export type CookieIpMode = (typeof COOKIE_IP_MODES)[number]

/** Tweak Settings of the Security section; each key has a real consumer. */
export const SECURITY_TWEAKS: readonly TweakDefinition[] = [
  // Read by session authentication (apps/api/src/auth.ts) against the address saved with the session.
  { key: 'security.cookieIpValidation', label: msgid('Session address validation'), help: msgid('Strict refuses a session cookie from any address other than the one that signed in. Loose accepts the same IPv4 /24 or IPv6 /64 network. Disabled does not compare addresses.'), consumer: '/whm/security/panel-access', kind: 'choice', default: 'strict', choices: COOKIE_IP_MODES },
  // Read by the API explorer (apps/api/src/developer-workspace.ts) for root and for account owners.
  { key: 'security.apiShell', label: msgid('API explorer'), help: msgid('Off refuses the API explorer for root and for every account owner.'), consumer: '/whm/panel/developer', kind: 'boolean', default: true },
  // Read by the webmail send route (apps/api/src/server.ts); Postfix rate limits stay the bound for other clients.
  { key: 'security.mailboxSendsPerHour', label: msgid('Webmail messages per hour'), help: msgid('Refuses a webmail send above this many messages per mailbox in one hour. Empty means no limit.'), consumer: '/whm/email/outbound', kind: 'integer', default: null, min: 1, max: 100000, nullable: true },
  // Read by the request pipeline (apps/api/src/server.ts): a browser sends Origin on these requests, so a missing one is not a browser form.
  { key: 'security.rejectBlankOrigin', label: msgid('Refuse changes without an Origin header'), help: msgid('Refuses a panel change made with a session cookie when the request carries no Origin header. Requests with a foreign Origin are always refused.'), consumer: '/whm/security/panel-access', kind: 'boolean', default: false },
]

export const cookieIpMode = (values: Readonly<Record<string, TweakValue>>): CookieIpMode => {
  const value = values['security.cookieIpValidation']
  return value === 'disabled' || value === 'loose' ? value : 'strict'
}
