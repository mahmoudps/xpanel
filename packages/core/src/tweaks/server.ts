import { msgid } from '../i18n/translator.ts'
import type { TweakDefinition } from './index.ts'

/** Tweak Settings of the System and sign-in sections; each key has a real consumer. */
export const SERVER_TWEAKS: readonly TweakDefinition[] = [
  // cPanel's service monitor interval (60-7200 s), in whole minutes because the schedule runs per minute.
  { key: 'server.healthCheckMinutes', label: msgid('Server health check interval (minutes)'), help: msgid('How often the panel reads the server health checks and evaluates the alert rules.'),
    consumer: '/whm/monitoring/alerts', kind: 'integer', default: 5, min: 1, max: 120, nullable: false },
]
