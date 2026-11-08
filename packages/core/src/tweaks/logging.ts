import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition } from './index.ts'

/** Tweak Settings of the Logging section; each key has a real consumer. */
export const LOGGING_TWEAKS: readonly TweakDefinition[] = [
  // Read by the request pipeline for API token requests; the path never carries a query string.
  { key: 'logging.apiCalls', label: msgid('Log API token calls'), help: msgid('Each request authenticated by an API token adds one line with the token owner, the method, the path and the address to the audit log. Query strings and bodies are not recorded.'), consumer: '/whm/audit', kind: 'boolean', default: false },
]
